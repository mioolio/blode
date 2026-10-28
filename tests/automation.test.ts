import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CoreApi, AppState, LogEvent } from '../src/shared/contracts';
import { startPipeServer } from '../src/automation/server';
import { PipeClient } from '../src/automation/client';
import { RpcError, MAX_FRAME_BYTES, type RpcResponse } from '../src/automation/protocol';
import { dispatch, EventBuffer, routeSchemas } from '../src/automation/routes';
import { createMcpServer } from '../src/automation/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

function fakeApi(): {
  api: CoreApi;
  writes: string[];
  probes: { port?: string; config?: unknown }[];
  flashes: () => number;
  builds: () => number;
} {
  const writes: string[] = [];
  const probes: { port?: string; config?: unknown }[] = [];
  let flashCount = 0;
  let buildCount = 0;
  const state: AppState = {
    projectRoot: '/project',
    workspaceOpen: true,
    build: {},
    config: {
      version: 1,
      name: 'test',
      boardId: 'esp32-s3',
      port: 'COM3',
      baudRate: 115200,
      flashSize: 8 * 1024 * 1024,
      partitions: [],
      toolchain: {
        mode: 'managed',
        arduinoCli: '',
        python: '',
        additionalUrls: [],
        fqbn: 'esp32:esp32:esp32s3',
      },
    },
    files: [{ path: 'src/main.ino', content: 'void setup() {}', language: 'cpp' }],
    inventory: { entries: [], totalBytes: 0, fileCount: 0, directoryCount: 0, truncated: false },
    buildStale: false,
    boards: [],
    ports: [{ path: 'COM3' }],
    debugProbes: [],
    detection: { candidates: [], unavailablePlatforms: [] },
    lastBuild: null,
    toolchain: { arduinoCli: false, esp32Core: false, python: true, esptool: true, versions: {} },
    drivers: [],
    pipe: { endpoint: '', tokenFile: '' },
    web: { endpoint: '', tokenFile: '', allowExternal: false },
  };
  return {
    writes,
    probes,
    flashes: () => flashCount,
    builds: () => buildCount,
    api: {
      getState: async () => state,
      listPorts: async () => state.ports,
      listDebugProbes: async () => state.debugProbes,
      scanDevices: async () => state.detection,
      saveFile: async (file) => {
        writes.push(file);
      },
      createFile: async () => {},
      createDirectory: async () => {},
      renameEntry: async () => {},
      deleteEntry: async () => {},
      saveConfig: async () => {},
      setBuildEntry: async (entry) => {
        state.build = { ...state.build, entry };
        state.buildStale = true;
      },
      build: async () => {
        buildCount++;
        return {
          success: true,
          flashUsed: 1024,
          flashTotal: 8 * 1024 * 1024,
          ramUsed: 128,
          ramTotal: 512 * 1024,
          artifacts: ['firmware.bin'],
          timestamp: new Date().toISOString(),
          output: 'ok',
        };
      },
      flash: async () => {
        flashCount++;
      },
      probe: async (port, config) => {
        probes.push({ port, config });
        return 'ESP32-S3';
      },
      installToolchain: async () => state.toolchain,
      serialOpen: async () => {},
      serialClose: async () => {},
      serialWrite: async () => {},
    },
  };
}

async function rawRequest(endpoint: string, frames: string[]): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = '';
    socket.setTimeout(5000);
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('test.timeout'));
    });
    socket.once('connect', () => {
      for (const frame of frames) socket.write(frame);
    });
    socket.on('data', (data) => {
      buffer += data.toString();
      if (!buffer.includes('\n')) return;
      socket.destroy();
      resolve(JSON.parse(buffer.split('\n')[0]) as RpcResponse);
    });
  });
}

test('device.probe forwards an optional config before a workspace exists', async () => {
  const fake = fakeApi();
  const config = { ...(await fake.api.getState()).config, boardId: 'stm32' };
  await dispatch(fake.api, new EventBuffer(), 'device.probe', { port: 'COM3', config });
  assert.deepEqual(fake.probes, [{ port: 'COM3', config }]);
});

test('real named pipe validates auth, framing, route schemas, explicit flash confirmation and cleanup', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'blode-pipe-test-'));
  const fake = fakeApi();
  const server = await startPipeServer({ api: fake.api, dataRoot: temporary });
  const client = new PipeClient(server.connectionFile);
  const token = (await readFile(server.tokenFile, 'utf8')).trim();
  const request = (method: string, params: Record<string, unknown> = {}, auth = token) =>
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params, auth })}\n`;
  try {
    await t.test('actual socket round trip and fragmented UTF-8 frames', async () => {
      assert.deepEqual(await client.request('ports.list'), [{ path: 'COM3' }]);
      assert.deepEqual(await client.request('probes.list'), []);
      const frame = request('file.write', { path: 'src/中文.ino', content: '// 中文' });
      const response = await rawRequest(server.endpoint, [frame.slice(0, 9), frame.slice(9)]);
      assert.ok('result' in response);
      assert.deepEqual(fake.writes, ['src/中文.ino']);
    });
    await t.test('wrong credentials cannot invoke a mutating route', async () => {
      const response = await rawRequest(server.endpoint, [
        request('flash.run', { confirm: true }, '0'.repeat(64)),
      ]);
      assert.ok('error' in response);
      assert.equal(response.error.code, -32001);
      assert.equal(fake.flashes(), 0);
      const entry = await rawRequest(server.endpoint, [
        request('build.entry.set', { path: '.' }, '0'.repeat(64)),
      ]);
      assert.ok('error' in entry);
      assert.equal(entry.error.code, -32001);
      assert.equal((await fake.api.getState()).build.entry, undefined);
    });
    await t.test('malformed JSON, unknown methods and invalid params are standard RPC errors', async () => {
      const malformed = await rawRequest(server.endpoint, ['{broken}\n']);
      assert.ok('error' in malformed);
      assert.equal(malformed.error.code, -32700);
      await assert.rejects(
        client.request('constructor'),
        (error: unknown) => error instanceof RpcError && error.code === -32601,
      );
      await assert.rejects(
        client.request('file.write', { path: 'x.ino', content: '', extra: true }),
        (error: unknown) => error instanceof RpcError && error.code === -32602,
      );
      await assert.rejects(
        client.request('config.set', { config: { version: 1 } }),
        (error: unknown) => error instanceof RpcError && error.code === -32602,
      );
    });
    await t.test('flash and install require explicit true confirmation', async () => {
      await assert.rejects(
        client.request('flash.run'),
        (error: unknown) => error instanceof RpcError && error.code === -32602,
      );
      await assert.rejects(
        client.request('flash.run', { confirm: false }),
        (error: unknown) => error instanceof RpcError && error.code === -32602,
      );
      await assert.rejects(
        client.request('toolchain.install'),
        (error: unknown) => error instanceof RpcError && error.code === -32602,
      );
      assert.equal(fake.flashes(), 0);
      await client.request('flash.run', { confirm: true });
      assert.equal(fake.flashes(), 1);
    });
    await t.test('read API rejects traversal and files absent from current project', async () => {
      const file = await client.request('project.readFile', { path: 'src/main.ino' });
      assert.deepEqual(file, { path: 'src/main.ino', content: 'void setup() {}', language: 'cpp' });
      await assert.rejects(client.request('project.readFile', { path: '../token' }));
      await assert.rejects(client.request('project.readFile', { path: 'C:\\Users\\token' }));
      await assert.rejects(client.request('project.readFile', { path: '.secret' }));
    });
    await t.test('build entry is an explicit configuration change and does not start a build', async () => {
      for (const params of [{}, { path: '' }, { path: 42 }, { path: 'src/main.c', extra: true }]) {
        await assert.rejects(
          client.request('build.entry.set', params),
          (error: unknown) => error instanceof RpcError && error.code === -32602,
        );
      }
      for (const entry of ['src/main.c', 'src', '.']) {
        await client.request('build.entry.set', { path: entry });
        assert.equal(((await client.request('state.get')) as AppState).build.entry, entry);
      }
      assert.equal(fake.builds(), 0);
      assert.equal((await fake.api.getState()).buildStale, true);
    });
    await t.test('serial and build events are readable through a bounded cursor', async () => {
      server.publish({ kind: 'serial', level: 'info', message: 'hello', time: '2026-01-01T00:00:00Z' });
      const output = (await client.request('events.poll')) as {
        cursor: number;
        events: unknown[];
        dropped: boolean;
      };
      assert.equal(output.cursor, 1);
      assert.equal(output.events.length, 1);
      const next = (await client.request('events.poll', { after: output.cursor })) as { events: unknown[] };
      assert.deepEqual(next.events, []);
    });
    await t.test('oversized requests are rejected before writing to a pipe', async () => {
      await assert.rejects(
        client.request('file.write', { path: 'large.ino', content: 'x'.repeat(MAX_FRAME_BYTES) }),
        (error: unknown) => error instanceof RpcError && error.code === -32005,
      );
    });
    await t.test('a second instance cannot rotate the active credential', async () => {
      await assert.rejects(startPipeServer({ api: fake.api, dataRoot: temporary }));
      assert.equal((await readFile(server.tokenFile, 'utf8')).trim(), token);
      assert.deepEqual(await client.request('ports.list'), [{ path: 'COM3' }]);
    });
    await t.test('MCP tool list and calls reach the same pipe implementation', async () => {
      const mcp = createMcpServer(client, 'en-US');
      const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcp.connect(serverTransport);
      await mcpClient.connect(clientTransport);
      try {
        const tools = await mcpClient.listTools();
        assert.equal(tools.tools.length, Object.keys(routeSchemas).length);
        assert.ok(tools.tools.find((tool) => tool.name === 'blode_flash_run')?.annotations?.destructiveHint);
        const entryTool = tools.tools.find((tool) => tool.name === 'blode_build_entry_set');
        assert.equal(entryTool?.annotations?.readOnlyHint, false);
        assert.equal(entryTool?.annotations?.destructiveHint, true);
        assert.equal(entryTool?.annotations?.idempotentHint, true);
        const entry = await mcpClient.callTool({
          name: 'blode_build_entry_set',
          arguments: { path: 'src/main.c' },
        });
        assert.equal(entry.isError, undefined);
        assert.equal((await fake.api.getState()).build.entry, 'src/main.c');
        assert.equal(fake.builds(), 0);
        const ports = await mcpClient.callTool({ name: 'blode_ports_list', arguments: {} });
        assert.equal(ports.isError, undefined);
        assert.ok(JSON.stringify(ports.content).includes('COM3'));
        const flash = await mcpClient.callTool({ name: 'blode_flash_run', arguments: {} });
        assert.equal(flash.isError, true);
      } finally {
        await mcpClient.close();
        await mcp.close();
      }
    });
  } finally {
    await server.close();
    await assert.rejects(access(server.tokenFile));
    await assert.rejects(access(server.connectionFile));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('event ring bounds retained data and reports dropped history', () => {
  const events = new EventBuffer();
  const event: LogEvent = { kind: 'log', level: 'info', message: 'x'.repeat(9000), time: '' };
  for (let index = 0; index < 300; index++) events.publish(event);
  const output = events.poll(1);
  assert.equal(output.cursor, 300);
  assert.equal(output.events.length, 256);
  assert.equal(output.dropped, true);
  assert.equal(output.events[0].event.message.length, 8192);
  assert.equal(events.poll(999).dropped, true);
});

test(
  'Windows credentials can be renamed and removed without parent DeleteChild permission',
  {
    skip: process.platform !== 'win32',
  },
  async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'blode-credential-test-'));
    const directory = path.join(temporary, 'automation');
    await mkdir(directory);
    const run = promisify(execFile);
    const systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const { stdout } = await run(path.join(systemDirectory, 'whoami.exe'), [], { windowsHide: true });
    const account = stdout.trim();
    const icacls = path.join(systemDirectory, 'icacls.exe');
    let server: Awaited<ReturnType<typeof startPipeServer>> | undefined;
    try {
      // Reproduce folders where a file must grant DELETE itself; the directory
      // cannot provide the alternative DeleteChild permission for rename/unlink.
      await run(icacls, [directory, '/deny', `${account}:(DC)`], { windowsHide: true });
      let previousToken = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        server = await startPipeServer({ api: fakeApi().api, dataRoot: temporary });
        const token = (await readFile(server.tokenFile, 'utf8')).trim();
        assert.match(token, /^[a-f0-9]{64}$/);
        assert.notEqual(token, previousToken);
        assert.deepEqual((await readdir(directory)).sort(), ['connection.json', 'token']);
        assert.deepEqual(await new PipeClient(server.connectionFile).request('ports.list'), [
          { path: 'COM3' },
        ]);
        await server.close();
        server = undefined;
        assert.deepEqual(await readdir(directory), []);
        previousToken = token;
      }
    } finally {
      await server?.close();
      await run(icacls, [directory, '/remove:d', account], { windowsHide: true });
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
