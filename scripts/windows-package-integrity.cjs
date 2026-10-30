'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const inside = (directory, candidate) => {
  const relative = path.relative(directory, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
};

async function ordinaryPath(file, kind) {
  const resolved = path.resolve(file),
    root = path.parse(resolved).root;
  let cursor = root;
  // Checking only the last component would allow an intermediate junction to escape the output root.
  for (const component of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw Error(`Package integrity refuses a linked path: ${cursor}`);
  }
  const stat = await fs.lstat(resolved);
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
    throw Error(`Invalid package ${kind}: ${resolved}`);
  return fs.realpath(resolved);
}

/** These hooks repair only this build's unpacked executables and its reported portable artifact. */
function createPackageIntegrityHooks({
  platform = process.platform,
  projectDir,
  repair = async (files) =>
    (await import('./windows-runtime.mjs')).ensureWindowsRuntimeIntegrity(files, { repair: true }),
  log = console.log,
} = {}) {
  async function outputRoot(context) {
    const project = path.resolve(projectDir || context.packager?.projectDir || repository);
    const configured =
      context.configuration?.directories?.output || context.packager?.config?.directories?.output;
    const raw =
      context.outDir || (typeof configured === 'string' ? path.resolve(project, configured) : undefined);
    if (typeof raw !== 'string' || !path.isAbsolute(raw))
      throw Error('Package integrity requires an absolute build output directory.');
    const output = path.resolve(raw);
    if (output === path.parse(output).root || output === project || inside(output, project))
      throw Error('Package integrity refuses a project root or its parent as build output.');
    return ordinaryPath(output, 'directory');
  }
  async function checkedExecutable(output, candidate) {
    if (!path.isAbsolute(candidate) || !inside(output, path.resolve(candidate)))
      throw Error(`Package executable is outside the build output: ${candidate}`);
    const file = await ordinaryPath(candidate, 'file');
    if (!inside(output, file) || path.extname(file).toLowerCase() !== '.exe')
      throw Error(`Invalid package executable: ${candidate}`);
    return file;
  }
  async function repairFiles(output, candidates) {
    const files = [];
    for (const candidate of [...new Set(candidates)]) files.push(await checkedExecutable(output, candidate));
    if (!files.length) return;
    const result = await repair(files);
    if (
      !Array.isArray(result?.files) ||
      result.files.length !== files.length ||
      result.files.some((file) => !Number.isFinite(file.after) || file.after < 8192)
    )
      throw Error('Windows package integrity verification did not restore all executables.');
    log(
      `Windows package integrity: checked ${files.length}, repaired ${result.files.filter((file) => file.repaired).length}.`,
    );
  }
  return {
    async afterPack(context) {
      if (platform !== 'win32' || context.electronPlatformName !== 'win32') return;
      const output = await outputRoot(context);
      if (
        typeof context.appOutDir !== 'string' ||
        !path.isAbsolute(context.appOutDir) ||
        !inside(output, path.resolve(context.appOutDir))
      )
        throw Error('Unpacked application is outside the build output.');
      const app = await ordinaryPath(context.appOutDir, 'directory');
      if (!inside(output, app)) throw Error('Unpacked application is outside the build output.');
      const directories = [app],
        files = [];
      while (directories.length) {
        const directory = directories.pop();
        await ordinaryPath(directory, 'directory');
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) directories.push(file);
          else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe') files.push(file);
        }
      }
      await repairFiles(output, files);
    },
    async afterAllArtifactBuild(context) {
      if (platform !== 'win32') return [];
      if (
        context.platformToTargets instanceof Map &&
        ![...context.platformToTargets.keys()].some((target) => target?.nodeName === 'win32')
      )
        return [];
      const candidates = (context.artifactPaths || []).filter(
        (file) => typeof file === 'string' && path.extname(file).toLowerCase() === '.exe',
      );
      if (!candidates.length) return [];
      const output = await outputRoot(context);
      // Validate every listed executable before invoking the repair helper, including unrecognised names.
      for (const file of candidates) await checkedExecutable(output, file);
      await repairFiles(
        output,
        candidates.filter((file) =>
          /^Blode\.Studio-[\d.]+-desktop(?:-full)?-win-(?:x64|ia32|arm64)\.exe$/i.test(path.basename(file)),
        ),
      );
      // electron-builder interprets the return value as *additional* artifacts, not an integrity report.
      return [];
    },
  };
}

const hooks = createPackageIntegrityHooks();
module.exports = { ...hooks, createPackageIntegrityHooks };
