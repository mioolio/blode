import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { HardwareDebugger } from '../src/core/hardware-debugger';
import { getDebuggerProfile } from '../src/shared/debugger-profiles';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: TestContext, running = true) {
  const debug = new HardwareDebugger('.', '.') as HardwareDebugger & Record<string, any>;
  const state = (debug as any).snapshot;
  Object.assign(state, {
    connection: running ? 'running' : 'stopped',
    breakpoints: [{ id: '1', location: 'main' }],
  });
  (debug as any).profile = getDebuggerProfile('Esp32_S3_CAM', { transport: 'uart-gdb' });
  (debug as any).gdb = { stdin: { end() {} } };
  (debug as any).uartPort = 'COM3';
  let closed = 0;
  (debug as any).uartBridge = {
    port: 0,
    close: async () => {
      closed++;
    },
  };
  const commands: string[] = [];
  let event = '*stopped,reason="signal-received",signal-name="SIGINT"';
  let handler: ((command: string) => Promise<void>) | undefined;
  t.mock.method(debug as any, 'command', async (command: string) => {
    commands.push(command);
    await handler?.(command);
    if (command === '-exec-interrupt --all') (debug as any).consume(event);
    return {};
  });
  return {
    debug,
    state,
    commands,
    closed: () => closed,
    event: (value: string) => {
      event = value;
    },
    handler: (value: typeof handler) => {
      handler = value;
    },
  };
}

test('UART disconnect clears owned breakpoints while retaining an already paused target', async (t) => {
  const f = fixture(t, false);
  await f.debug.disconnect();
  assert.deepEqual(f.commands, ['-break-delete', '-target-disconnect']);
  assert.equal(f.closed(), 1);
  assert.equal(f.debug.ownedSerialPort, undefined);
});

test('UART disconnect interrupts a running target to remove breakpoints and restores only its own SIGINT stop', async (t) => {
  const f = fixture(t);
  await f.debug.disconnect();
  assert.deepEqual(f.commands, [
    '-exec-interrupt --all',
    '-break-delete',
    '-exec-continue',
    '-target-disconnect',
  ]);
  assert.equal(f.closed(), 1);
});

test('UART disconnect preserves a breakpoint that wins the interrupt race instead of resuming it', async (t) => {
  const f = fixture(t);
  f.event('*stopped,reason="breakpoint-hit",bkptno="1"');
  await f.debug.disconnect();
  assert.deepEqual(f.commands, ['-exec-interrupt --all', '-break-delete', '-target-disconnect']);
});

test('UART disconnect never resumes after failed breakpoint cleanup and still releases serial ownership', async (t) => {
  const f = fixture(t);
  f.handler(async (command) => {
    if (command === '-break-delete') throw new Error('stub rejected removal');
  });
  await f.debug.disconnect();
  assert.deepEqual(f.commands, ['-exec-interrupt --all', '-break-delete']);
  assert.equal(f.closed(), 1);
  assert.equal(f.debug.ownedSerialPort, undefined);
  assert.ok(f.state.log.some((line: string) => line.includes('stub rejected removal')));
});

test('another user can request pause during UART disconnect cleanup without it being resumed', async (t) => {
  const f = fixture(t),
    entered = deferred(),
    finish = deferred();
  f.handler(async (command) => {
    if (command === '-break-delete') {
      entered.resolve();
      await finish.promise;
    }
  });
  const closing = f.debug.disconnect();
  await entered.promise;
  await f.debug.action('pause');
  finish.resolve();
  await closing;
  assert.equal(f.commands.includes('-exec-continue'), false);
  assert.equal(f.closed(), 1);
});

test('UART disconnect observes an in-flight continue acknowledgement before deciding to interrupt', async (t) => {
  const f = fixture(t, false),
    entered = deferred(),
    finish = deferred();
  let continued = false;
  f.handler(async (command) => {
    if (command === '-exec-continue' && !continued) {
      continued = true;
      entered.resolve();
      await finish.promise;
    }
  });
  const running = f.debug.action('continue');
  await entered.promise;
  const closing = f.debug.disconnect();
  finish.resolve();
  await Promise.all([running, closing]);
  assert.deepEqual(f.commands, [
    '-exec-continue',
    '-exec-interrupt --all',
    '-break-delete',
    '-exec-continue',
    '-target-disconnect',
  ]);
  assert.equal(f.closed(), 1);
});

test('UART disconnect also clears GDB temporary breakpoints absent from the UI list', async (t) => {
  const f = fixture(t);
  f.state.breakpoints = [];
  await f.debug.disconnect();
  assert.deepEqual(f.commands, [
    '-exec-interrupt --all',
    '-break-delete',
    '-exec-continue',
    '-target-disconnect',
  ]);
});

test('a late MI error after the same token reports running cannot leave a false running state', async () => {
  const debug = new HardwareDebugger('.', '.');
  const internal = debug as any;
  internal.snapshot.connection = 'stopped';
  internal.gdb = {
    stdin: {
      write(line: string) {
        const token = /^\d+/.exec(line)![0];
        queueMicrotask(() => {
          internal.consume(token + '^running');
          internal.consume(
            token + '^error,msg="Protocol error: QThreadEvents conflicting enabled responses."',
          );
        });
      },
      end() {},
    },
  };
  await assert.rejects(debug.action('step'), /QThreadEvents conflicting/);
  assert.equal(internal.snapshot.connection, 'error');
  assert.match(internal.snapshot.message, /QThreadEvents conflicting/);
  assert.equal(internal.gdb, null);
  assert.equal(internal.executionTokens.size, 0);
});
