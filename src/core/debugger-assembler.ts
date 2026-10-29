import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './process';

export interface DebuggerAssemblerTools {
  assembler: string;
  linker: string;
  objcopy: string;
}

/** Use the same GNU distribution as the selected debugger, including custom versions. */
export async function assemblerToolsFromGdb(gdb: string): Promise<DebuggerAssemblerTools> {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const directory = path.dirname(gdb);
  const tools = {
    assembler: path.join(directory, 'arm-none-eabi-as' + suffix),
    linker: path.join(directory, 'arm-none-eabi-ld' + suffix),
    objcopy: path.join(directory, 'arm-none-eabi-objcopy' + suffix),
  };
  for (const file of Object.values(tools)) {
    if (
      !(await fs
        .stat(file)
        .then((entry) => entry.isFile())
        .catch(() => false))
    )
      throw new Error('error.debuggerAssemblerMissing');
  }
  return tools;
}

/** A single Cortex-M3 instruction; never allow assembler directives or literal pools. */
export function validateInstructionSource(address: number, source: string): string {
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xfffffffc || address % 2)
    throw new Error('error.invalidArguments');
  if (
    typeof source !== 'string' ||
    source.length > 256 ||
    /[\r\n\0;@="'`\\:]/.test(source) ||
    !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)?(?:[ \t]+[a-z0-9_.$# ,\[\]{}!+*()\-/<>|&~^\t]+)?$/i.test(
      source.trim(),
    )
  )
    throw new Error('error.debuggerAssemblySingle');
  return source.trim();
}

export function validateThumbInstructionBytes(bytes: Buffer): void {
  if (bytes.length !== 2 && bytes.length !== 4) throw new Error('error.debuggerAssemblySingle');
  const prefix = bytes.readUInt16LE(0) >>> 11;
  const width = prefix === 0b11101 || prefix === 0b11110 || prefix === 0b11111 ? 4 : 2;
  if (bytes.length !== width) throw new Error('error.debuggerAssemblySingle');
}

/** Produce a preview only. The patch transaction separately checks target, bytes and stop state. */
export async function assembleThumbInstruction(
  tools: DebuggerAssemblerTools,
  address: number,
  source: string,
  runner: typeof runCommand = runCommand,
): Promise<string> {
  const instruction = validateInstructionSource(address, source);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-instruction-'));
  try {
    const input = path.join(directory, 'instruction.s');
    const object = path.join(directory, 'instruction.o');
    const elf = path.join(directory, 'instruction.elf');
    const binary = path.join(directory, 'instruction.bin');
    // Express absolute numeric branches relative to this instruction's section.
    // An ABS relocation loses Thumb type information in GNU ld.
    const branch =
      /^(b(?:l)?(?:eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)?(?:\.[nw])?)\s+(0x[0-9a-f]+|\d+)$/i.exec(
        instruction,
      );
    const compareBranch = /^(cbn?z\s+r[0-7]\s*,)\s*(0x[0-9a-f]+|\d+)$/i.exec(instruction);
    const numericBranch = branch ?? compareBranch;
    let body = instruction;
    if (numericBranch) {
      const target = Number(numericBranch[2]);
      if (!Number.isSafeInteger(target) || target < 0 || target > 0xfffffffe || target % 2)
        throw new Error('error.invalidArguments');
      const distance = target - address;
      body = numericBranch[1] + ' . ' + (distance < 0 ? '- ' : '+ ') + Math.abs(distance);
    }
    await fs.writeFile(
      input,
      [
        '.syntax unified',
        '.cpu cortex-m3',
        '.thumb',
        '.text',
        '.global _start',
        '.type _start, %function',
        '.thumb_func',
        '_start:',
        '  ' + body,
        '.size _start, . - _start',
        '',
      ].join('\n'),
    );
    const steps: [string, string[]][] = [
      [tools.assembler, ['-mcpu=cortex-m3', '-mthumb', '--fatal-warnings', '-o', object, input]],
      [tools.linker, ['-Ttext=0x' + address.toString(16), '--entry=_start', '--no-relax', '-o', elf, object]],
      [tools.objcopy, ['-O', 'binary', '-j', '.text', elf, binary]],
    ];
    for (const [executable, args] of steps) {
      const result = await runner(executable, args, { cwd: directory, timeout: 15000 });
      if (result.code !== 0) {
        const details = result.output.replaceAll(directory, '').trim().slice(-4000);
        throw new Error(details || 'error.debuggerAssemblyFailed');
      }
    }
    const size = (await fs.stat(binary)).size;
    if (size !== 2 && size !== 4) throw new Error('error.debuggerAssemblySingle');
    const bytes = await fs.readFile(binary);
    validateThumbInstructionBytes(bytes);
    return bytes.toString('hex');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
