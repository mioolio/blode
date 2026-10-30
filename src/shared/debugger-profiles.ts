export interface DebuggerProfile {
  id: 'STM32F103C8T6' | 'Esp32_S3_CAM';
  architecture: 'arm-thumb' | 'xtensa';
  elfMachine: number;
  gdbName: string;
  serverName: string;
  transport: 'swd' | 'usb-jtag' | 'uart-gdb';
  capabilities?: {
    continue: boolean;
    pause: boolean;
    step: boolean;
    breakpoints: boolean;
    memoryRead: boolean;
  };
  canPatchInstructions: boolean;
  canAssemble: boolean;
  registerNames: string[];
  stackPointer: string;
  statusRegister: string;
  memoryRegions: { name: string; start: number; end: number; kind: 'ram' | 'flash' }[];
}

export const debuggerProfiles: Record<DebuggerProfile['id'], DebuggerProfile> = {
  STM32F103C8T6: {
    id: 'STM32F103C8T6',
    architecture: 'arm-thumb',
    elfMachine: 40,
    gdbName: 'arm-none-eabi-gdb',
    serverName: 'st-util',
    transport: 'swd',
    canPatchInstructions: true,
    canAssemble: true,
    registerNames: [...Array.from({ length: 13 }, (_, i) => `r${i}`), 'sp', 'lr', 'pc'],
    stackPointer: 'sp',
    statusRegister: 'xpsr',
    memoryRegions: [
      { name: 'SRAM', start: 0x20000000, end: 0x20005000, kind: 'ram' },
      { name: 'Flash', start: 0x08000000, end: 0x08010000, kind: 'flash' },
    ],
  },
  Esp32_S3_CAM: {
    id: 'Esp32_S3_CAM',
    architecture: 'xtensa',
    elfMachine: 94,
    gdbName: 'xtensa-esp-elf-gdb',
    serverName: 'OpenOCD ESP32',
    transport: 'usb-jtag',
    canPatchInstructions: false,
    canAssemble: false,
    registerNames: ['pc', ...Array.from({ length: 16 }, (_, i) => `a${i}`), 'ps', 'sar'],
    stackPointer: 'a1',
    statusRegister: 'ps',
    memoryRegions: [
      { name: 'DRAM', start: 0x3fc88000, end: 0x3fd00000, kind: 'ram' },
      { name: 'IRAM', start: 0x40370000, end: 0x403e0000, kind: 'ram' },
      { name: 'DROM', start: 0x3c000000, end: 0x3e000000, kind: 'flash' },
      { name: 'IROM', start: 0x42000000, end: 0x44000000, kind: 'flash' },
    ],
  },
};

export function getDebuggerProfile(
  boardId: string,
  options?: { transport?: 'usb-jtag' | 'uart-gdb'; stubMode?: 'runtime' | 'panic' },
): DebuggerProfile | undefined {
  const profile = Object.hasOwn(debuggerProfiles, boardId)
    ? debuggerProfiles[boardId as DebuggerProfile['id']]
    : undefined;
  if (profile?.architecture !== 'xtensa' || options?.transport !== 'uart-gdb') return profile;
  const runtime = options.stubMode !== 'panic';
  return {
    ...profile,
    transport: 'uart-gdb',
    serverName: 'UART GDB Stub',
    capabilities: {
      continue: runtime,
      pause: runtime,
      step: runtime,
      breakpoints: runtime,
      memoryRead: true,
    },
  };
}
