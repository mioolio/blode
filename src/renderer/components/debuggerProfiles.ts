import { getDebuggerProfile, type DebuggerProfile } from '../../shared/debugger-profiles';

export interface DebuggerPresentation {
  id: string;
  registers: readonly string[];
  aliases: Readonly<Record<string, readonly string[]>>;
  statusRegister?: string;
  flags: readonly { name: string; bit: number }[];
  connection: string;
  frequency: { default: number; min: number; max: number };
  defaultMemory: number;
  patch: boolean;
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

export function debuggerPresentation(id: string | undefined): DebuggerPresentation | undefined {
  const profile = id && getDebuggerProfile(id);
  if (!profile) return undefined;
  return {
    ...presentations[profile.architecture],
    id: profile.id,
    registers: profile.registerNames,
    patch: profile.canPatchInstructions,
    defaultMemory: profile.memoryRegions.find((region) => region.kind === 'ram')!.start,
  };
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
