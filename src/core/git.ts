import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import type {
  GitActionRequest,
  GitActionResult,
  GitApi,
  GitFileStatus,
  GitRemote,
  GitStatus,
} from '../shared/git';
import type { LogEvent } from '../shared/contracts';
import { gitActionSchema, gitParameterSchemas } from './git-schemas';

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
interface Options {
  projectRoot(): string | Promise<string>;
  emit?(event: LogEvent): void;
}
interface Repository {
  root: string;
  gitDir?: string;
}
type ManagementMode = 'isolated' | 'shared' | 'disabled';
const ownDirectory = (root: string) => path.join(root, '.blode', 'git');
const managementFile = (root: string) => path.join(root, '.blode', 'git-management.json');
const ignoredInternalPaths = [
  '/.git/',
  '/.blode/git/',
  '/.blode/git-management.json',
  '/.blode/index/',
  '/.blode/build/',
  '/.blode/cache/',
  '/.blode/staging/',
  '/.blode/build-state.json',
];
const internalPath = (file: string) =>
  /^\.blode\/(?:git(?:\/|$)|git-management\.json$|index(?:\/|$)|build(?:\/|$)|cache(?:\/|$)|staging(?:\/|$)|build-state\.json$)/i.test(
    file,
  );
const cleanOutput = (value: string) =>
  value.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@');
const empty = (root: string): GitStatus => ({
  mode: 'disabled',
  ownedHistory: false,
  sharedAvailable: false,
  available: true,
  repository: false,
  projectRoot: root,
  repositoryRoot: '',
  branch: '',
  detached: false,
  upstream: '',
  ahead: 0,
  behind: 0,
  files: [],
  branches: [],
  remotes: [],
  identity: { name: '', email: '' },
  outsideChanges: 0,
  outsideStaged: 0,
});

/** Parse NUL-delimited porcelain v1; renamed records contain destination before source. */
export function parseGitStatus(output: string): {
  files: GitFileStatus[];
  upstream: string;
  ahead: number;
  behind: number;
} {
  const records = output.split('\0');
  const files: GitFileStatus[] = [];
  let upstream = '',
    ahead = 0,
    behind = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('## ')) {
      upstream = /\.\.\.([^\s]+)/.exec(record)?.[1] ?? '';
      ahead = Number(/ahead (\d+)/.exec(record)?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(record)?.[1] ?? 0);
      continue;
    }
    if (record.length < 4 || record[2] !== ' ') throw new Error('error.gitOutput');
    const code = record.slice(0, 2),
      file = record.slice(3);
    const renamed = code.includes('R') || code.includes('C');
    const originalPath = renamed ? records[++index] : undefined;
    if (renamed && !originalPath) throw new Error('error.gitOutput');
    const conflicted = code.includes('U') || ['AA', 'DD'].includes(code);
    const untracked = code === '??';
    files.push({
      path: file,
      ...(originalPath ? { originalPath } : {}),
      index: code[0],
      worktree: code[1],
      code: conflicted
        ? '!'
        : untracked
          ? 'U'
          : ((code.replaceAll(' ', '')[0] ?? 'M') as GitFileStatus['code']),
      staged: !untracked && code[0] !== ' ',
      unstaged: untracked || code[1] !== ' ',
      conflicted,
    });
  }
  return { files, upstream, ahead, behind };
}

/** Owned git subprocesses, explicit argument arrays, no shell or terminal credential prompts. */
async function runGit(
  target: string | Repository,
  args: string[],
  input?: string,
  timeout = 30_000,
): Promise<Result> {
  const repository = typeof target === 'string' ? { root: target } : target;
  // An IDE started from another repository must not inherit its GIT_DIR/index.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  if (repository.gitDir) {
    environment.GIT_CONFIG_NOSYSTEM = '1';
    environment.GIT_CONFIG_GLOBAL = path.join(repository.gitDir, 'blode-empty-global-config');
    environment.GIT_ATTR_NOSYSTEM = '1';
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '--literal-pathspecs',
        '-c',
        'color.ui=false',
        '-c',
        `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'tag.gpgSign=false',
        ...(repository.gitDir ? [`--git-dir=${repository.gitDir}`, `--work-tree=${repository.root}`] : []),
        '-C',
        repository.root,
        ...args,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...environment,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
          GIT_PAGER: 'cat',
          LC_ALL: 'C.UTF-8',
        },
      },
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0,
      settled = false;
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('error.gitTimeout')), timeout);
    const collect = (store: Buffer[], data: Buffer) => {
      bytes += data.length;
      if (bytes > 4_000_000) fail(new Error('rpc.limitExceeded'));
      else store.push(data);
    };
    child.stdout.on('data', (data: Buffer) => collect(stdout, data));
    child.stderr.on('data', (data: Buffer) => collect(stderr, data));
    child.on('error', (error: NodeJS.ErrnoException) =>
      fail(new Error(error.code === 'ENOENT' ? 'error.gitMissing' : error.message)),
    );
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function relativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized === '.blode' ||
    internalPath(normalized) ||
    /[\0\r\n:]/.test(normalized) ||
    normalized
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new Error('error.invalidPath');
  return normalized;
}
function safeUrl(value: string): string {
  if (/[\0\r\n]/.test(value) || value.startsWith('-') || value.startsWith('ext::'))
    throw new Error('error.gitRemoteUrl');
  if (path.isAbsolute(value)) return value;
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:', 'ssh:'].includes(url.protocol) ||
      url.password ||
      (url.username && url.protocol !== 'ssh:')
    )
      throw new Error();
    return value;
  } catch {
    throw new Error('error.gitRemoteUrl');
  }
}

/** Git operates on the target host, with a serialized owner per open service. */
export class GitService implements GitApi {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: Options) {}
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async root() {
    const requested = await this.options.projectRoot();
    if (!requested) throw new Error('error.noWorkspace');
    return fs.realpath(requested);
  }
  private emit(message: string, level: LogEvent['level'] = 'info') {
    this.options.emit?.({
      kind: 'status',
      level,
      message: cleanOutput(message),
      time: new Date().toISOString(),
    });
  }
  private async storage(root: string, create = false) {
    const directory = path.join(root, '.blode');
    const info = await fs.lstat(directory).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('error.invalidPath');
    if (!info && create) await fs.mkdir(directory);
    return directory;
  }
  private async owned(root: string): Promise<boolean> {
    await this.storage(root);
    const directory = ownDirectory(root);
    const info = await fs.lstat(directory).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
      throw new Error('error.invalidPath');
    const marker = path.join(directory, 'blode-owner.json');
    const markerInfo = await fs.lstat(marker).catch(() => null);
    if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) throw new Error('error.gitOwnership');
    const owner = JSON.parse(await fs.readFile(marker, 'utf8'));
    if (owner.kind !== 'blode-git' || owner.version !== 1) throw new Error('error.gitOwnership');
    return true;
  }
  private async mode(root: string): Promise<ManagementMode> {
    await this.storage(root);
    const file = managementFile(root);
    const info = await fs.lstat(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!info) return (await this.owned(root)) ? 'isolated' : 'disabled';
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('error.invalidPath');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.version !== 1 || !['isolated', 'shared', 'disabled'].includes(value.mode))
      throw new Error('error.gitManagement');
    return value.mode;
  }
  private async saveMode(root: string, mode: ManagementMode) {
    await this.storage(root, true);
    await this.mode(root); // Reject a linked or malformed existing settings file.
    await fs.writeFile(managementFile(root), JSON.stringify({ version: 1, mode }) + '\n', 'utf8');
  }
  private async externalRepo(root: string): Promise<Repository> {
    const repo = await runGit(root, ['rev-parse', '--show-toplevel']);
    if (repo.code !== 0)
      throw new Error(
        /not (?:a git|a) repository/i.test(repo.stderr)
          ? 'error.gitNotRepository'
          : cleanOutput(repo.stderr.trim() || 'error.gitFailed'),
      );
    return { root: await fs.realpath(repo.stdout.trim()) };
  }
  private async requireRepo(root: string): Promise<Repository> {
    const mode = await this.mode(root);
    if (mode === 'shared') return this.externalRepo(root);
    if (mode !== 'isolated' || !(await this.owned(root))) throw new Error('error.gitNotRepository');
    return { root, gitDir: ownDirectory(root) };
  }
  private async checked(root: string | Repository, args: string[], input?: string, timeout?: number) {
    const result = await runGit(root, args, input, timeout);
    if (result.code !== 0)
      throw new Error(cleanOutput(result.stderr.trim() || result.stdout.trim() || 'error.gitFailed'));
    return result;
  }
  private async statusNow(root: string): Promise<GitStatus> {
    const state = empty(root);
    state.mode = await this.mode(root);
    state.ownedHistory = await this.owned(root);
    try {
      await this.externalRepo(root);
      state.sharedAvailable = true;
    } catch (error) {
      if (error instanceof Error && error.message === 'error.gitMissing')
        return { ...state, available: false };
      if (!(error instanceof Error && error.message === 'error.gitNotRepository')) throw error;
    }
    let repository: Repository;
    try {
      repository = await this.requireRepo(root);
    } catch (error) {
      if (error instanceof Error && error.message === 'error.gitMissing')
        return { ...state, available: false };
      if (error instanceof Error && error.message === 'error.gitNotRepository') return state;
      throw error;
    }
    state.repository = true;
    state.repositoryRoot = repository.root;
    const [status, branch, branches, remotes, name, email] = await Promise.all([
      this.checked(repository, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']),
      runGit(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.checked(repository, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']),
      runGit(repository, ['config', '--null', '--get-regexp', '^remote\..*\.(url|pushurl)$']),
      runGit(repository, ['config', '--get', 'user.name']),
      runGit(repository, ['config', '--get', 'user.email']),
    ]);
    const parsed = parseGitStatus(status.stdout);
    const prefix = path.relative(repository.root, root).replaceAll('\\', '/');
    const relative = (file: string) => (prefix ? path.posix.relative(prefix, file) : file);
    const outside = (file: string) => file.startsWith('../') || file === '..';
    for (const file of parsed.files) {
      const scoped = relative(file.path);
      if (internalPath(scoped)) continue;
      const original = file.originalPath ? relative(file.originalPath) : undefined;
      if (outside(scoped)) {
        state.outsideChanges++;
        if (file.staged) state.outsideStaged++;
        continue;
      }
      if (original && outside(original)) {
        state.outsideChanges++;
        if (file.staged) state.outsideStaged++;
      }
      state.files.push({
        ...file,
        path: scoped,
        ...(original ? { originalPath: original } : {}),
      });
    }
    state.branch = branch.stdout.trim();
    state.detached = branch.code !== 0;
    state.upstream = parsed.upstream;
    state.ahead = parsed.ahead;
    state.behind = parsed.behind;
    state.branches = branches.stdout.split(/\r?\n/).filter(Boolean);
    if (state.branch && !state.branches.includes(state.branch)) state.branches.unshift(state.branch);
    state.identity = { name: name.stdout.trim(), email: email.stdout.trim() };
    const values = new Map<string, GitRemote>();
    for (const record of remotes.stdout.split('\0')) {
      const split = record.indexOf('\n');
      if (split < 0) continue;
      const key = record.slice(0, split),
        url = cleanOutput(record.slice(split + 1));
      const match = /^remote\.(.+)\.(url|pushurl)$/.exec(key);
      if (!match) continue;
      const remote = values.get(match[1]) ?? { name: match[1], fetchUrl: '', pushUrl: '' };
      if (match[2] === 'url') remote.fetchUrl = url;
      else remote.pushUrl = url;
      values.set(match[1], remote);
    }
    state.remotes = [...values.values()].map((remote) => ({
      ...remote,
      pushUrl: remote.pushUrl || remote.fetchUrl,
    }));
    return state;
  }
  gitStatus() {
    return this.exclusive(async () => this.statusNow(await this.root()));
  }
  gitDiff(input: { path: string; staged?: boolean }) {
    return this.exclusive(async () => {
      const request = gitParameterSchemas['git.diff'].parse(input),
        root = await this.root(),
        repository = await this.requireRepo(root);
      const relative = relativePath(request.path),
        repoPath = path.relative(repository.root, path.join(root, relative)).replaceAll('\\', '/');
      const status = await this.statusNow(root),
        entry = status.files.find((file) => file.path === relative);
      if (entry?.code === 'U' && !request.staged) {
        const target = path.join(root, relative),
          info = await fs.lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) return 'git.untrackedPreviewUnavailable';
        if (info.size > 500_000) throw new Error('rpc.limitExceeded');
        const text = await fs.readFile(target, 'utf8');
        if (text.includes('\0')) return 'git.binaryPreview';
        return `+++ ${relative}\n${text
          .split('\n')
          .map((line) => '+' + line)
          .join('\n')}`;
      }
      return (
        await this.checked(repository, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          ...(request.staged ? ['--cached'] : []),
          '--',
          repoPath,
        ])
      ).stdout;
    });
  }
  gitAction(input: GitActionRequest): Promise<GitActionResult> {
    return this.exclusive(async () => {
      const request = gitActionSchema.parse(input),
        root = await this.root();
      this.emit(`status.gitStarted ${request.action}`);
      let output = '';
      try {
        if (request.action === 'init') {
          await this.storage(root, true);
          if (!(await this.owned(root))) {
            const directory = ownDirectory(root);
            await fs.mkdir(directory);
            await fs.writeFile(
              path.join(directory, 'blode-owner.json'),
              JSON.stringify({ kind: 'blode-git', version: 1 }),
              { flag: 'wx' },
            );
          }
          const directory = ownDirectory(root);
          output = (
            await this.checked({ root, gitDir: directory }, [
              '-c',
              'init.templateDir=',
              'init',
              '--initial-branch=main',
            ])
          ).stdout;
          const exclude = path.join(directory, 'info', 'exclude');
          await fs.mkdir(path.dirname(exclude), { recursive: true });
          const existing = await fs.readFile(exclude, 'utf8').catch(() => '');
          await fs.writeFile(
            exclude,
            existing +
              '\n' +
              ignoredInternalPaths.filter((entry) => !existing.split(/\r?\n/).includes(entry)).join('\n') +
              '\n',
          );
          await this.saveMode(root, 'isolated');
        } else if (request.action === 'setMode') {
          if (request.mode === 'shared') await this.externalRepo(root);
          if (request.mode === 'isolated' && !(await this.owned(root)))
            throw new Error('error.gitNotRepository');
          await this.saveMode(root, request.mode);
        } else if (request.action === 'removeRepository') {
          if (request.target === 'isolated') {
            if (!(await this.owned(root))) throw new Error('error.gitNotRepository');
            const directory = ownDirectory(root);
            // Only the verified software-owned metadata directory is removed.
            if (path.dirname(directory) !== path.join(root, '.blode') || path.basename(directory) !== 'git')
              throw new Error('error.invalidPath');
            await fs.rm(directory, { recursive: true });
            if ((await this.mode(root)) !== 'shared') await this.saveMode(root, 'disabled');
          } else {
            if ((await this.mode(root)) !== 'shared') throw new Error('error.gitSharedConfirmation');
            const repository = await this.externalRepo(root);
            if (
              !request.repositoryRoot ||
              !path.isAbsolute(request.repositoryRoot) ||
              (await fs.realpath(request.repositoryRoot)) !== repository.root
            )
              throw new Error('error.gitSharedConfirmation');
            const directory = path.join(repository.root, '.git');
            const info = await fs.lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
              throw new Error('error.gitLinkedRepository');
            for (const lock of ['index.lock', 'config.lock', 'HEAD.lock'])
              if (await fs.lstat(path.join(directory, lock)).catch(() => null))
                throw new Error('error.gitRepositoryBusy');
            await fs.rm(directory, { recursive: true });
            await this.saveMode(root, 'disabled');
          }
        } else {
          const repository = await this.requireRepo(root);
          if (request.action === 'stage' || request.action === 'unstage') {
            const paths = request.paths.map(relativePath);
            if (request.action === 'unstage') {
              const state = await this.statusNow(root);
              for (const file of state.files) {
                if (!paths.includes(file.path) || !file.originalPath) continue;
                if (file.originalPath.startsWith('../')) throw new Error('error.gitOutsideStaged');
                paths.push(relativePath(file.originalPath));
              }
            }
            const files = [
              ...new Set(
                paths.map((value) =>
                  path.relative(repository.root, path.join(root, value)).replaceAll('\\', '/'),
                ),
              ),
            ];
            const unborn = (await runGit(repository, ['rev-parse', '--verify', 'HEAD'])).code !== 0;
            for (let index = 0; index < files.length;) {
              const batch: string[] = [];
              let length = 0;
              while (index < files.length && length + files[index].length < 20000) {
                const file = files[index++];
                batch.push(file);
                length += file.length + 1;
              }
              if (!batch.length) throw new Error('rpc.limitExceeded');
              const args =
                request.action === 'stage'
                  ? ['add', '--', ...batch]
                  : unborn
                    ? ['rm', '--cached', '--ignore-unmatch', '--', ...batch]
                    : ['restore', '--staged', '--', ...batch];
              const result = await this.checked(repository, args);
              output += result.stdout + result.stderr;
            }
          } else if (request.action === 'commit') {
            const state = await this.statusNow(root);
            if (state.outsideStaged) throw new Error('error.gitOutsideStaged');
            if (state.files.some((file) => file.conflicted)) throw new Error('error.gitConflicts');
            if (!(await runGit(repository, ['diff', '--cached', '--quiet'])).code)
              throw new Error('error.gitNothingStaged');
            const result = await this.checked(repository, ['commit', '--file=-'], request.message, 120_000);
            output = result.stdout + result.stderr;
          } else if (request.action === 'createBranch' || request.action === 'checkout') {
            await this.checked(repository, ['check-ref-format', '--branch', request.branch]);
            const result = await this.checked(
              repository,
              request.action === 'createBranch'
                ? ['switch', '-c', request.branch]
                : ['switch', '--', request.branch],
            );
            output = result.stdout + result.stderr;
          } else if (request.action === 'configure') {
            if (
              /[\r\n\0<>]/.test(request.name) ||
              /[\r\n\0<>\s]/.test(request.email) ||
              !request.email.includes('@')
            )
              throw new Error('rpc.invalidParams');
            await this.checked(repository, ['config', '--local', 'user.name', request.name]);
            await this.checked(repository, ['config', '--local', 'user.email', request.email]);
          } else if (request.action === 'remoteSet') {
            const url = safeUrl(request.url),
              names = (await this.checked(repository, ['remote'])).stdout.split(/\r?\n/);
            await this.checked(repository, [
              'remote',
              names.includes(request.name) ? 'set-url' : 'add',
              request.name,
              url,
            ]);
          } else if (request.action === 'remoteRemove')
            await this.checked(repository, ['remote', 'remove', request.name]);
          else {
            const names = (await this.checked(repository, ['remote'])).stdout.split(/\r?\n/);
            if (!names.includes(request.remote)) throw new Error('error.gitRemoteMissing');
            if (request.action === 'fetch') {
              const result = await this.checked(
                repository,
                ['fetch', '--prune', '--', request.remote],
                undefined,
                120_000,
              );
              output = result.stdout + result.stderr;
            } else {
              const branch = request.branch || (await this.statusNow(root)).branch;
              if (!branch) throw new Error('error.gitSelectBranch');
              await this.checked(repository, ['check-ref-format', '--branch', branch]);
              const args =
                request.action === 'pull'
                  ? ['pull', '--ff-only', '--no-rebase', '--', request.remote, branch]
                  : [
                      'push',
                      '--porcelain',
                      '--set-upstream',
                      '--',
                      request.remote,
                      `HEAD:refs/heads/${branch}`,
                    ];
              const result = await this.checked(repository, args, undefined, 120_000);
              output = result.stdout + result.stderr;
            }
          }
        }
        output = cleanOutput(output);
        if (output.trim()) for (const line of output.trim().split(/\r?\n/).slice(-100)) this.emit(line);
        this.emit('status.gitSucceeded', 'success');
        return { status: await this.statusNow(root), output };
      } catch (error) {
        this.emit(error instanceof Error ? error.message : String(error), 'error');
        throw error;
      } finally {
        this.emit('status.gitChanged');
      }
    });
  }
}

export function createGitRoutes(service: GitService) {
  const routes: Record<string, { args: z.ZodType; run: (...args: any[]) => unknown }> = {
    gitStatus: { args: z.tuple([]), run: () => service.gitStatus() },
    gitDiff: { args: z.tuple([gitParameterSchemas['git.diff']]), run: (request) => service.gitDiff(request) },
    gitAction: { args: z.tuple([gitActionSchema]), run: (request) => service.gitAction(request) },
  };
  return {
    routes,
    async invoke(method: string, args: unknown[]) {
      if (!Object.hasOwn(routes, method)) throw new Error('rpc.methodNotFound');
      const route = routes[method],
        parsed = route.args.safeParse(args);
      if (!parsed.success) throw new Error('rpc.invalidParams');
      return route.run(...(parsed.data as unknown[]));
    },
  };
}
