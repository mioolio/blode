import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildElevatedScript,
  buildLauncher,
  parseDriverVersion,
  resolveDriverState,
} from '../src/core/drivers';
import { runCommand } from '../src/core/process';
import { getDriverDefinition, listDriverDefinitions } from '../extensions/drivers/index';

test('driver registry keeps the official STSW-LINK package facts in the extension', () => {
  const [driver] = listDriverDefinitions();
  assert.equal(driver.id, 'stlink');
  assert.equal(driver.archive, 'stsw-link009.zip');
  assert.deepEqual(
    [...driver.infFiles],
    ['stlink_dbg_winusb.inf', 'stlink_bridge_winusb.inf', 'stlink_VCP.inf'],
  );
  assert.ok(driver.deviceIds.includes('VID_0483&PID_3748'));
  assert.equal(getDriverDefinition('stlink'), driver);
  assert.throws(() => getDriverDefinition('unknown'), /driverUnknown/);
});

test('driver state distinguishes missing packages, attached probes and unbound devices', () => {
  assert.equal(resolveDriverState(false, []), 'missing');
  assert.equal(resolveDriverState(true, []), 'installed');
  assert.equal(resolveDriverState(true, [{ status: 'OK', problem: 0 }]), 'ready');
  assert.equal(resolveDriverState(false, [{ status: 'OK', problem: 0 }]), 'ready');
  assert.equal(resolveDriverState(true, [{ status: 'Error', problem: 28 }]), 'device-unbound');
  assert.equal(
    resolveDriverState(true, [
      { status: 'Error', problem: 28 },
      { status: 'OK', problem: 0 },
    ]),
    'ready',
  );
});

test('driver version comes from the INF DriverVer entry, not a locale-dependent string', () => {
  assert.equal(parseDriverVersion('DriverVer=04/01/2021,2.02'), '2.02');
  assert.equal(parseDriverVersion('[Version]\nDriverVer = 04/01/2021, 2.03 \n'), '2.03');
  assert.equal(parseDriverVersion('[Version]\nSignature = "$Windows NT$"'), '');
});

test(
  'generated installer and launcher scripts parse as valid PowerShell',
  { skip: process.platform !== 'win32' },
  async () => {
    const elevated = buildElevatedScript("C:\\temp\\driver's package", 'C:\\temp\\result.json', [
      'stlink_dbg_winusb.inf',
      'stlink_bridge_winusb.inf',
    ]);
    const launcher = buildLauncher(elevated, 'C:\\temp\\elevation-error.txt');
    for (const script of [elevated, launcher]) {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const command = `$text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); $null = [scriptblock]::Create($text); exit 0`;
      const result = await runCommand(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { timeout: 20_000 },
      );
      assert.equal(result.code, 0, result.output);
    }
  },
);
