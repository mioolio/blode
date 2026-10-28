import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BuildResult } from '../shared/contracts';
import { safeWorkspacePath } from './workspace';

export interface PersistedBuildState {
  version: 1;
  result: BuildResult;
  sourceFingerprint: string;
  artifactHashes: Record<string, string>;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z
  .object({
    version: z.literal(1),
    sourceFingerprint: digest,
    artifactHashes: z.record(z.string(), digest),
    result: z
      .object({
        success: z.literal(true),
        flashUsed: z.number().int().nonnegative(),
        ramUsed: z.number().int().nonnegative(),
        flashTotal: z.number().int().nonnegative(),
        ramTotal: z.number().int().nonnegative(),
        artifacts: z.array(z.string().max(1024)).min(1).max(64),
        timestamp: z.string().datetime(),
        output: z.string().max(2_000_000),
      })
      .strict(),
  })
  .strict();

/** Cached capacities describe the last actual successful compile, even when sources later change. */
export async function loadBuildState(root: string): Promise<PersistedBuildState | null> {
  try {
    const file = await safeWorkspacePath(root, '.blode/build-state.json', { internal: true });
    if ((await fs.stat(file)).size > 4_000_000) return null;
    const state = schema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    if (Object.keys(state.artifactHashes).length !== state.result.artifacts.length) return null;
    for (const artifact of state.result.artifacts) {
      if (
        !/^(?:firmware\.bin|\.blode\/build\/[^/\\]+\.bin)$/.test(artifact) ||
        !Object.hasOwn(state.artifactHashes, artifact)
      )
        return null;
      await safeWorkspacePath(root, artifact, { internal: true });
    }
    return state;
  } catch {
    return null;
  }
}

export async function saveBuildState(root: string, state: PersistedBuildState): Promise<void> {
  schema.parse(state);
  const file = await safeWorkspacePath(root, '.blode/build-state.json', { internal: true });
  const temporary = await safeWorkspacePath(root, '.blode/build-state.json.tmp', { internal: true });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, file);
}

export async function hashArtifacts(root: string, artifacts: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const artifact of artifacts) {
    const file = await safeWorkspacePath(root, artifact, { internal: true });
    if ((await fs.stat(file)).size > 128 * 1_048_576) throw new Error('error.firmwareTooLarge');
    hashes[artifact] = createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex');
  }
  return hashes;
}

export async function artifactsMatch(root: string, hashes: Record<string, string>): Promise<boolean> {
  try {
    const actual = await hashArtifacts(root, Object.keys(hashes));
    return Object.entries(hashes).every(([file, hash]) => actual[file] === hash);
  } catch {
    return false;
  }
}
