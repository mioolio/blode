import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostTerminals } from '../src/core/terminal-sessions';
import { terminalShell } from '../src/core/terminal-shell';
import type { LogEvent } from '../src/shared/contracts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function completed(manager: HostTerminals, terminalId: string) {
  for (let attempt = 0; attempt < 160; attempt++) {
    await delay(30);
    const state = manager.state({ terminalId });
    if (!state.running) return state;
  }
  throw Error('Terminal command did not finish: ' + terminalId);
}
function isolated(root: string) {
  return (id: string) => {
    const shell = terminalShell(id);
    const script = Buffer.from(shell.args.at(-1)!, 'base64').toString('utf16le');
    const history = path.join(root, 'history-' + id + '.txt').replaceAll("'", "''");
    return {
      ...shell,
      args: [
        ...shell.args.slice(0, -1),
        Buffer.from(
          script + `\nSet-PSReadLineOption -HistorySavePath '${history}' -HistorySaveStyle SaveNothing`,
          'utf16le',
        ).toString('base64'),
      ],
    };
  };
}

test(
  'named terminal sessions isolate variables, directories, output, resize, interrupt and shutdown',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-terminals-'));
    const nested = path.join(root, '中文目录');
    await fs.mkdir(nested);
    const events: LogEvent[] = [];
    const manager = new HostTerminals({
      projectRoot: () => root,
      emit: (event) => events.push(event),
      shell: isolated(root),
    });
    try {
      assert.equal(manager.state().active, false);
      const [first, second] = await Promise.all([
        manager.open({ terminalId: 'first', name: '终端 A' }),
        manager.open({ terminalId: 'second', name: '终端 B' }),
      ]);
      assert.notEqual(first.sessionId, second.sessionId);
      assert.equal(manager.sessions().filter((session) => session.active).length, 2);
      await manager.run({
        terminalId: 'first',
        command: `$global:SharedName='甲'; Set-Location -LiteralPath '${nested.replaceAll("'", "''")}'`,
      });
      await completed(manager, 'first');
      await manager.run({
        terminalId: 'second',
        command: "$global:SharedName='乙'; Write-Output $SharedName",
      });
      const b = await completed(manager, 'second');
      assert.equal(b.cwd, root);
      assert.ok(b.lines.includes('乙'));
      assert.ok(!b.lines.includes('甲'));
      await manager.run({ terminalId: 'first', command: 'Write-Output $SharedName' });
      const a = await completed(manager, 'first');
      assert.equal(a.cwd, nested);
      assert.ok(a.lines.includes('甲'));
      assert.ok(!a.lines.includes('乙'));
      manager.resize({ terminalId: 'second', sessionId: second.sessionId, cols: 123, rows: 31 });
      assert.equal(manager.state({ terminalId: 'second' }).cols, 123);
      assert.equal(manager.state({ terminalId: 'first' }).cols, 100);
      await manager.run({ terminalId: 'second', command: 'Start-Sleep -Seconds 20' });
      await delay(120);
      manager.stop({ terminalId: 'second', sessionId: second.sessionId });
      assert.equal((await completed(manager, 'second')).active, true);
      await manager.run({
        terminalId: 'first',
        command: "Write-Output ('PID_A=' + $PID); Start-Sleep -Seconds 20",
      });
      let pid = 0;
      for (let attempt = 0; attempt < 100; attempt++) {
        const marker = manager.state({ terminalId: 'first' }).lines.find((line) => /^PID_A=\d+$/.test(line));
        if (marker) {
          pid = Number(marker.slice(6));
          break;
        }
        await delay(30);
      }
      assert.ok(pid > 0);
      await manager.close({ terminalId: 'first', sessionId: first.sessionId });
      assert.throws(() => process.kill(pid, 0), 'closing a busy session releases its actual shell process');
      assert.ok(!manager.sessions().some((session) => session.terminalId === 'first'));
      assert.throws(() => manager.state({ terminalId: 'first' }), /terminalClosed/);
      assert.equal(manager.state({ terminalId: 'second' }).active, true);
      assert.throws(
        () => manager.write({ terminalId: 'first', sessionId: first.sessionId, data: 'bad' }),
        /terminalClosed/,
      );
      const reopened = await manager.open({ terminalId: 'first' });
      assert.notEqual(reopened.sessionId, first.sessionId);
      assert.throws(
        () => manager.write({ terminalId: 'first', sessionId: first.sessionId, data: 'bad' }),
        /SessionChanged/,
      );
      await assert.rejects(
        manager.close({ terminalId: 'first', sessionId: first.sessionId }),
        /SessionChanged/,
      );
      assert.equal(manager.state({ terminalId: 'first' }).active, true);
      await manager.run({ terminalId: 'second', command: 'Write-Output $SharedName' });
      assert.ok((await completed(manager, 'second')).lines.includes('乙'));
      assert.ok(events.some((event) => event.terminalId === 'first'));
      assert.ok(events.some((event) => event.terminalId === 'second'));
      await manager.close();
      assert.equal(
        manager.state({ terminalId: 'second' }).active,
        true,
        'closing default never closes another terminal',
      );
    } finally {
      await manager.closeAll();
      await fs.rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(manager.sessions(), []);
  },
);

test('closing all sessions during initialization cancels each pending PTY creation', async () => {
  const manager = new HostTerminals({ projectRoot: () => '', emit: () => {} });
  const first = manager.open({ create: true });
  const second = manager.open({ create: true });
  const rejected = Promise.all([
    assert.rejects(first, /terminalClosed/),
    assert.rejects(second, /terminalClosed/),
  ]);
  await manager.closeAll();
  await rejected;
  assert.deepEqual(manager.sessions(), []);
});

test('terminal state remains read-only and names are validated before starting a process', async () => {
  const manager = new HostTerminals({ projectRoot: () => '', emit: () => {} });
  assert.equal(manager.sessions().length, 0);
  assert.equal(manager.state().active, false);
  assert.equal(manager.sessions().length, 0);
  await assert.rejects(manager.open({ terminalId: '../invalid' }), /invalidParams/);
  await assert.rejects(manager.open({ terminalId: 'ok', name: 'bad\nname' }), /invalidParams/);
  await assert.rejects(manager.run({ terminalId: 'build', command: '' }), /invalidParams/);
  assert.ok(manager.sessions().every((session) => !session.active));
  await manager.closeAll();
});
