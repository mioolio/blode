import test from 'node:test';
import assert from 'node:assert/strict';
import { HardwareDebugger } from '../src/core/hardware-debugger';
import { createWebDebugger } from '../src/core/web-debugger';
import { workbenchRouteSchemas } from '../src/automation/workbench-routes';
import type { DebuggerPatchRequest } from '../src/shared/debugger-edit';
import type { CoreService } from '../src/core/service';

const request: DebuggerPatchRequest = {
  sessionId: 'test-session',
  address: 0x20000000,
  expected: '00bf',
  bytes: '0120',
  pauseAndResume: false,
  confirm: true,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(running = false) {
  const debug = new HardwareDebugger('.', '.');
  const owner = debug as any;
  owner.snapshot.connection = running ? 'running' : 'stopped';
  owner.snapshot.sessionId = request.sessionId;
  owner.snapshot.instructions = [{ address: '0x20000000', instruction: 'nop', opcodes: '00 bf' }];
  let memory = '00bf',
    id = 0;
  const commands: string[] = [];
  let intercept: ((command: string, reply: (data?: string, error?: string) => void) => boolean) | undefined;
  owner.gdb = {
    stdin: {
      end() {},
      write(line: string) {
        const match = /^(\d+)(.*)\n$/.exec(line)!;
        const command = match[2];
        commands.push(command);
        const reply = (data = '', error?: string) =>
          owner.consume(
            `${match[1]}^${error ? `error,msg=${JSON.stringify(error)}` : `done${data ? ',' + data : ''}`}`,
          );
        queueMicrotask(() => {
          if (intercept?.(command, reply)) return;
          if (command.startsWith('-data-read-memory-bytes'))
            reply(
              `memory=[{begin="0x20000000",end="0x${(0x20000000 + memory.length / 2).toString(16)}",contents="${memory}"}]`,
            );
          else if (command.startsWith('-data-write-memory-bytes')) {
            memory = command.split(' ').at(-1)!;
            reply();
          } else if (command.startsWith('-break-insert')) {
            if (command.includes('missing')) reply('', 'No symbol missing');
            else reply(`bkpt={number="${++id}"}`);
          } else if (command === '-data-list-register-names') reply('register-names=["pc"]');
          else if (command === '-data-list-register-values x')
            reply('register-values=[{number="0",value="0x20000000"}]');
          else if (command.startsWith('-data-disassemble'))
            reply(`asm_insns=[{address="0x20000000",inst="movs r0, #1",opcodes="${memory}"}]`);
          else if (command === '-stack-list-frames 0 24') reply('stack=[]');
          else if (command === '-exec-continue') {
            owner.consume('*running,thread-id="all"');
            reply();
          } else reply();
        });
      },
    },
  };
  return {
    debug,
    owner,
    commands,
    intercept: (handler: typeof intercept) => {
      intercept = handler;
    },
    setMemory: (value: string) => {
      memory = value;
    },
    stop: (reason = 'signal-received', signal = 'SIGINT') =>
      owner.consume(`12*stopped,reason="${reason}",signal-name="${signal}"`),
  };
}

test('paused instruction patch compares bytes, writes and reads back before updating disassembly', async () => {
  const { debug, owner, commands } = fixture();
  const result = await debug.patch(request);
  assert.deepEqual(result, { address: request.address, before: '00bf', after: '0120', resumed: false });
  assert.deepEqual(commands.slice(0, 3), [
    '-data-read-memory-bytes 0x20000000 2',
    '-data-write-memory-bytes 0x20000000 0120',
    '-data-read-memory-bytes 0x20000000 2',
  ]);
  assert.equal(commands.includes('-exec-continue'), false);
  assert.equal(owner.snapshot.instructions[0].opcodes, '0120');
});

test('live patch waits for actual asynchronous SIGINT stop, not interrupt acknowledgement', async () => {
  const context = fixture(true);
  const pending = context.debug.patch({ ...request, pauseAndResume: true });
  await tick();
  assert.deepEqual(context.commands, ['-exec-interrupt --all']);
  assert.equal(context.owner.snapshot.connection, 'running');
  context.stop();
  const result = await pending;
  assert.equal(result.resumed, true);
  assert.equal(context.commands.at(-1), '-exec-continue');
});

test('breakpoint winning the interrupt race cancels patch and leaves target paused', async () => {
  const context = fixture(true);
  const pending = context.debug.patch({ ...request, pauseAndResume: true });
  await tick();
  context.stop('breakpoint-hit', 'SIGTRAP');
  await assert.rejects(pending, /debuggerPatchInterrupted/);
  assert.deepEqual(context.commands, ['-exec-interrupt --all']);
  assert.equal(context.owner.snapshot.connection, 'stopped');
});

test('another client requesting pause during patch suppresses automatic resume', async () => {
  const context = fixture(true);
  const pending = context.debug.patch({ ...request, pauseAndResume: true });
  await tick();
  await context.debug.action('pause');
  context.stop();
  assert.equal((await pending).resumed, false);
  assert.equal(context.commands.includes('-exec-continue'), false);
});

test('resume acknowledgement cannot leave a running target editable or silently swallow a late pause', async () => {
  const context = fixture(true);
  let finishResume: (() => void) | undefined;
  context.intercept((command, reply) => {
    if (command !== '-exec-continue') return false;
    finishResume = () => reply();
    return true;
  });
  const pending = context.debug.patch({ ...request, pauseAndResume: true });
  await tick();
  context.stop();
  await tick();
  assert.ok(finishResume);
  await assert.rejects(context.debug.action('pause'), /debuggerBusy/);
  finishResume();
  assert.equal((await pending).resumed, true);
  assert.equal(context.owner.snapshot.connection, 'running');
  await assert.rejects(
    context.debug.patch({ ...request, expected: '0120', bytes: '00bf' }),
    /debuggerPatchPauseRequired/,
  );
});

test('a breakpoint stop during resume is preserved instead of being overwritten as running', async () => {
  const context = fixture(true);
  context.intercept((command, reply) => {
    if (command !== '-exec-continue') return false;
    context.stop('breakpoint-hit', 'SIGTRAP');
    reply();
    return true;
  });
  const pending = context.debug.patch({ ...request, pauseAndResume: true });
  await tick();
  context.stop();
  assert.equal((await pending).resumed, false);
  assert.equal(context.owner.snapshot.connection, 'stopped');
});

test('expected-byte conflicts, write failures and verification errors never resume a running target', async () => {
  for (const failure of ['changed', 'write', 'verify']) {
    const context = fixture(true);
    if (failure === 'changed') context.setMemory('0220');
    if (failure !== 'changed')
      context.intercept((command, reply) => {
        if (!command.startsWith('-data-write-memory-bytes')) return false;
        if (failure === 'write') reply('', 'device write failed');
        else {
          context.setMemory('0220');
          reply();
        }
        return true;
      });
    const pending = context.debug.patch({ ...request, pauseAndResume: true });
    await tick();
    context.stop();
    await assert.rejects(
      pending,
      failure === 'changed'
        ? /debuggerPatchChanged/
        : failure === 'write'
          ? /device write failed/
          : /debuggerPatchVerify/,
    );
    assert.equal(context.commands.includes('-exec-continue'), false);
    assert.equal(context.owner.snapshot.connection, 'stopped');
    if (failure === 'changed')
      assert.equal(
        context.commands.some((c) => c.startsWith('-data-write')),
        false,
      );
  }
});

test('concurrent writes and execution are rejected while a patch is waiting for a stop', async () => {
  const context = fixture(true);
  const pending = context.debug.patch({ ...request, pauseAndResume: true });
  await tick();
  await assert.rejects(context.debug.patch({ ...request, pauseAndResume: true }), /debuggerBusy/);
  await assert.rejects(context.debug.action('continue'), /debuggerBusy/);
  await assert.rejects(context.debug.breakpoints(['main']), /debuggerBusy/);
  await context.debug.disconnect();
  await assert.rejects(pending, /debuggerDisconnected/);
  assert.equal(
    context.commands.some((c) => c.startsWith('-data-write')),
    false,
  );
});

test('disconnect between memory read and write invalidates the old session', async () => {
  const context = fixture();
  let replyRead: ((data: string) => void) | undefined;
  context.intercept((command, reply) => {
    if (!command.startsWith('-data-read')) return false;
    replyRead = reply;
    return true;
  });
  const pending = context.debug.patch(request);
  await tick();
  await context.debug.disconnect();
  replyRead!('memory=[{begin="0x20000000",end="0x20000002",contents="00bf"}]');
  await assert.rejects(pending, /debuggerDisconnected|debuggerSessionChanged/);
  assert.equal(
    context.commands.some((c) => c.startsWith('-data-write')),
    false,
  );
});

test('batch breakpoints preserve successful entries, deduplicate locations and report individual failures', async () => {
  const { debug, commands } = fixture();
  const result = await debug.breakpoints(['main', 'main', 'missing', '-x', 'handler.c:15']);
  assert.deepEqual(
    result.map((r) => r.status),
    ['added', 'existing', 'failed', 'failed', 'added'],
  );
  assert.equal(result[0].id, result[1].id);
  assert.equal(result[2].error, 'No symbol missing');
  assert.equal(result[3].error, 'error.invalidArguments');
  assert.equal(commands.filter((c) => c.startsWith('-break-insert')).length, 3);
  await assert.rejects(debug.breakpoints(Array(129).fill('main')), /invalidArguments/);
  await assert.rejects(fixture(true).debug.breakpoints(['main']), /debuggerNotStopped/);
});

test('Flash, odd addresses, wrong widths and missing confirmation are rejected before hardware commands', async () => {
  const { debug, commands } = fixture();
  for (const invalid of [
    { address: 0x08000000 },
    { address: 0x20005000 },
    { address: 0x20000001 },
    { bytes: '00f0' },
    { bytes: '00bf00bf' },
    { bytes: '00bf\n-exec-continue' },
    { confirm: false },
  ])
    await assert.rejects(debug.patch({ ...request, ...invalid } as DebuggerPatchRequest));
  assert.deepEqual(commands, []);
  await assert.rejects(fixture(true).debug.patch(request), /debuggerPatchPauseRequired/);
});

test('noncontiguous memory reads are not collapsed into misleading data', async () => {
  const context = fixture();
  context.intercept((command, reply) => {
    if (!command.startsWith('-data-read')) return false;
    reply('memory=[{begin="0x20000001",end="0x20000003",contents="00bf"}]');
    return true;
  });
  await assert.rejects(context.debug.memory(request.address, 2), /debuggerMemoryIncomplete/);
  await assert.rejects(context.debug.patch(request), /debuggerMemoryIncomplete/);
  assert.equal(
    context.commands.some((c) => c.startsWith('-data-write')),
    false,
  );
});

test('a patch dialog from the previous connection cannot modify a new target with identical opcodes', async () => {
  const context = fixture();
  context.owner.snapshot.sessionId = 'different-device-session';
  await assert.rejects(context.debug.patch(request), /debuggerSessionChanged/);
  assert.deepEqual(context.commands, []);
});

test('continue command acknowledgement is serialized with patch and batch operations', async () => {
  const context = fixture();
  let resume: (() => void) | undefined;
  context.intercept((command, reply) => {
    if (command !== '-exec-continue') return false;
    resume = () => reply();
    return true;
  });
  const action = context.debug.action('continue');
  await tick();
  await assert.rejects(context.debug.patch(request), /debuggerBusy/);
  await assert.rejects(context.debug.breakpoints(['main']), /debuggerBusy/);
  resume!();
  await action;
  assert.equal(context.owner.snapshot.connection, 'running');
  await assert.rejects(context.debug.patch(request), /debuggerPatchPauseRequired/);
});

test('instruction patches reject the middle of a 32-bit instruction and unknown addresses', async () => {
  const context = fixture();
  context.owner.snapshot.instructions = [
    { address: '0x20000000', instruction: 'b.w somewhere', opcodes: '00 f0 00 b8' },
  ];
  await assert.rejects(
    context.debug.patch({ ...request, address: 0x20000002, expected: '00b8', bytes: '00bf' }),
    /debuggerPatchInstruction/,
  );
  await assert.rejects(context.debug.patch({ ...request, address: 0x20000004 }), /debuggerPatchInstruction/);
  await assert.rejects(context.debug.patch(request), /debuggerPatchInstruction/);
  assert.deepEqual(context.commands, []);
});

test('web and automation patch routes require explicit confirmation and validate batch limits', async () => {
  const calls: unknown[] = [];
  const service = {
    patch: async (r: unknown) => calls.push(r),
    breakpoints: async (r: unknown) => calls.push(r),
    assemble: async (...r: unknown[]) => calls.push(r),
  } as unknown as HardwareDebugger;
  const web = createWebDebugger(service, {} as CoreService);
  await assert.rejects(web.invoke('debuggerPatch', [{ ...request, confirm: false }]), /invalidParams/);
  await assert.rejects(web.invoke('debuggerBreakpoints', [Array(129).fill('main')]), /invalidParams/);
  assert.equal(
    workbenchRouteSchemas['debugger.patch'].safeParse({ ...request, confirm: false }).success,
    false,
  );
  await web.invoke('debuggerPatch', [request]);
  await web.invoke('debuggerBreakpoints', [['main']]);
  await web.invoke('debuggerAssemble', [request.address, 'nop']);
  assert.deepEqual(calls, [request, ['main'], [request.address, 'nop']]);
});
