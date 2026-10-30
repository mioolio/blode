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
import {
  debuggerPresentation,
  debuggerRegister,
  debuggerToolIdentity,
  debuggerToolsAvailable,
  debuggerCan,
} from '../src/renderer/components/debuggerProfiles';
import { DebuggerToolsPanel } from '../src/renderer/components/DebuggerToolsPanel';
import { DebuggerErrorNotice } from '../src/renderer/components/DebuggerErrorNotice';
import { DebuggerUartSettings } from '../src/renderer/components/DebuggerUartSettings';
import { configSchema } from '../src/core/config';
import { debuggerErrorSummary, debuggerDiagnosticLog } from '../src/shared/debugger-errors';
import { getDebuggerProfile } from '../src/shared/debugger-profiles';
import { getBoardAdapter } from '../extensions/registry';
import { translate } from '../src/renderer/i18n';

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

const toolPanelProps = {
  checking: false,
  disabled: false,
  web: false,
  onChange() {},
  onCheck() {},
  onChooseGdb() {},
  onInstall() {},
};

test('ESP tool dialog renders matching installer and separate executable/scripts findings', () => {
  const html = renderToStaticMarkup(
    createElement(DebuggerToolsPanel, {
      ...toolPanelProps,
      profile: debuggerPresentation('Esp32_S3_CAM'),
      tools: {
        gdb: true,
        server: false,
        paths: { gdb: '/tools/xtensa-gdb', server: '/tools/openocd', scripts: null },
      },
    }),
  );
  assert.match(html, /xtensa-esp-elf-gdb/);
  assert.match(html, /OpenOCD ESP32<\/span><span title="\/tools\/openocd">已找到/);
  assert.match(html, /OpenOCD scripts 目录<\/span><span>未找到/);
  assert.match(html, /安装 Xtensa GDB 与 OpenOCD/);
  assert.doesNotMatch(html, /安装 GNU|st-util|—|✓/);
  assert.equal((html.match(/<input/g) ?? []).length, 3);
  assert.match(html, /选择 GDB 程序/);
});

test('tool status distinguishes unchecked, checking and missing without retaining stale paths', () => {
  const profile = debuggerPresentation('Esp32_S3_CAM');
  const unchecked = renderToStaticMarkup(createElement(DebuggerToolsPanel, { ...toolPanelProps, profile }));
  assert.equal((unchecked.match(/待检查/g) ?? []).length, 3);
  const checking = renderToStaticMarkup(
    createElement(DebuggerToolsPanel, {
      ...toolPanelProps,
      profile,
      checking: true,
      disabled: true,
      tools: {
        gdb: true,
        server: true,
        paths: { gdb: '/old/gdb', server: '/old/openocd', scripts: '/old/scripts' },
      },
    }),
  );
  assert.match(checking, /aria-busy="true"/);
  assert.equal((checking.match(/检查中/g) ?? []).length, 3);
  assert.doesNotMatch(checking, /title="\/old|已找到/);
  assert.equal((checking.match(/disabled=""/g) ?? []).length, 6);
  const missing = renderToStaticMarkup(
    createElement(DebuggerToolsPanel, {
      ...toolPanelProps,
      profile,
      tools: { gdb: false, server: false },
    }),
  );
  assert.equal((missing.match(/未找到/g) ?? []).length, 3);
});

test('STM32 and packaged ESP tool profiles remain separate and web hides the native picker', () => {
  const arm = debuggerPresentation('STM32F103C8T6')!;
  const html = renderToStaticMarkup(
    createElement(DebuggerToolsPanel, {
      ...toolPanelProps,
      profile: arm,
      web: true,
      disabled: true,
      tools: { gdb: false, server: true },
    }),
  );
  assert.match(html, /arm-none-eabi-gdb/);
  assert.match(html, /st-util/);
  assert.match(html, /安装 GNU Arm GDB/);
  assert.doesNotMatch(html, /Xtensa|OpenOCD|选择 GDB/);
  assert.equal((html.match(/<input/g) ?? []).length, 2);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
  const packaged = debuggerPresentation('Esp32_S3_CAM_Module', 'Esp32_S3_CAM')!;
  assert.equal(packaged.id, 'Esp32_S3_CAM');
  assert.equal(packaged.defaultMemory, 0x3fc88000);
  assert.equal(packaged.tools.scripts, true);
  assert.match(translate('zh-CN', packaged.tools.missingKey), /Xtensa GDB.*OpenOCD/);
  assert.match(translate('zh-CN', arm.tools.missingKey), /GNU Arm GDB 与 st-util/);
});

test('a tool result belongs to its exact platform and configured lookup paths', () => {
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  const identity = debuggerToolIdentity(config);
  assert.equal(debuggerToolIdentity(structuredClone(config)), identity);
  for (const key of ['gdbPath', 'serverPath', 'scriptsPath'] as const)
    assert.notEqual(debuggerToolIdentity({ ...config, debugger: { [key]: '/custom/tool' } }), identity);
  assert.notEqual(debuggerToolIdentity({ ...config, boardId: 'STM32F103C8T6' }), identity);
  assert.notEqual(
    debuggerToolIdentity({
      ...config,
      toolchain: { ...config.toolchain, stlinkDirectory: '/custom/stlink' },
    }),
    identity,
  );
});

const openOcdFailure = [
  'Open On-Chip Debugger v0.12.0-esp32',
  'Licensed under GNU GPL v2',
  'Info : esp_usb_jtag: VID set to 0x303a and PID to 0x1001',
  'Error: esp_usb_jtag: could not find or open device!',
  'C:/tools/openocd/scripts/target/esp32s3.cfg:12: Error:',
].join('\n');

test('USB-JTAG failure notice shows an actionable reason and keeps raw output in the log', () => {
  const html = renderToStaticMarkup(
    createElement(DebuggerErrorNotice, { message: openOcdFailure, transport: 'usb-jtag', onViewLog() {} }),
  );
  assert.match(html, /无法打开 USB-JTAG 设备/);
  assert.match(html, /查看调试日志/);
  assert.doesNotMatch(html, /Open On-Chip|Licensed|esp32s3\.cfg/);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  assert.deepEqual(debuggerDiagnosticLog([], [openOcdFailure]), [openOcdFailure]);
  assert.deepEqual(
    debuggerDiagnosticLog(openOcdFailure.split('\n'), [openOcdFailure]),
    openOcdFailure.split('\n'),
  );
});

test('preflight RPC errors are localized while unrelated failures retain their actual cause', () => {
  for (const suffix of ['Missing', 'Unavailable', 'Ambiguous', 'SerialMismatch', 'Driver']) {
    const key = `error.debuggerUsbJtag${suffix}`;
    assert.equal(
      debuggerErrorSummary(`Error invoking remote method 'blode:request': Error: ${key}`, 'usb-jtag'),
      key,
    );
    assert.notEqual(translate('zh-CN', key), key);
    assert.notEqual(translate('en', key), key);
  }
  assert.equal(
    debuggerErrorSummary('GDB launch failed: missing libpython3.dll', 'usb-jtag'),
    'GDB launch failed: missing libpython3.dll',
  );
  assert.equal(
    debuggerErrorSummary('Open On-Chip Debugger\nInfo : setup\nError: target voltage too low', 'usb-jtag'),
    'Error: target voltage too low',
  );
  assert.equal(
    debuggerErrorSummary('Error: st-util could not open device', 'swd'),
    'st-util could not open device',
  );
  const long = 'Failed to read ' + 'memory '.repeat(100);
  assert.ok(debuggerErrorSummary(long).length <= 240);
  assert.ok(debuggerErrorSummary(long).endsWith('…'));
  assert.equal(debuggerDiagnosticLog([], [long, long]).length, 1);
  assert.equal(debuggerDiagnosticLog([], [long])[0], long.trim());
});

test('UART tools require only Xtensa GDB and transport changes invalidate checked results', () => {
  const profile = debuggerPresentation('Esp32_S3_CAM', undefined, 'uart-gdb');
  assert.ok(profile);
  assert.equal(profile.transport, 'uart-gdb');
  const html = renderToStaticMarkup(
    createElement(DebuggerToolsPanel, { ...toolPanelProps, profile, tools: { gdb: true, server: false } }),
  );
  assert.equal((html.match(/class="debug-tool-row"/g) ?? []).length, 1);
  assert.equal((html.match(/<input/g) ?? []).length, 1);
  assert.match(html, /安装 Xtensa GDB/);
  assert.doesNotMatch(html, /OpenOCD|serverPath|scriptsPath|st-util/);
  assert.equal(debuggerToolsAvailable(profile, { gdb: true, server: false }), true);
  assert.equal(debuggerToolsAvailable(profile, { gdb: false, server: true }), false);
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  assert.notEqual(
    debuggerToolIdentity(config),
    debuggerToolIdentity({ ...config, debugger: { transport: 'uart-gdb' } }),
  );
  assert.equal(debuggerPresentation('custom', 'Esp32_S3_CAM', 'uart-gdb')?.transport, 'uart-gdb');
  assert.equal(debuggerPresentation('STM32F103C8T6', undefined, 'uart-gdb')?.transport, 'swd');
});

test('UART settings use host COM devices and do not expose a stale missing port', () => {
  const html = renderToStaticMarkup(
    createElement(DebuggerUartSettings, {
      options: { port: 'COM99', transport: 'uart-gdb', stubMode: 'panic' },
      ports: [{ path: 'COM3', manufacturer: 'CH340' }],
      disabled: false,
      onChange() {},
      onRefresh() {},
    }),
  );
  assert.match(html, /COM3/);
  assert.doesNotMatch(html, /COM99/);
  assert.match(html, /115200/);
  assert.match(html, /崩溃现场（只读）/);
  assert.doesNotMatch(html, /OpenOCD|ST-Link/);
});

test('panic inspection disables execution and breakpoints while preserving memory reads', () => {
  const profile = {
    ...getDebuggerProfile('Esp32_S3_CAM')!,
    transport: 'uart-gdb' as const,
    capabilities: { continue: false, pause: false, step: false, breakpoints: false, memoryRead: true },
  };
  for (const action of ['continue', 'pause', 'step', 'next', 'finish', 'breakpoints'] as const)
    assert.equal(debuggerCan(profile, action), false);
  assert.equal(debuggerCan(profile, 'memoryRead'), true);
  assert.equal(debuggerCan(profile, 'disconnect'), true);
  assert.equal(debuggerCan(getDebuggerProfile('Esp32_S3_CAM'), 'step'), true);
});

test('debugger UART config accepts portable serial settings and rejects malformed baud or modes', () => {
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  const debuggerOptions = {
    transport: 'uart-gdb',
    port: '/dev/ttyUSB0',
    baudRate: 115200,
    stubMode: 'runtime',
  };
  assert.deepEqual(configSchema.parse({ ...config, debugger: debuggerOptions }).debugger, debuggerOptions);
  for (const changes of [
    { baudRate: 0 },
    { baudRate: 115200.5 },
    { stubMode: 'unknown' },
    { transport: 'serial' },
  ])
    assert.equal(
      configSchema.safeParse({ ...config, debugger: { ...debuggerOptions, ...changes } }).success,
      false,
    );
});
