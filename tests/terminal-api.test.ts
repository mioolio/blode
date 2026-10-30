import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalParameterSchemas } from '../src/core/terminal-schemas';
import { createWorkbenchBridge } from '../src/shared/workbench-bridge';

test('named terminal commands retain their target and require execution confirmation', () => {
  const target = { terminalId: 'build.debug', sessionId: 'generation-1' };
  assert.deepEqual(terminalParameterSchemas['terminal.state'].parse({ ...target, after: 4 }), {
    ...target,
    after: 4,
  });
  assert.deepEqual(
    terminalParameterSchemas['terminal.run'].parse({ ...target, command: 'echo hello', confirm: true }),
    { ...target, command: 'echo hello', confirm: true },
  );
  assert.equal(
    terminalParameterSchemas['terminal.open'].parse({ create: true, name: 'Debug shell', confirm: true })
      .name,
    'Debug shell',
  );
  assert.throws(() => terminalParameterSchemas['terminal.run'].parse({ ...target, command: 'echo hello' }));
  assert.throws(() => terminalParameterSchemas['terminal.close'].parse(target));
  assert.throws(() =>
    terminalParameterSchemas['terminal.open'].parse({ terminalId: '../shell', confirm: true }),
  );
  assert.throws(() => terminalParameterSchemas['terminal.open'].parse({ name: 'bad\nname', confirm: true }));
});

test('desktop and Web bridges preserve named targets while keeping default-session calls unchanged', async () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const bridge = createWorkbenchBridge(
    async (method, args) => {
      calls.push({ method, args });
      return null;
    },
    () => () => {},
  );
  const target = { terminalId: 'build.debug', sessionId: 'generation-1' };
  await bridge.terminalSessions();
  await bridge.terminalOpen();
  await bridge.terminalStop();
  await bridge.terminalClose();
  await bridge.terminalOpen({ terminalId: 'build.debug', name: 'Debug shell' });
  await bridge.terminalStop(target);
  await bridge.terminalClose(target);
  await bridge.terminalWrite({ ...target, data: '中文\r' });
  assert.deepEqual(calls, [
    { method: 'terminalSessions', args: [] },
    { method: 'terminalOpen', args: [] },
    { method: 'terminalStop', args: [] },
    { method: 'terminalClose', args: [] },
    { method: 'terminalOpen', args: [{ terminalId: 'build.debug', name: 'Debug shell' }] },
    { method: 'terminalStop', args: [target] },
    { method: 'terminalClose', args: [target] },
    { method: 'terminalWrite', args: [{ ...target, data: '中文\r' }] },
  ]);
});
