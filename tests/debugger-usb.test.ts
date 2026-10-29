import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightEsp32UsbJtag } from '../extensions/boards/Esp32_S3_CAM/device/debug-usb';
import type { RuntimeHost } from '../extensions/runtime';

const parent = (serial = 'AA:BB:CC:DD:EE:01') => `USB\\VID_303A&PID_1001\\${serial}`;
const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  parent: null,
  present: true,
  problem: 0,
  service: 'usbccgp',
  ...overrides,
});
const device = (serial = 'AA:BB:CC:DD:EE:01', service = 'WinUSB', problem = 0) => [
  row(parent(serial)),
  row(`USB\\VID_303A&PID_1001&MI_00\\8&${serial.replaceAll(':', '')}&0&0000`, {
    service: 'usbser',
    parent: parent(serial),
  }),
  row(`USB\\VID_303A&PID_1001&MI_02\\8&${serial.replaceAll(':', '')}&0&0002`, {
    service,
    problem,
    parent: parent(serial),
  }),
];
function fixture(devices: unknown[], serialNumber?: string) {
  const calls: { command: string; args: string[] }[] = [],
    diagnostics: string[] = [];
  const runner: RuntimeHost['runCommand'] = async (command, args) => {
    calls.push({ command, args });
    return { code: 0, output: JSON.stringify({ complete: true, devices }) };
  };
  return {
    calls,
    diagnostics,
    options: {
      runner,
      platform: 'win32' as const,
      serialNumber,
      onDiagnostic: (message: string) => diagnostics.push(message),
    },
  };
}

test('only native Espressif USB-JTAG qualifies; a healthy CH340 serial bridge does not', async () => {
  for (const devices of [
    [],
    [row('USB\\VID_1A86&PID_7523\\ABC', { service: 'CH341SER_A64' })],
    [row('USB\\VID_303A&PID_1002\\ABC')],
  ])
    await assert.rejects(preflightEsp32UsbJtag(fixture(devices).options), /debuggerUsbJtagMissing/);
});

test('healthy native JTAG is enumerated once; serial interfaces are not treated as extra devices', async () => {
  const f = fixture(device());
  await preflightEsp32UsbJtag(f.options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, 'powershell.exe');
  const script = Buffer.from(f.calls[0].args.at(-1)!, 'base64').toString('utf16le');
  assert.match(script, /Get-CimInstance/);
  assert.match(script, /DEVPKEY_Device_Parent/);
  assert.doesNotMatch(script, /Set-PnpDevice|Disable-PnpDevice|Enable-PnpDevice|pnputil|Install-Driver/);
});

test('disconnected historic devices are ignored and unknown presence defers to OpenOCD', async () => {
  const absent = device().map((value) => ({ ...value, present: false }));
  await assert.rejects(preflightEsp32UsbJtag(fixture(absent).options), /debuggerUsbJtagMissing/);
  await assert.rejects(
    preflightEsp32UsbJtag(fixture(device().map((value) => ({ ...value, problem: 45 }))).options),
    /debuggerUsbJtagMissing/,
  );
  const uncertain = fixture(device().map((value) => ({ ...value, present: null })));
  await preflightEsp32UsbJtag(uncertain.options);
  assert.match(uncertain.diagnostics[0], /could not be confirmed/);
});

test('PnP error codes report driver failures while WinUSB, libusbK, libusb0 and unknown services may connect', async () => {
  for (const service of ['WinUSB', 'libusbK', 'libusb0', 'custom-driver', ''])
    await preflightEsp32UsbJtag(fixture(device(undefined, service)).options);
  for (const code of [10, 22, 28, 31, 43])
    await assert.rejects(
      preflightEsp32UsbJtag(fixture(device(undefined, '', code)).options),
      /debuggerUsbJtagDriver/,
    );
});

test('multiple physical native devices require an explicit matching USB serial', async () => {
  const devices = [...device(), ...device('AA:BB:CC:DD:EE:02', '', 28)];
  await assert.rejects(preflightEsp32UsbJtag(fixture(devices).options), /debuggerUsbJtagAmbiguous/);
  await preflightEsp32UsbJtag(fixture(devices, 'aa-bb-cc-dd-ee-01').options);
  await assert.rejects(
    preflightEsp32UsbJtag(fixture(devices, 'AABBCCDDEE02').options),
    /debuggerUsbJtagDriver/,
  );
  await assert.rejects(
    preflightEsp32UsbJtag(fixture(devices, 'AABBCCDDEE03').options),
    /debuggerUsbJtagSerialMismatch/,
  );
});

test('unmapped JTAG interfaces stay distinct and duplicate normalized serials cannot select the first target', async () => {
  const unknown = [1, 2].map((id) =>
    row(`USB\\VID_303A&PID_1001&MI_02\\7&BOARD${id}&0&0002`, { service: 'WinUSB' }),
  );
  await assert.rejects(preflightEsp32UsbJtag(fixture(unknown).options), /debuggerUsbJtagAmbiguous/);
  const duplicate = [...device('AA:BB:CC:DD:EE:01'), ...device('AABBCCDDEE01')];
  await assert.rejects(
    preflightEsp32UsbJtag(fixture(duplicate, 'AABBCCDDEE01').options),
    /debuggerUsbJtagAmbiguous/,
  );
});

test('confirmed missing-device errors include bounded USB-UART diagnostics', async () => {
  const f = fixture([row('USB\\VID_1A86&PID_7523\\private-instance', { service: 'CH341SER_A64' })]);
  await assert.rejects(preflightEsp32UsbJtag(f.options), /debuggerUsbJtagMissing/);
  assert.match(f.diagnostics[0], /VID_303A&PID_1001 not found/);
  assert.match(f.diagnostics[0], /VID_1A86&PID_7523/);
  assert.doesNotMatch(f.diagnostics[0], /private-instance/);
});

test('a known parent ID can identify the physical device even when CIM omits its composite record', async () => {
  await preflightEsp32UsbJtag(
    fixture(
      device().filter((value) => value.id.includes('MI_02')),
      'AA:BB:CC:DD:EE:01',
    ).options,
  );
  const unknown = fixture(
    [row('USB\\VID_303A&PID_1001&MI_02\\7&ABC&0&0002', { service: 'WinUSB' })],
    '123456',
  );
  await preflightEsp32UsbJtag(unknown.options);
  assert.ok(unknown.diagnostics.some((value) => /serial numbers could not be confirmed/.test(value)));
});

test('enumeration failures, malformed results and timeouts preserve the OpenOCD fallback', async () => {
  for (const output of ['', '[]', '{}', '{"complete":true,"devices":[{}]}', 'null']) {
    const f = fixture([]);
    f.options.runner = async () => ({ code: 0, output });
    await preflightEsp32UsbJtag(f.options);
    assert.match(f.diagnostics[0], /preflight unavailable/);
  }
  for (const failure of [
    async () => {
      throw Error('error.processTimeout');
    },
    async () => ({ code: 1, output: 'CIM service unavailable' }),
  ]) {
    const f = fixture([]);
    f.options.runner = failure;
    await preflightEsp32UsbJtag(f.options);
    assert.match(f.diagnostics[0], /preflight unavailable/);
  }
});

test('Linux/macOS bypass enumeration and explicit cancellation is not treated as a failed precheck', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const f = fixture([]);
    await preflightEsp32UsbJtag({ ...f.options, platform });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture([]),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    preflightEsp32UsbJtag({ ...f.options, signal: controller.signal }),
    /operationCancelled/,
  );
  assert.equal(f.calls.length, 0);
});
