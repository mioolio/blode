import { getDebuggerProfile, type DebuggerProfile } from '../../shared/debugger-profiles';
import type { AppState, DebuggerAction, DebuggerState, ProjectConfig } from '../../shared/contracts';

/** A build chooses the CPU profile; the workbench owns the current physical connection. */
export function debuggerProjectConfig(state: AppState, current?: ProjectConfig | null): ProjectConfig | null {
  const target =
    state.buildTarget?.config ??
    (state.config.boardId !== 'auto'
      ? state.config
      : (state.boards.find((board) => board.id === 'STM32F103C8T6')?.defaultConfig as
          ProjectConfig | undefined));
  if (!target) return null;
  const selected = state.buildTarget
    ? {
        ...target,
        port: state.config.port,
        programmer: target.programmer
          ? {
              ...target.programmer,
              serialNumber: state.config.programmer?.serialNumber ?? '',
              frequencyKhz: state.config.programmer?.frequencyKhz ?? target.programmer.frequencyKhz,
            }
          : undefined,
        runtime: { ...target.runtime, deviceId: state.config.runtime?.deviceId },
        debugger: { ...target.debugger, ...state.config.debugger },
      }
    : target;
  const next =
    current && current.boardId === selected.boardId
      ? { ...selected, programmer: current.programmer, debugger: current.debugger ?? selected.debugger }
      : selected;
  if (
    state.connections?.probes.state === 'ready' &&
    next.programmer?.serialNumber &&
    !state.debugProbes.some((probe) => probe.serialNumber === next.programmer?.serialNumber)
  )
    return { ...next, programmer: { ...next.programmer, serialNumber: '' } };
  return next;
}

export interface DebuggerPresentation {
  id: string;
  registers: readonly string[];
  aliases: Readonly<Record<string, readonly string[]>>;
  statusRegister?: string;
  flags: readonly { name: string; bit: number }[];
  connection: string;
  transport: 'swd' | 'usb-jtag' | 'uart-gdb';
  frequency: { default: number; min: number; max: number };
  defaultMemory: number;
  patch: boolean;
  tools: {
    gdbName: string;
    serverName: string;
    scripts: boolean;
    installKey: string;
    missingKey: string;
    serverRequired: boolean;
  };
}

const presentations: Record<
  DebuggerProfile['architecture'],
  Pick<DebuggerPresentation, 'aliases' | 'statusRegister' | 'flags' | 'connection' | 'frequency'>
> = {
  'arm-thumb': {
    aliases: { pc: ['r15'], sp: ['r13'], lr: ['r14'], xpsr: ['cpsr'] },
    statusRegister: 'xpsr',
    flags: [
      { name: 'N', bit: 31 },
      { name: 'Z', bit: 30 },
      { name: 'C', bit: 29 },
      { name: 'V', bit: 28 },
      { name: 'T', bit: 24 },
    ],
    connection: 'ST-Link / SWD',
    frequency: { default: 1800, min: 5, max: 4000 },
  },
  xtensa: {
    aliases: { sp: ['a1'] },
    flags: [],
    connection: 'USB Serial/JTAG',
    frequency: { default: 20000, min: 100, max: 40000 },
  },
};

export function debuggerPresentation(
  id: string | undefined,
  baseRuntime?: string,
  transport?: 'swd' | 'usb-jtag' | 'uart-gdb',
): DebuggerPresentation | undefined {
  const profile = (id && getDebuggerProfile(id)) || (baseRuntime && getDebuggerProfile(baseRuntime));
  if (!profile) return undefined;
  const uart = profile.architecture === 'xtensa' && transport === 'uart-gdb';
  return {
    ...presentations[profile.architecture],
    ...(uart ? { connection: 'UART GDB Stub' } : {}),
    transport: uart ? 'uart-gdb' : profile.transport,
    id: profile.id,
    registers: profile.registerNames,
    patch: profile.canPatchInstructions,
    defaultMemory: profile.memoryRegions.find((region) => region.kind === 'ram')!.start,
    tools: {
      gdbName: profile.gdbName,
      serverName: profile.serverName,
      scripts: !uart && profile.transport === 'usb-jtag',
      serverRequired: !uart,
      installKey: uart
        ? 'debugger.installXtensaGdb'
        : profile.architecture === 'xtensa'
          ? 'debugger.installEspTools'
          : 'debugger.installArmTools',
      missingKey: uart
        ? 'debugger.toolsMissingXtensaGdb'
        : profile.architecture === 'xtensa'
          ? 'debugger.toolsMissingEsp'
          : 'debugger.toolsMissingArm',
    },
  };
}

/** A result for old tool paths must never enable connecting with new paths. */
export function debuggerToolIdentity(config: ProjectConfig | null | undefined): string {
  return JSON.stringify([
    config?.boardId ?? '',
    config?.debugger?.transport ?? 'usb-jtag',
    config?.debugger?.gdbPath ?? '',
    config?.debugger?.serverPath ?? '',
    config?.debugger?.scriptsPath ?? '',
    config?.toolchain.stlinkDirectory ?? '',
  ]);
}

export function debuggerToolsAvailable(
  profile: DebuggerPresentation | undefined,
  tools: DebuggerState['tools'] | undefined,
): boolean {
  return !!tools?.gdb && (profile?.tools.serverRequired === false || !!tools.server);
}

export function debuggerCan(
  profile: DebuggerState['profile'],
  action: DebuggerAction | 'breakpoints' | 'memoryRead',
): boolean {
  if (action === 'disconnect') return true;
  const capability = action === 'next' || action === 'finish' ? 'step' : action;
  return profile?.capabilities?.[capability] !== false;
}

export function debuggerRegister(
  record: ReadonlyMap<string, string>,
  name: string,
  profile?: DebuggerPresentation,
): string {
  return (
    record.get(name) ??
    profile?.aliases[name]?.map((alias) => record.get(alias)).find((value) => value !== undefined) ??
    '—'
  );
}
