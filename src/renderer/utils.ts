export function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${+(value / 1024 / 1024).toFixed(2)} MiB`;
  if (value >= 1024) return `${+(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}
export const hex = (value: number) => `0x${value.toString(16).toUpperCase().padStart(6, '0')}`;
export const percentage = (used: number, total: number) =>
  total > 0 ? Math.min(100, (used / total) * 100) : 0;
