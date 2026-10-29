export function breakpointLocations(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function machineCodeBytes(text: string): string | null {
  const value = text.replace(/\s/g, '').toLowerCase();
  return /^(?:[0-9a-f]{4}|[0-9a-f]{8})$/.test(value) ? value : null;
}

export function instructionAssembly(text: string): string {
  return text
    .replace(/\s*<[^>]*>/g, '')
    .split(/[;@]/, 1)[0]
    .trim();
}

export function canPatchInstruction(address: number, expected: string | undefined): boolean {
  const code = machineCodeBytes(expected ?? '');
  return (
    !!code &&
    Number.isInteger(address) &&
    address % 2 === 0 &&
    address >= 0x20000000 &&
    address + code.length / 2 <= 0x20005000
  );
}

export function validMemoryRange(address: string, length: number): boolean {
  if (!address.trim()) return false;
  const value = Number(address);
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff &&
    Number.isInteger(length) &&
    length >= 1 &&
    length <= 4096 &&
    value + length <= 0x100000000
  );
}
