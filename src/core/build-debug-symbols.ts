import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BuildResult, ProjectConfig } from '../shared/contracts';
import type { CoreService } from './service';
import { getBoardAdapter } from '../../extensions/registry';
import { getDebuggerProfile } from '../shared/debugger-profiles';
import { artifactsMatch, loadBuildState, type PersistedBuildState } from './build-state';
import { safeWorkspacePath } from './workspace';
import { prepareBuildExport } from './firmware';

export interface AutomaticDebugSymbols {
  id: string;
  name: string;
  bytes: Buffer;
}
export type AutomaticDebugSymbolResolver = (config: ProjectConfig) => Promise<AutomaticDebugSymbols | null>;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function profileFor(boardId: string) {
  return (
    getDebuggerProfile(boardId) ??
    getDebuggerProfile(getBoardAdapter(boardId).definition.runtimePlugin?.compiler.baseRuntime ?? '')
  );
}
async function readElf(root: string, relative: string, machine: number) {
  const file = await safeWorkspacePath(root, relative, { internal: true });
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 52 || stat.size > 128 * 1024 * 1024) return null;
  const bytes = await fs.readFile(file);
  return bytes.length === stat.size &&
    bytes.subarray(0, 4).toString('hex') === '7f454c46' &&
    bytes[4] === 1 &&
    bytes[5] === 1 &&
    bytes.readUInt16LE(18) === machine
    ? bytes
    : null;
}

/** Capture the compiler's companion ELF while the successful build owns the operation lock. */
export async function captureBuildDebugSymbols(
  root: string,
  result: BuildResult,
  boardId: string,
): Promise<PersistedBuildState['debugSymbols']> {
  try {
    const profile = profileFor(boardId);
    if (!profile || !result.success) return;
    const application = result.artifacts.find((file) =>
      profile.architecture === 'xtensa'
        ? file.endsWith('.ino.bin')
        : /(?:^|\/)firmware\.bin$/.test(file) && file.startsWith('.blode/'),
    );
    if (!application) return;
    const file = application.replace(/\.bin$/, '.elf'),
      bytes = await readElf(root, file, profile.elfMachine);
    if (bytes) return { file, sha256: sha256(bytes) };
  } catch {}
}

/** Desktop and Web hosts resolve symbols from the same verified build identity. */
export async function resolveBuildDebugSymbols(
  core: Pick<CoreService, 'getState' | 'currentProjectRoot'>,
  selection: ProjectConfig,
): Promise<AutomaticDebugSymbols | null> {
  try {
    const state = await core.getState();
    if (!state.workspaceOpen || !state.lastBuild?.success || state.buildStale) return null;
    const config = state.buildTarget?.config ?? state.config;
    const builtProfile = profileFor(config.boardId),
      selectedProfile = profileFor(selection.boardId);
    if (!builtProfile || builtProfile.id !== selectedProfile?.id) return null;
    const root =
      state.buildTarget?.root && state.buildTarget.root !== '.'
        ? await safeWorkspacePath(state.projectRoot, state.buildTarget.root)
        : state.projectRoot;
    const saved = await loadBuildState(root, state.buildTarget?.stateFile);
    if (
      !saved ||
      saved.result.timestamp !== state.lastBuild.timestamp ||
      !(await artifactsMatch(root, saved.artifactHashes))
    )
      return null;
    let bytes: Buffer | null, file: string;
    if (saved.debugSymbols) {
      file = saved.debugSymbols.file;
      bytes = await readElf(root, file, builtProfile.elfMachine);
      if (!bytes || sha256(bytes) !== saved.debugSymbols.sha256) return null;
    } else {
      // Old Cortex-M caches can still be matched byte-for-byte against their compiled image.
      if (builtProfile.architecture !== 'arm-thumb') return null;
      file = `${state.buildTarget?.buildDirectory ?? '.blode/build'}/firmware.elf`;
      bytes = (await prepareBuildExport(state.projectRoot, state, 'elf')).data;
    }
    if (core.currentProjectRoot() !== state.projectRoot) return null;
    return {
      id: JSON.stringify([
        state.projectRoot,
        state.buildTarget?.id ?? '',
        saved.result.timestamp,
        sha256(bytes),
      ]),
      name: path.posix.basename(file),
      bytes,
    };
  } catch {
    return null;
  }
}
