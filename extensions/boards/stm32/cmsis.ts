/** Migrate only CMSIS 1.30's four legacy GCC naked helpers to basic asm. */
export function migrateLegacyCmsis(source: string, assembler = '__ASM'): string | null {
  if (!/@version\s+V1\.30/.test(source)) return null;
  const start = source.indexOf('#elif (defined (__GNUC__))');
  const end = source.indexOf('#elif (defined (__TASKING__))', start);
  if (start < 0 || end < 0) return null;
  let branch = source.slice(start, end);
  let replaced = 0;
  for (const register of ['PSP', 'MSP'])
    for (const op of ['get', 'set']) {
      const signature =
        op === 'get' ? `uint32_t __get_${register}\\(void\\)` : `void __set_${register}\\(uint32_t \\w+\\)`;
      const re = new RegExp(`${signature}\\s*\\{[^}]*\\}`, 'g');
      branch = branch.replace(re, (original) => {
        if (!original.includes('BX  lr') || !original.includes('__ASM volatile')) return original;
        replaced++;
        return `${original.slice(0, original.indexOf('{'))}{ ${assembler} volatile ("${op === 'get' ? 'MRS r0, ' + register.toLowerCase() : 'MSR ' + register.toLowerCase() + ', r0'}\\n\\tBX lr"); }`;
      });
    }
  return replaced === 4 ? source.slice(0, start) + branch + source.slice(end) : null;
}
