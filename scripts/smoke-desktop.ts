import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PipeClient, defaultConnectionFile } from '../src/automation/client';
import { RpcError } from '../src/automation/protocol';
import type { AppState, PortInfo, ProjectFile } from '../src/shared/contracts';

interface Check {
  name: string;
  passed: true;
}

/** Live integration only: never probes, builds, installs, opens serial or flashes a device. */
export async function smokeDesktop(connectionFile = defaultConnectionFile()): Promise<void> {
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const checks: Check[] = [];
  const passed = (name: string): void => {
    checks.push({ name, passed: true });
  };
  const client = new PipeClient(connectionFile);
  const state = (await client.request('state.get')) as AppState;
  assert.ok(state.projectRoot && state.config && Array.isArray(state.files));
  assert.ok(state.pipe.endpoint && state.pipe.tokenFile);
  passed('running Electron CoreApi state through authenticated named pipe');
  const ports = (await client.request('ports.list')) as PortInfo[];
  assert.ok(Array.isArray(ports));
  for (const port of ports) assert.equal(typeof port.path, 'string');
  passed('actual host port enumeration without opening devices');
  await assert.rejects(
    client.request('unknown.method'),
    (error: unknown) => error instanceof RpcError && error.code === -32601,
  );
  await assert.rejects(
    client.request('file.write', { path: 'unused.h', content: '', unknown: true }),
    (error: unknown) => error instanceof RpcError && error.code === -32602,
  );
  await assert.rejects(
    client.request('flash.run', { confirm: false }),
    (error: unknown) => error instanceof RpcError && error.code === -32602,
  );
  await assert.rejects(
    client.request('config.set', { config: { version: 1 } }),
    (error: unknown) => error instanceof RpcError && error.code === -32602,
  );
  passed('real route method, schema and explicit-confirmation rejection before side effects');
  await assert.rejects(
    client.request('file.write', { path: '../blode_protocol_smoke.h', content: '' }),
    (error: unknown) =>
      error instanceof RpcError &&
      error.code === -32000 &&
      (error.data as { reason?: string })?.reason === 'error.invalidPath',
  );
  passed('core path traversal error mapped through JSON-RPC');

  const realRoot = await fs.realpath(state.projectRoot);
  const hardwareExample = path.join(repository, 'examples', 'blink');
  assert.notEqual(
    realRoot.toLowerCase(),
    hardwareExample.toLowerCase(),
    'Use a separate UI project while the hardware example is building',
  );
  const filename = `blode_protocol_smoke_${randomUUID().replaceAll('-', '')}.h`;
  const fullPath = path.resolve(realRoot, filename);
  assert.equal(path.dirname(fullPath), realRoot);
  const content = `#pragma once\n// Blode integration smoke: ${filename}\n`;
  let created = false;
  try {
    await assert.rejects(
      fs.lstat(fullPath),
      (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT',
    );
    await client.request('file.write', { path: filename, content });
    created = true;
    const file = (await client.request('project.readFile', { path: filename })) as ProjectFile;
    assert.equal(file.path, filename);
    assert.equal(file.content, content);
    assert.equal(await fs.readFile(fullPath, 'utf8'), content);
    passed('unique source file write/read through the app and verified on disk');
  } finally {
    if (created) {
      // Delete only the exact file we created; refuse if the parent or content changed.
      assert.equal(await fs.realpath(path.dirname(fullPath)), realRoot);
      const stat = await fs.lstat(fullPath);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(await fs.readFile(fullPath, 'utf8'), content);
      await fs.unlink(fullPath);
      await assert.rejects(fs.access(fullPath));
    }
  }
  passed('temporary source file removed after verified ownership and path checks');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repository, 'dist', 'mcp-bridge.mjs'), '--connection', connectionFile],
    cwd: repository,
    env: { ...getDefaultEnvironment(), BLODE_LANG: 'en-US' },
    stderr: 'pipe',
    maxBufferSize: 8 * 1024 * 1024,
  });
  const mcp = new Client({ name: 'blode-desktop-smoke', version: '0.1.0' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-4096);
  });
  try {
    await mcp.connect(transport);
    const tools = await mcp.listTools();
    assert.equal(tools.tools.length, 13);
    assert.ok(tools.tools.some((tool) => tool.name === 'blode_state_get'));
    assert.ok(tools.tools.find((tool) => tool.name === 'blode_flash_run')?.annotations?.destructiveHint);
    passed('built MCP stdio bridge launched as a real Node child; initialization and tools/list');
    const result = await mcp.callTool({ name: 'blode_state_get', arguments: {} });
    assert.notEqual(result.isError, true, diagnostics || 'MCP state failed');
    const blocks = result.content as Array<{ type: string; text?: string }>;
    const text = blocks.find((block) => block.type === 'text')?.text;
    assert.ok(text);
    const mcpState = JSON.parse(text) as AppState;
    assert.equal(mcpState.projectRoot, state.projectRoot);
    assert.equal(mcpState.config.boardId, state.config.boardId);
    assert.ok(!mcpState.files.some((file) => file.path === filename));
    passed('MCP tools/call to the running app returns active state without leftover smoke files');
  } finally {
    await mcp.close();
    await transport.close();
  }

  const timestamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date());
  const report = `# AI 管道与 MCP 实际应用验证\n\n时间：${timestamp}（Asia/Shanghai）。\n\n命令：\`npx tsx scripts/smoke-desktop.ts\`。目标是运行中的 Blode Studio 桌面应用，并非 mock CoreApi。\n\n工程：\`${state.projectRoot}\`。板卡配置：\`${state.config.boardId}\`。实际枚举到的端口：${ports.map((port) => `\`${port.path}\``).join('、') || '无'}。\n\n${checks.map((check) => `- 通过：${check.name}`).join('\n')}\n\n验证未调用芯片识别、编译、下载工具链、串口连接或烧录。临时头文件使用随机唯一名称，写入后核对实际路径与内容再删除。token 未写入报告或日志。\n\n范围：本记录覆盖真实命名管道 → 核心服务，以及 SDK MCP stdio 客户端 → 构建后桥接子进程 → 命名管道 → 同一核心服务。它不代替前端交互、Electron preload/IPC 或实机固件运行验证；这些由界面与硬件验证记录单独说明。\n`;
  await fs.writeFile(path.join(repository, 'docs', 'AI-INTEGRATION-VALIDATION.md'), report, 'utf8');
  process.stdout.write(
    `${JSON.stringify({ passed: checks.length, ports: ports.map((port) => port.path), board: state.config.boardId, report: 'docs/AI-INTEGRATION-VALIDATION.md' })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argument = process.argv.indexOf('--connection');
  const connection = argument >= 0 ? process.argv[argument + 1] : undefined;
  if (argument >= 0 && !connection) throw new Error('rpc.missingConnectionArgument');
  smokeDesktop(connection).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'smoke.failed'}\n`);
    process.exitCode = 1;
  });
}
