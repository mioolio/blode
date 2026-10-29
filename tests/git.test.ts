import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitService, parseGitStatus } from '../src/core/git';
import { gitActionSchema } from '../src/core/git-schemas';

const exec = promisify(execFile);
async function git(root: string, args: string[]) {
  return (
    await exec('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 4_000_000 })
  ).stdout.trim();
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-git-'));
  const repo = path.join(root, 'work');
  await fs.mkdir(repo);
  await git(repo, ['-c', 'init.templateDir=', 'init', '--initial-branch=main']);
  const hooks = path.join(root, 'empty-hooks');
  await fs.mkdir(hooks);
  await git(repo, ['config', '--local', 'core.hooksPath', hooks]);
  await git(repo, ['config', '--local', 'commit.gpgSign', 'false']);
  await git(repo, ['config', '--local', 'core.autocrlf', 'false']);
  const service = new GitService({ projectRoot: () => repo });
  await service.gitAction({ action: 'setMode', mode: 'shared', confirm: true });
  await service.gitAction({ action: 'configure', name: 'Test Author', email: 'test@example.invalid' });
  const cleanup = async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^blode-git-/);
    await fs.rm(root, { recursive: true, force: true });
  };
  return { root, repo, service, hooks, cleanup };
}

test('porcelain parsing preserves spaces, UTF16 names and rename destination/source order', () => {
  const result = parseGitStatus(
    '## main...origin/main [ahead 2, behind 1]\0 M 源码/a b.c\0?? src/[new].c\0R  renamed.c\0old name.c\0UU conflict.c\0',
  );
  assert.equal(result.upstream, 'origin/main');
  assert.equal(result.ahead, 2);
  assert.equal(result.behind, 1);
  assert.deepEqual(
    result.files.map((file) => [file.path, file.code]),
    [
      ['源码/a b.c', 'M'],
      ['src/[new].c', 'U'],
      ['renamed.c', 'R'],
      ['conflict.c', '!'],
    ],
  );
  assert.equal(result.files[2].originalPath, 'old name.c');
  assert.equal(result.files[3].conflicted, true);
});

test('Git GUI operations stage literal paths, commit, unstage, diff and create/switch branches', async () => {
  const context = await fixture();
  const { repo, service } = context;
  try {
    await fs.mkdir(path.join(repo, 'src'));
    await fs.writeFile(path.join(repo, 'src', '设备 main.c'), 'int main(void) { return 0; }\n');
    await fs.writeFile(path.join(repo, 'src', '[one].c'), 'int one;\n');
    await fs.writeFile(path.join(repo, 'src', 'o.c'), 'int other;\n');
    const initial = await service.gitStatus();
    assert.equal(initial.branch, 'main');
    assert.equal(initial.files.find((file) => file.path === 'src/设备 main.c')?.code, 'U');
    assert.equal(initial.identity.name, 'Test Author');
    await service.gitAction({ action: 'stage', paths: ['src/[one].c'] });
    let state = await service.gitStatus();
    assert.equal(state.files.find((file) => file.path === 'src/[one].c')?.staged, true);
    assert.equal(state.files.find((file) => file.path === 'src/o.c')?.staged, false);
    await service.gitAction({ action: 'unstage', paths: ['src/[one].c'] });
    assert.equal((await service.gitStatus()).files.find((file) => file.path === 'src/[one].c')?.code, 'U');
    await service.gitAction({ action: 'stage', paths: ['src/设备 main.c', 'src/[one].c', 'src/o.c'] });
    await service.gitAction({
      action: 'commit',
      message: 'Initial fixture\n\nActual newline body.',
      confirm: true,
    });
    assert.equal((await service.gitStatus()).files.length, 0);
    await fs.writeFile(path.join(repo, 'src', '设备 main.c'), 'int main(void) { return 1; }\n');
    assert.match(await service.gitDiff({ path: 'src/设备 main.c' }), /return 1/);
    await service.gitAction({ action: 'stage', paths: ['src/设备 main.c'] });
    assert.match(await service.gitDiff({ path: 'src/设备 main.c', staged: true }), /return 1/);
    await service.gitAction({ action: 'unstage', paths: ['src/设备 main.c'] });
    assert.equal((await service.gitStatus()).files[0].unstaged, true);
    await service.gitAction({ action: 'createBranch', branch: 'feature/gui-test' });
    assert.equal((await service.gitStatus()).branch, 'feature/gui-test');
    await service.gitAction({ action: 'checkout', branch: 'main' });
    assert.equal((await service.gitStatus()).branch, 'main');
    assert.match(await fs.readFile(path.join(repo, 'src', '设备 main.c'), 'utf8'), /return 1/);
  } finally {
    await context.cleanup();
  }
});

test('rename records and subdirectory boundaries are visible without staging outside the project', async () => {
  const context = await fixture();
  const { repo, service } = context;
  try {
    await fs.mkdir(path.join(repo, 'project'));
    await fs.writeFile(path.join(repo, 'project', 'old.c'), 'int x;\n');
    await fs.writeFile(path.join(repo, 'outside.c'), 'int outside;\n');
    await service.gitAction({ action: 'stage', paths: ['project/old.c', 'outside.c'] });
    await service.gitAction({ action: 'commit', message: 'Baseline', confirm: true });
    await fs.rename(path.join(repo, 'project', 'old.c'), path.join(repo, 'project', '新 name.c'));
    await service.gitAction({ action: 'stage', paths: ['project/old.c', 'project/新 name.c'] });
    const renamed = (await service.gitStatus()).files.find((file) => file.code === 'R');
    assert.equal(renamed?.path, 'project/新 name.c');
    assert.equal(renamed?.originalPath, 'project/old.c');
    await service.gitAction({ action: 'unstage', paths: ['project/新 name.c'] });
    assert.equal(
      (await service.gitStatus()).files.some((file) => file.staged),
      false,
    );
    await service.gitAction({ action: 'stage', paths: ['project/old.c', 'project/新 name.c'] });
    await fs.writeFile(path.join(repo, 'outside.c'), 'int outside_changed;\n');
    await service.gitAction({ action: 'stage', paths: ['outside.c'] });
    const sub = new GitService({ projectRoot: () => path.join(repo, 'project') });
    await sub.gitAction({ action: 'setMode', mode: 'shared', confirm: true });
    const state = await sub.gitStatus();
    assert.equal(state.outsideStaged, 1);
    assert.equal(state.files[0].path, '新 name.c');
    await assert.rejects(() => sub.gitAction({ action: 'stage', paths: ['../outside.c'] }), /invalidPath/);
    await assert.rejects(
      () => sub.gitAction({ action: 'commit', message: 'Refuse hidden files', confirm: true }),
      /gitOutsideStaged/,
    );
    await assert.rejects(() => sub.gitDiff({ path: '../outside.c' }), /invalidPath/);
    await service.gitAction({ action: 'unstage', paths: ['outside.c'] });
    await fs.writeFile(path.join(repo, 'outside.c'), 'int outside;\n');
    await fs.rename(path.join(repo, 'outside.c'), path.join(repo, 'project', 'moved.c'));
    await service.gitAction({ action: 'stage', paths: ['outside.c', 'project/moved.c'] });
    const crossed = await sub.gitStatus();
    assert.equal(crossed.outsideStaged, 1);
    assert.equal(crossed.files.find((file) => file.path === 'moved.c')?.originalPath, '../outside.c');
    await assert.rejects(
      () => sub.gitAction({ action: 'commit', message: 'Refuse external rename source', confirm: true }),
      /gitOutsideStaged/,
    );
    await assert.rejects(() => sub.gitAction({ action: 'unstage', paths: ['moved.c'] }), /gitOutsideStaged/);
  } finally {
    await context.cleanup();
  }
});

test('remote push and fast-forward pull use temporary local bare repositories, never force history', async () => {
  const context = await fixture();
  const { root, repo, service, hooks } = context;
  try {
    const remote = path.join(root, 'remote.git');
    await fs.mkdir(remote);
    await git(remote, ['-c', 'init.templateDir=', 'init', '--bare']);
    await fs.writeFile(path.join(repo, 'main.c'), 'baseline\n');
    await service.gitAction({ action: 'stage', paths: ['main.c'] });
    await service.gitAction({ action: 'commit', message: 'Baseline', confirm: true });
    await service.gitAction({ action: 'remoteSet', name: 'origin', url: remote });
    await service.gitAction({ action: 'push', remote: 'origin', branch: 'main', confirm: true });
    await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const second = path.join(root, 'second');
    await git(root, ['clone', '--', remote, second]);
    await git(second, ['config', '--local', 'core.hooksPath', hooks]);
    await git(second, ['config', '--local', 'commit.gpgSign', 'false']);
    await git(second, ['config', '--local', 'core.autocrlf', 'false']);
    const collaborator = new GitService({ projectRoot: () => second });
    await collaborator.gitAction({ action: 'setMode', mode: 'shared', confirm: true });
    await collaborator.gitAction({
      action: 'configure',
      name: 'Second Author',
      email: 'second@example.invalid',
    });
    await fs.writeFile(path.join(second, 'main.c'), 'remote update\n');
    await collaborator.gitAction({ action: 'stage', paths: ['main.c'] });
    await collaborator.gitAction({ action: 'commit', message: 'Remote update', confirm: true });
    await collaborator.gitAction({ action: 'push', remote: 'origin', branch: 'main', confirm: true });
    await service.gitAction({ action: 'fetch', remote: 'origin' });
    assert.equal((await service.gitStatus()).behind, 1);
    await service.gitAction({ action: 'pull', remote: 'origin', branch: 'main', confirm: true });
    assert.match(await fs.readFile(path.join(repo, 'main.c'), 'utf8'), /remote update/);
    await fs.writeFile(path.join(repo, 'local.c'), 'local\n');
    await service.gitAction({ action: 'stage', paths: ['local.c'] });
    await service.gitAction({ action: 'commit', message: 'Unpublished local', confirm: true });
    const localHead = await git(repo, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(second, 'second.c'), 'second\n');
    await collaborator.gitAction({ action: 'stage', paths: ['second.c'] });
    await collaborator.gitAction({ action: 'commit', message: 'Divergent remote', confirm: true });
    await collaborator.gitAction({ action: 'push', remote: 'origin', branch: 'main', confirm: true });
    const remoteHead = await git(remote, ['rev-parse', 'refs/heads/main']);
    await assert.rejects(() =>
      service.gitAction({ action: 'pull', remote: 'origin', branch: 'main', confirm: true }),
    );
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), localHead);
    await assert.rejects(() =>
      service.gitAction({ action: 'push', remote: 'origin', branch: 'main', confirm: true }),
    );
    assert.equal(await git(remote, ['rev-parse', 'refs/heads/main']), remoteHead);
  } finally {
    await context.cleanup();
  }
});

test('confirmation and unsafe option, path, remote URL inputs are rejected', async () => {
  assert.equal(gitActionSchema.safeParse({ action: 'push', remote: 'origin' }).success, false);
  assert.equal(gitActionSchema.safeParse({ action: 'commit', message: 'x', confirm: 'true' }).success, false);
  assert.equal(gitActionSchema.safeParse({ action: 'checkout', branch: '--force' }).success, false);
  const context = await fixture();
  try {
    await assert.rejects(
      () => context.service.gitAction({ action: 'remoteSet', name: 'origin', url: 'ext::sh -c malicious' }),
      /gitRemoteUrl/,
    );
    await assert.rejects(
      () =>
        context.service.gitAction({
          action: 'remoteSet',
          name: 'origin',
          url: 'https://token:password@example.invalid/repo',
        }),
      /gitRemoteUrl/,
    );
    await assert.rejects(
      () => context.service.gitAction({ action: 'stage', paths: ['.git/config'] }),
      /invalidPath/,
    );
  } finally {
    await context.cleanup();
  }
});

test('isolated history is opt-in and leaves the external index, HEAD and identity independent', async () => {
  const context = await fixture();
  const { repo, service } = context;
  try {
    await fs.writeFile(path.join(repo, 'main.c'), 'int baseline;\n');
    await service.gitAction({ action: 'stage', paths: ['main.c'] });
    await service.gitAction({ action: 'commit', message: 'External baseline', confirm: true });
    const externalHead = await git(repo, ['rev-parse', 'HEAD']);
    await fs.rm(path.join(repo, '.blode', 'git-management.json'));
    const before = await service.gitStatus();
    assert.equal(before.mode, 'disabled');
    assert.equal(before.repository, false, 'an existing .git must not activate shared management');
    assert.equal(before.sharedAvailable, true);
    await service.gitAction({ action: 'init' });
    let status = await service.gitStatus();
    assert.equal(status.mode, 'isolated');
    assert.equal(status.identity.name, '', 'private identity does not inherit external or global config');
    assert.equal(
      status.files.some((file) => file.path.startsWith('.blode/')),
      false,
    );
    await service.gitAction({
      action: 'configure',
      name: 'Private Author',
      email: 'private@example.invalid',
    });
    await fs
      .writeFile(path.join(repo, '.blode', 'git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 71\n', {
        mode: 0o755,
      })
      .catch(async () => {
        await fs.mkdir(path.join(repo, '.blode', 'git', 'hooks'), { recursive: true });
        await fs.writeFile(path.join(repo, '.blode', 'git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 71\n', {
          mode: 0o755,
        });
      });
    const previousDirectory = process.env.GIT_DIR,
      previousIndex = process.env.GIT_INDEX_FILE;
    try {
      process.env.GIT_DIR = path.join(repo, '.git');
      process.env.GIT_INDEX_FILE = path.join(repo, '.git', 'index');
      await service.gitAction({ action: 'stage', paths: ['main.c'] });
      await service.gitAction({ action: 'commit', message: 'Private baseline', confirm: true });
    } finally {
      if (previousDirectory === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousDirectory;
      if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndex;
    }
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), externalHead);
    assert.equal(await git(repo, ['config', '--local', 'user.name']), 'Test Author');
    assert.equal(await git(repo, ['diff', '--cached', '--name-only']), '');
    assert.equal((await service.gitStatus()).identity.name, 'Private Author');
    await assert.rejects(
      () => service.gitAction({ action: 'stage', paths: ['.blode/git/config'] }),
      /invalidPath/,
    );
  } finally {
    await context.cleanup();
  }
});

test('disabling and deleting software-owned history keeps current source and the shared repository', async () => {
  const context = await fixture();
  const { repo, service } = context;
  try {
    await fs.writeFile(path.join(repo, 'main.c'), 'int baseline;\n');
    await service.gitAction({ action: 'init' });
    await service.gitAction({ action: 'configure', name: 'Private', email: 'private@example.invalid' });
    await service.gitAction({ action: 'stage', paths: ['main.c'] });
    await service.gitAction({ action: 'commit', message: 'Private snapshot', confirm: true });
    await fs.writeFile(path.join(repo, 'main.c'), 'int current_unsaved_to_git;\n');
    await service.gitAction({ action: 'setMode', mode: 'disabled', confirm: true });
    assert.equal((await service.gitStatus()).repository, false);
    assert.equal((await service.gitStatus()).ownedHistory, true);
    await service.gitAction({ action: 'setMode', mode: 'isolated', confirm: true });
    assert.equal((await service.gitStatus()).files.find((file) => file.path === 'main.c')?.code, 'M');
    await service.gitAction({ action: 'removeRepository', target: 'isolated', confirm: true });
    assert.equal((await service.gitStatus()).mode, 'disabled');
    assert.equal((await service.gitStatus()).ownedHistory, false);
    assert.equal(await fs.readFile(path.join(repo, 'main.c'), 'utf8'), 'int current_unsaved_to_git;\n');
    assert.equal((await fs.stat(path.join(repo, '.git'))).isDirectory(), true);
    assert.equal(
      gitActionSchema.safeParse({ action: 'removeRepository', target: 'isolated' }).success,
      false,
    );
  } finally {
    await context.cleanup();
  }
});

test('shared history deletion requires an exact explicit root and never deletes working source', async () => {
  const context = await fixture();
  try {
    const { repo, service } = context;
    await fs.writeFile(path.join(repo, 'keep.c'), 'int keep;\n');
    await assert.rejects(
      () => service.gitAction({ action: 'removeRepository', target: 'shared', confirm: true }),
      /gitSharedConfirmation/,
    );
    await assert.rejects(
      () =>
        service.gitAction({
          action: 'removeRepository',
          target: 'shared',
          repositoryRoot: context.root,
          confirm: true,
        }),
      /gitSharedConfirmation/,
    );
    assert.equal((await fs.stat(path.join(repo, '.git'))).isDirectory(), true);
    await service.gitAction({
      action: 'removeRepository',
      target: 'shared',
      repositoryRoot: repo,
      confirm: true,
    });
    await assert.rejects(() => fs.stat(path.join(repo, '.git')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(repo, 'keep.c'), 'utf8'), 'int keep;\n');
    assert.equal((await service.gitStatus()).mode, 'disabled');
  } finally {
    await context.cleanup();
  }
});

test('removing isolated history rejects a directory junction to another repository', async () => {
  const context = await fixture();
  try {
    const { repo, service } = context;
    await fs.symlink(
      path.join(repo, '.git'),
      path.join(repo, '.blode', 'git'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      () => service.gitAction({ action: 'removeRepository', target: 'isolated', confirm: true }),
      /invalidPath/,
    );
    assert.equal((await fs.stat(path.join(repo, '.git', 'HEAD'))).isFile(), true);
    await fs.unlink(path.join(repo, '.blode', 'git'));
  } finally {
    await context.cleanup();
  }
});
