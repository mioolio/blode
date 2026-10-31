import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import type { ToolPackageResult } from '../shared/tool-versions';
const schema = z
  .object({
    id: z.string().uuid(),
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\\/:\0-\x1f]+\.zip$/),
    size: z.number().int().positive().max(3_900_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    toolId: z.string().max(128),
    platform: z.string().max(32),
    arch: z.string().max(32),
  })
  .strict();
export async function readToolPackages(dataRoot: string): Promise<ToolPackageResult[]> {
  const root = path.join(dataRoot, 'exports'),
    result: ToolPackageResult[] = [];
  for (const name of (await fs.readdir(root).catch(() => []))
    .filter((name) => /^[a-f0-9-]{36}\.tool\.json$/.test(name))
    .slice(0, 256))
    try {
      const file = path.join(root, name),
        stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) continue;
      const record = schema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      if (name !== record.id + '.tool.json') continue;
      const zip = await fs.lstat(path.join(root, record.id + '.zip'));
      if (zip.isFile() && !zip.isSymbolicLink() && zip.size === record.size) result.push(record);
    } catch {}
  return result;
}
export async function toolPackageFile(dataRoot: string, id: string) {
  const record = (await readToolPackages(dataRoot)).find((item) => item.id === id);
  if (!record) throw new Error('error.packageExpired');
  return { path: path.join(dataRoot, 'exports', record.id + '.zip'), name: record.name };
}
