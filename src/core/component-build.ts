import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readComponentManifest } from './components';
import { safeWorkspacePath } from './workspace';
import type { ProjectBuildInputs } from '../shared/contracts';

export async function withComponentBuildInputs(
  root: string,
  build: ProjectBuildInputs,
): Promise<ProjectBuildInputs> {
  const manifest = await readComponentManifest(root);
  if (!manifest.components.length) return build;
  const result: NonNullable<ProjectBuildInputs['components']> = {
    roots: [],
    sources: [],
    includeDirectories: [],
    arduinoLibraries: [],
    inputs: ['blode.components.json'],
  };
  let count = 0;
  for (const component of manifest.components) {
    result.roots.push(component.path);
    const directory = await safeWorkspacePath(root, component.path);
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 24) throw new Error('error.componentTooLarge');
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (
          entry.name.startsWith('.') ||
          ['node_modules', 'build', 'dist'].includes(entry.name.toLowerCase())
        )
          continue;
        if (++count > 20000) throw new Error('error.componentTooLarge');
        if (entry.isSymbolicLink()) throw new Error('error.componentPath');
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile()) {
          const relative = path.relative(root, full).replaceAll('\\', '/');
          await safeWorkspacePath(root, relative);
          result.inputs.push(relative);
        }
      }
    };
    await walk(directory, 0);
    for (const relative of [...component.includes, ...component.sources]) {
      const full = await safeWorkspacePath(root, relative);
      if ((!full.startsWith(directory + path.sep) && full !== directory) || /[\0\r\n"]/.test(full))
        throw new Error('error.componentPath');
      await fs.access(full);
    }
    if (component.kind === 'arduino') result.arduinoLibraries.push(path.posix.dirname(component.path));
    else {
      result.sources.push(...component.sources);
      result.includeDirectories.push(...component.includes);
    }
  }
  for (const key of Object.keys(result) as (keyof typeof result)[])
    result[key] = [...new Set(result[key])].sort();
  return { ...build, components: result };
}
