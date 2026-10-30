import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assembleThumbInstruction,
  assemblerToolsFromGdb,
  validateInstructionSource,
  validateThumbInstructionBytes,
} from '../src/core/debugger-assembler';
import type { runCommand } from '../src/core/process';

describe('single-instruction assembly preview', () => {
  it('accepts instructions and rejects directives, multiple instructions and odd addresses', () => {
    for (const source of ['nop', 'movs r0, #1', 'b.w 0x20000010', 'push {r4-r7, lr}', 'ldr r0, [r1, #4]'])
      assert.equal(validateInstructionSource(0x20000000, source), source);
    for (const source of [
      '',
      '.include "secret"',
      'nop\n.word 1',
      'nop; nop',
      'label: nop',
      'ldr r0, =123',
      'nop\rnop',
      'nop\0',
    ])
      assert.throws(() => validateInstructionSource(0x20000000, source));
    assert.throws(() => validateInstructionSource(0x20000001, 'nop'));
    assert.throws(() => validateInstructionSource(0xffffffff, 'nop'));
  });
  it('rejects a literal pool or two short instructions disguised as one wide instruction', () => {
    validateThumbInstructionBytes(Buffer.from('00bf', 'hex'));
    validateThumbInstructionBytes(Buffer.from('00f006b8', 'hex'));
    for (const hex of ['00', '00bf00bf', '00f0', '00f0008000bf'])
      assert.throws(() => validateThumbInstructionBytes(Buffer.from(hex, 'hex')));
  });
  it('links at the target address, preserves argument boundaries and removes temporary files', async () => {
    const calls: { executable: string; args: string[] }[] = [];
    let temporary = '';
    const runner: typeof runCommand = async (executable, args, options) => {
      calls.push({ executable, args });
      temporary = options?.cwd ?? '';
      if (executable === 'as') assert.match(await fs.readFile(args.at(-1)!, 'utf8'), /\n  b\.w \. \+ 16\n/);
      if (executable === 'copy') await fs.writeFile(args.at(-1)!, Buffer.from('00f006b8', 'hex'));
      return { code: 0, output: '' };
    };
    assert.equal(
      await assembleThumbInstruction(
        { assembler: 'as', linker: 'ld', objcopy: 'copy' },
        0x20000000,
        'b.w 0x20000010',
        runner,
      ),
      '00f006b8',
    );
    assert.ok(calls[1].args.includes('-Ttext=0x20000000'));
    assert.equal(calls.length, 3);
    await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
  });
  it('returns compiler diagnostics and cleans up on failure without running later tools', async () => {
    let temporary = '';
    let calls = 0;
    const runner: typeof runCommand = async (_executable, _args, options) => {
      temporary = options!.cwd!;
      calls++;
      return { code: 1, output: temporary + '/instruction.s: bad instruction' };
    };
    await assert.rejects(
      assembleThumbInstruction(
        { assembler: 'as', linker: 'ld', objcopy: 'copy' },
        0x20000000,
        'nonsense',
        runner,
      ),
      /bad instruction/,
    );
    assert.equal(calls, 1);
    await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
  });
  it('assembles real GNU Thumb opcodes and rejects unresolved functions', async (context) => {
    const gdb = path.resolve(
      'tools/armgcc/bin/arm-none-eabi-gdb' + (process.platform === 'win32' ? '.exe' : ''),
    );
    const tools = await assemblerToolsFromGdb(gdb).catch(() => undefined);
    if (!tools) return context.skip('Local GNU Arm tools are not installed');
    assert.equal(await assembleThumbInstruction(tools, 0x20000000, 'nop'), '00bf');
    assert.equal(await assembleThumbInstruction(tools, 0x20000000, 'movs r0, #1'), '0120');
    assert.equal(await assembleThumbInstruction(tools, 0x20000000, 'b.w 0x20000010'), '00f006b8');
    assert.equal(await assembleThumbInstruction(tools, 0x20000004, 'b.w 0x20000010'), '00f004b8');
    assert.equal(await assembleThumbInstruction(tools, 0x20000000, 'beq.n 0x20000010'), '06d0');
    assert.equal(await assembleThumbInstruction(tools, 0x20000000, 'cbz r0, 0x20000010'), '30b1');
    assert.equal(await assembleThumbInstruction(tools, 0x20000000, 'bl 0x20000010'), '00f006f8');
    assert.equal(await assembleThumbInstruction(tools, 0x20000004, 'b.n 0x20000000'), 'fce7');
    await assert.rejects(
      assembleThumbInstruction(tools, 0x20000000, 'bl unresolved_function'),
      /undefined reference/,
    );
  });
});
