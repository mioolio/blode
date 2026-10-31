import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const candidates = [
  '.blode/build/compile_commands.json',
  'build/compile_commands.json',
  'compile_commands.json',
];

interface Entry {
  directory?: string;
  file?: string;
  arguments?: string[];
  command?: string;
}

/**
 * Build systems (Arduino CLI, CMake, Keil exporters) already know the real
 * compiler flags. Reusing their compilation database is more reliable than
 * inventing target/define/include heuristics in the language service.
 */
export async function prepareExternalCompilationDatabase(options: {
  root: string;
  files: readonly { path: string }[];
  dataRoot: string;
}): Promise<{ directory: string; fallbackFlags: string[] } | null> {
  for (const candidate of candidates) {
    const source = path.join(options.root, candidate);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(source, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || !parsed.length) continue;
    const entries: Entry[] = [];
    for (const raw of parsed.slice(0, MAX_ENTRIES)) {
      if (!raw || typeof raw !== 'object') continue;
      const value = raw as Entry;
      if (typeof value.file !== 'string' || !value.file) continue;
      const directory =
        typeof value.directory === 'string' && value.directory
          ? path.resolve(options.root, value.directory)
          : options.root;
      const file = path.isAbsolute(value.file) ? value.file : path.resolve(directory, value.file);
      if (Array.isArray(value.arguments) && value.arguments.every((arg) => typeof arg === 'string'))
        entries.push({ directory, file, arguments: value.arguments });
      else if (typeof value.command === 'string' && value.command)
        entries.push({ directory, file, command: value.command });
    }
    if (!entries.length) continue;

    // Arduino compiles a preprocessed copy of the sketch. Reuse that real
    // command for the editable .ino so navigation still sees the actual
    // Arduino core, libraries and compiler defines.
    const sketchTemplate = entries.find(
      (entry) => entry.arguments && entry.file?.toLowerCase().endsWith('.ino.cpp'),
    );
    if (sketchTemplate?.arguments) {
      for (const file of options.files) {
        if (!file.path.toLowerCase().endsWith('.ino')) continue;
        const absolute = path.resolve(options.root, file.path);
        if (entries.some((entry) => entry.file === absolute)) continue;
        const args: string[] = [...sketchTemplate.arguments];
        const sourceIndex = args.lastIndexOf(sketchTemplate.file!);
        if (sourceIndex < 0) continue;
        args[sourceIndex] = absolute;
        if (!args.includes('-x')) args.splice(1, 0, '-x', 'c++');
        entries.push({ directory: sketchTemplate.directory, file: absolute, arguments: args });
      }
    }

    const text = JSON.stringify(entries);
    const key = createHash('sha256')
      .update(options.root)
      .update('\0')
      .update(text)
      .digest('hex')
      .slice(0, 16);
    const directory = path.join(options.dataRoot, 'clangd', `db-${key}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'compile_commands.json'), text);
    return { directory, fallbackFlags: [] };
  }
  return null;
}
