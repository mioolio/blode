import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HardwareDebuggerView } from '../src/renderer/components/HardwareDebuggerView';
import { DebuggerMenubar } from '../src/renderer/components/DebuggerChrome';
import {
  breakpointLocations,
  canPatchInstruction,
  machineCodeBytes,
  instructionAssembly,
  validMemoryRange,
} from '../src/renderer/components/debuggerEditing';
import { DebuggerRequests } from '../src/renderer/components/debuggerRequests';
import { debuggerPresentation, debuggerRegister } from '../src/renderer/components/debuggerProfiles';
import { getDebuggerProfile } from '../src/shared/debugger-profiles';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('debugger first paint exposes resizeable disassembly, registers and memory panes without synthetic CPU telemetry', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __blodeFrameless: false, __blodeWeb: true },
  });
  try {
    const html = renderToStaticMarkup(createElement(HardwareDebuggerView));
    assert.match(html, /class="debug-dock-grid"/);
    assert.match(html, /role="separator"[^>]*aria-orientation="vertical"/);
    assert.match(html, /class="debug-card debug-instructions"/);
    assert.match(html, /class="debug-card debug-registers"/);
    assert.match(html, /class="debug-card debug-memory-view"/);
    assert.match(html, /class="debug-card debug-stack"/);
    assert.match(html, /class="debug-card debug-breakpoints"/);
    assert.doesNotMatch(html, /class="debug-cpu-flow"|ALU · R0/);
    assert.doesNotMatch(html, /数据来源|debug-summary-grid/);
    assert.match(html, /role="menubar"/);
    assert.doesNotMatch(html, /<h1|class="debug-page-heading"|class="debug-connection-bar"/);
    assert.match(html, /class="primary debug-heading-action"[^>]*>.*?<svg[^>]*.*?<\/svg>/);
    assert.match(html, /class="debug-memory-fields"/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('debugger menu groups use accessible triggers and leave connection settings off the workspace', () => {
  const html = renderToStaticMarkup(
    createElement(DebuggerMenubar, {
      label: 'Debug menu',
      menus: [{ label: 'Connection', items: [{ label: 'Connection settings', run() {} }] }],
    }),
  );
  assert.match(html, /role="menubar"/);
  assert.match(html, /role="menuitem" aria-haspopup="menu" aria-expanded="false"/);
  assert.doesNotMatch(html, /Connection settings/);
});

test('batch entry preserves file locations and removes only blank or duplicate lines', () => {
  assert.deepEqual(breakpointLocations(' main \r\nC:/team project/main.c:20\n*0x08000100\nmain\n\n'), [
    'main',
    'C:/team project/main.c:20',
    '*0x08000100',
  ]);
  assert.equal(
    breakpointLocations(Array.from({ length: 129 }, (_, n) => `function${n}`).join('\n')).length,
    129,
  );
});

test('patch editor accepts Thumb byte counts and rejects flash, unaligned or overrun SRAM addresses', () => {
  assert.equal(machineCodeBytes('00 BF'), '00bf');
  assert.equal(machineCodeBytes(' 00 f0\n00 f8 '), '00f000f8');
  for (const value of ['0xbf00', 'gg00', '00', '000000', '000000000000', ''])
    assert.equal(machineCodeBytes(value), null);
  assert.equal(canPatchInstruction(0x20000000, '00bf'), true);
  assert.equal(canPatchInstruction(0x20004ffe, '00bf'), true);
  assert.equal(canPatchInstruction(0x20004ffe, '00f000f8'), false);
  assert.equal(canPatchInstruction(0x20000001, '00bf'), false);
  assert.equal(canPatchInstruction(0x08000000, '00bf'), false);
  assert.equal(canPatchInstruction(0x20000000, undefined), false);
});

test('memory reader rejects empty addresses and 32-bit boundary overflow before dispatch', () => {
  assert.equal(validMemoryRange('0x20000000', 128), true);
  assert.equal(validMemoryRange('0xffffffff', 1), true);
  for (const [address, length] of [
    ['', 10],
    [' ', 1],
    ['0xffffffff', 2],
    ['0x20000000', 4097],
    ['-1', 1],
    ['NaN', 32],
    ['0x20000000', 1.5],
  ] as const)
    assert.equal(validMemoryRange(address, length), false);
});

test('GDB symbol annotations and comments are removed from editable assembly', () => {
  assert.equal(instructionAssembly('bl 0x20000020 <worker+4> ; call worker'), 'bl 0x20000020');
  assert.equal(instructionAssembly('movs r0, #1 @ value'), 'movs r0, #1');
});

test('debugger responses cannot overwrite later refreshes or a switched target', () => {
  const requests = new DebuggerRequests();
  const oldPoll = requests.begin('state');
  const currentPoll = requests.begin('state');
  assert.equal(requests.current(oldPoll), false);
  assert.equal(requests.current(currentPoll), true);
  const memory = requests.begin('memory');
  assert.equal(requests.current(currentPoll), true);
  requests.invalidate();
  assert.equal(requests.current(currentPoll), false);
  assert.equal(requests.current(memory), false);
  const newPoll = requests.begin('state');
  assert.equal(requests.current(newPoll), true);
});

test('a target switch retries storage and late state failures are discarded', async () => {
  const requests = new DebuggerRequests();
  const oldStorage = deferred<string>();
  const oldState = deferred<string>();
  const storageRequest = requests.read('storage', () => oldStorage.promise);
  const stateRequest = requests.read('state', () => oldState.promise);
  requests.invalidate();
  const currentStorage = await requests.read('storage', async () => 'symbols.elf');
  oldStorage.resolve('old.elf');
  oldState.reject(new Error('disconnected old session'));
  assert.equal(await storageRequest, null);
  assert.equal(await stateRequest, null);
  assert.equal(currentStorage?.value, 'symbols.elf');
  assert.ok(currentStorage && requests.current(currentStorage.token));
  await assert.rejects(
    requests.read('state', async () => {
      throw new Error('current session error');
    }),
    /current session error/,
  );
});

test('a superseded fresh-session check cannot authorize displaying memory', async () => {
  const requests = new DebuggerRequests();
  const pending = deferred<{ sessionId: string }>();
  const fresh = requests.read('state', () => pending.promise);
  await requests.read('state', async () => ({ sessionId: 'replacement' }));
  pending.resolve({ sessionId: 'old' });
  assert.equal(await fresh, null);
});

test('ESP32-S3 presentation uses Xtensa registers and shared memory mappings without ARM editing', () => {
  const profile = debuggerPresentation('Esp32_S3_CAM');
  assert.ok(profile);
  assert.equal(profile.patch, false);
  assert.equal(profile.defaultMemory, 0x3fc88000);
  assert.equal(profile.statusRegister, undefined);
  assert.deepEqual(profile.flags, []);
  assert.ok(profile.registers.includes('pc'));
  assert.ok(profile.registers.includes('a15'));
  assert.ok(profile.registers.includes('ps'));
  assert.ok(profile.registers.includes('sar'));
  assert.equal(profile.registers.includes('r15'), false);
  assert.equal(debuggerRegister(new Map([['a1', '0x3fc90000']]), 'sp', profile), '0x3fc90000');
  const shared = getDebuggerProfile('Esp32_S3_CAM')!;
  assert.equal(profile.registers, shared.registerNames);
  assert.ok(shared.memoryRegions.some((region) => region.kind === 'flash' && region.start === 0x42000000));
  assert.equal(
    shared.memoryRegions.some((region) => region.start === 0x08000000),
    false,
  );
});

test('STM32 register aliases and patch capability stay isolated from unknown platforms', () => {
  const profile = debuggerPresentation('STM32F103C8T6');
  assert.ok(profile?.patch);
  assert.equal(debuggerRegister(new Map([['r15', '0x08001234']]), 'pc', profile), '0x08001234');
  assert.equal(debuggerPresentation('unknown'), undefined);
  assert.equal(debuggerRegister(new Map([['r15', '0x08001234']]), 'pc'), '—');
});
