export function releaseVersions(input: string): { version: string; releaseVersion: string };
export function releaseNotes(version: string, changelog: string, date: string): string;
export function buildRelease(
  input: string,
): Promise<{ directory: string; files: { name: string; bytes: number; sha256: string }[] }>;
