import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HostTerminal } from '../src/core/terminal';
import { terminalShell } from '../src/core/terminal-shell';
import { releasePty } from '../src/core/pty-cleanup';
import type { IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function completed(terminal: HostTerminal, poll = 40) {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    await delay(poll);
    const state = terminal.state();
    if (!state.running) return state;
  }
  throw new Error(
    'The interactive command did not return to its prompt. ' + JSON.stringify(terminal.state()),
  );
}

function isolatedPowerShell(root: string, systemPowerShell = false) {
  return (session: string) => {
    const shell = terminalShell(session);
    const script = Buffer.from(shell.args.at(-1)!, 'base64').toString('utf16le');
    const history = path.join(root, 'test-history.txt').replaceAll("'", "''");
    return {
      ...shell,
      ...(systemPowerShell
        ? {
            executable: path.join(
              process.env.SystemRoot || 'C:\\Windows',
              'System32/WindowsPowerShell/v1.0/powershell.exe',
            ),
          }
        : {}),
      args: [
        ...shell.args.slice(0, -1),
        Buffer.from(
          `${script}\nSet-PSReadLineOption -HistorySavePath '${history}' -HistorySaveStyle SaveNothing`,
          'utf16le',
        ).toString('base64'),
      ],
    };
  };
}

for (const systemPowerShell of [false, true])
  test(
    `interactive Windows ${systemPowerShell ? 'system PowerShell' : 'preferred PowerShell'} retains state and handles UTF-8, resize and interrupt`,
    { skip: process.platform !== 'win32', timeout: 25000 },
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-pty-'));
      const nested = path.join(root, '中文目录');
      await fs.mkdir(nested);
      const terminal = new HostTerminal({
        projectRoot: () => root,
        emit: () => {},
        shell: isolatedPowerShell(root, systemPowerShell),
      });
      try {
        assert.equal(terminal.state().active, false, 'reading state must not execute a shell');
        const [opened, concurrent] = await Promise.all([
          terminal.open({ cols: 90, rows: 25 }),
          terminal.open({ cols: 90, rows: 25 }),
        ]);
        assert.equal(concurrent.sessionId, opened.sessionId, 'simultaneous viewers share one process');
        assert.equal(opened.active, true);
        assert.ok(opened.sessionId);
        await terminal.run(
          `$global:BlodePtyTest = '中文会话'; Set-Location -LiteralPath '${nested.replaceAll("'", "''")}'`,
        );
        let state = await completed(terminal);
        assert.equal(state.cwd, nested);
        assert.equal(state.active, true);
        const sequence = state.sequence!;
        await terminal.run('Write-Output $BlodePtyTest');
        state = await completed(terminal);
        assert.ok(
          state.lines.includes('中文会话'),
          JSON.stringify({ lines: state.lines, chunks: state.chunks }),
        );
        assert.equal(state.exitCode, 0);
        const delta = terminal.state({ sessionId: opened.sessionId, after: sequence });
        assert.equal(delta.reset, false);
        assert.ok(delta.chunks!.every((chunk) => chunk.sequence > sequence));
        for (let iteration = 0; iteration < 12; iteration++) {
          // Same-directory silent commands exercise ConPTY's prompt/blank compression.
          for (let silent = 0; silent < 2; silent++) {
            await terminal.run(`$null = ${iteration}`);
            state = await completed(terminal, 1);
            assert.equal(state.exitCode, 0);
          }
          await terminal.run(`Write-Output 'ordered-${iteration}'`);
          state = await completed(terminal, 1);
          assert.ok(
            state.lines.includes(`ordered-${iteration}`),
            'idle must follow the rendered output: ' + JSON.stringify(state),
          );
        }
        for (let cancelled = 0; cancelled < 3; cancelled++) {
          terminal.write({ data: 'Start-Sleep -Seconds 20\r', sessionId: opened.sessionId });
          terminal.write({ data: '\x03', sessionId: opened.sessionId });
          state = await completed(terminal, 1);
          assert.equal(state.active, true, 'an immediate cancellation must return to the live shell');
          await terminal.run(`Write-Output 'cancelled-${cancelled}'`);
          state = await completed(terminal, 1);
          assert.ok(state.lines.includes(`cancelled-${cancelled}`));
        }
        await terminal.run('Read-Host -Prompt \'PTY_INPUT\' | ForEach-Object { Write-Output "answer=$_" }');
        for (let attempt = 0; attempt < 80; attempt++) {
          if (
            terminal
              .state()
              .chunks!.map((chunk) => chunk.data)
              .join('')
              .includes('PTY_INPUT:')
          )
            break;
          await delay(40);
        }
        assert.equal(terminal.state().running, true, 'an input prompt remains a running command');
        terminal.write({ data: '交互应答\r', sessionId: opened.sessionId });
        state = await completed(terminal);
        assert.ok(state.lines.includes('answer=交互应答'), 'Read-Host receives live Chinese input');
        terminal.resize({ cols: 120, rows: 32, sessionId: opened.sessionId });
        assert.equal(terminal.state().cols, 120);
        assert.equal(terminal.state().rows, 32);
        assert.throws(() => terminal.resize({ cols: 0, rows: 32 }), /invalidParams/);
        assert.throws(() => terminal.write({ data: 'bad', sessionId: 'stale' }), /SessionChanged/);
        await terminal.run('Start-Sleep -Seconds 20');
        await delay(120);
        assert.equal(terminal.state().running, true);
        terminal.stop();
        state = await completed(terminal);
        assert.equal(state.active, true, 'Ctrl+C keeps the interactive shell');
        await terminal.run('Write-Output "中断后继续"');
        state = await completed(terminal);
        assert.ok(state.lines.includes('中断后继续'));
        await terminal.close();
        assert.equal(terminal.state().active, false);
        assert.throws(() => terminal.write({ data: 'stale' }), /terminalClosed/);
      } finally {
        await terminal.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

test('terminal replays reset only for a new or expired cursor and validates input without starting a shell', () => {
  const terminal = new HostTerminal({ projectRoot: () => '', emit: () => {} });
  assert.equal(terminal.state({ sessionId: 'previous', after: 200 }).reset, true);
  assert.throws(() => terminal.write({ data: '\0' }), /invalidParams/);
  assert.throws(() => terminal.resize({ cols: 0, rows: 0 }), /invalidParams/);
  assert.equal(terminal.state().active, false);
});

test('closing during initialization cancels an unopened terminal instead of leaking a process', async () => {
  const terminal = new HostTerminal({ projectRoot: () => '', emit: () => {} });
  const opening = terminal.open();
  const rejected = assert.rejects(opening, /terminalClosed/);
  await terminal.close();
  await rejected;
  assert.equal(terminal.state().active, false);
});

test('POSIX fallback quotes the complete prompt assignment, including its embedded printf strings', () => {
  const { initialize } = terminalShell('test-session', 'linux', {});
  assert.ok(initialize.startsWith('PS1='));
  assert.ok(initialize.endsWith('; '));
  const word = initialize.slice(4, -2);
  assert.match(word, /^'(?:[^']|'\\'')*'$/, 'PS1 must be one shell-quoted value');
  const value = word.slice(1, -1).replaceAll("'\\''", "'");
  assert.ok(value.startsWith('$( __blode_exit=$?; printf '));
  assert.ok(value.includes("'\\033]777;BL0DE;test-session;%s;%s\\007'"));
  assert.ok(value.endsWith(' )$ '));
});

for (const failOn of ['interrupt', 'exit'] as const)
  test(
    `a native write failure during ${failOn} still releases the owned PTY`,
    { skip: process.platform !== 'win32', timeout: 10000 },
    async () => {
      const terminal = new HostTerminal({
        projectRoot: () => os.tmpdir(),
        emit: () => {},
        shell: isolatedPowerShell(path.join(os.tmpdir(), `blode-pty-${randomUUID()}`)),
      });
      await terminal.open();
      const pty = (terminal as unknown as { pty: IPty }).pty;
      const originalWrite = pty.write.bind(pty);
      const originalKill = pty.kill.bind(pty);
      let released = false;
      pty.kill = () => {
        released = true;
        originalKill();
      };
      pty.write = (data) => {
        if (data === (failOn === 'interrupt' ? '\x03' : 'exit\r')) throw new Error('native-write-closed');
        originalWrite(data);
      };
      try {
        await terminal.close();
        assert.equal(released, true, 'closing must release native handles even if writing fails');
        assert.equal(terminal.state().active, false);
      } finally {
        releasePty(pty);
        await terminal.close();
      }
    },
  );
