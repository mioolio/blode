import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RecentProject } from '../shared/contracts';

/** Local history contains references only; removing a record never changes its project. */
export class RecentProjects {
  constructor(private readonly file: string) {}
  private async paths(): Promise<string[]> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const values = Array.isArray(value.projects) ? value.projects : [value.path];
      return [
        ...new Set<string>(
          values
            .filter((item: unknown): item is string => typeof item === 'string' && path.isAbsolute(item))
            .map((item: string) => path.resolve(item)),
        ),
      ].slice(0, 20);
    } catch {
      return [];
    }
  }
  async list(): Promise<RecentProject[]> {
    return Promise.all(
      (await this.paths()).map(async (root) => ({
        path: root,
        name: path.basename(root),
        available: await fs
          .stat(path.join(root, 'be'))
          .then((s) => s.isFile())
          .catch(() => false),
      })),
    );
  }
  private async write(projects: string[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ path: projects[0] ?? '', projects }, null, 2) + '\n');
    await fs.rename(temporary, this.file);
  }
  async remember(root: string): Promise<void> {
    const resolved = await fs.realpath(root);
    const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
    await this.write(
      [resolved, ...(await this.paths()).filter((p) => key(p) !== key(resolved))].slice(0, 20),
    );
  }
  async remove(root: string): Promise<void> {
    const key = (value: string) =>
      process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    await this.write((await this.paths()).filter((p) => key(p) !== key(root)));
  }
}
