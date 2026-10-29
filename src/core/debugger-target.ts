import type { ProjectConfig } from '../shared/contracts';
import type { DebuggerProfile } from '../shared/debugger-profiles';

export function debuggerServerArguments(
  profile: DebuggerProfile,
  config: ProjectConfig,
  port: number,
  scripts?: string | null,
): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('error.invalidArguments');
  if (profile.transport === 'swd') {
    const serial = config.programmer?.serialNumber;
    if (!serial || !/^[a-fA-F0-9]{1,64}$/.test(serial)) throw new Error('error.selectDebugProbe');
    const frequency = config.programmer?.frequencyKhz ?? 1800;
    if (!Number.isInteger(frequency) || frequency < 5 || frequency > 4000)
      throw new Error('error.invalidArguments');
    return ['-m', '--no-reset', '--serial', serial, '-p', String(port), '-F', `${frequency}k`];
  }
  if (!scripts) throw new Error('error.debuggerEspScripts');
  const serial = config.debugger?.serialNumber ?? '';
  if (!/^[A-Za-z0-9:_-]{0,128}$/.test(serial)) throw new Error('error.invalidArguments');
  const frequency = config.debugger?.frequencyKhz ?? 20000;
  if (!Number.isInteger(frequency) || frequency < 5 || frequency > 40000)
    throw new Error('error.invalidArguments');
  return [
    '-s',
    scripts,
    '-c',
    'bindto 127.0.0.1',
    '-c',
    `gdb_port ${port}`,
    '-c',
    'tcl_port disabled',
    '-c',
    'telnet_port disabled',
    // Disabling flash support prevents an attach reset and flash-emulated breakpoints.
    '-c',
    'set ESP_FLASH_SIZE 0',
    '-f',
    'board/esp32s3-builtin.cfg',
    ...(serial ? ['-c', `adapter serial {${serial}}`] : []),
    '-c',
    `adapter speed ${frequency}`,
  ];
}

export function debuggerSegmentKind(
  profile: DebuggerProfile,
  address: number,
  size: number,
): 'ram' | 'flash' | 'other' {
  return (
    profile.memoryRegions.find((region) => address >= region.start && address + size <= region.end)?.kind ??
    'other'
  );
}
