/** AC5 update/build are retained for reproducible compiler selection. */
export function armccVersion(output: string): string {
  const full = /ARM Compiler\s+(\d+\.\d+(?:\.\d+)?)\s+update\s+(\d+)\s*\(build\s+(\d+)\)/i.exec(output);
  return full
    ? `${full[1]}-u${full[2]}-b${full[3]}`
    : (/ARM Compiler\s+(\d+\.\d+(?:\.\d+)?)/i.exec(output)?.[1] ?? '');
}
