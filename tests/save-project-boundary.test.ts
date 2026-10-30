import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CollaborationService } from '../src/core/collaboration';
import { protectSharedWorkspace } from '../src/core/shared-workspace';
import { createCore, type CoreService } from '../src/core/service';
import { startWebServer } from '../src/core/web';

function fixture() {
  const files = new Map([
    ['/project-a', 'saved A'],
    ['/project-b', 'saved B'],
  ]);
  let root = '/project-a';
  const writes: string[] = [];
  const core = {
    currentProjectRoot: () => root,
    saveFile: async (file: string, content: string) => {
      writes.push(`${root}/${file}`);
      files.set(root, content);
    },
    setProjectRoot: async (next: string) => {
      root = next;
    },
    closeProject: async () => {
      root = '';
    },
    getState: async () => ({ projectRoot: root }),
    build: async () => {},
    flash: async () => {},
    renameEntry: async () => {},
    deleteEntry: async () => {},
  } as unknown as CoreService;
  const service = new CollaborationService({
    workspace: async () => ({
      projectRoot: root,
      files: [{ path: 'main.c', content: files.get(root) ?? '' }],
    }),
    saveFile: core.saveFile.bind(core),
    publish() {},
  });
  protectSharedWorkspace(core, service);
  return { core, service, writes, files };
}

test('a stale save queued behind a project switch cannot write into the new project', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = f.service.workspaceAction(() => gate);
  const switched = f.core.setProjectRoot('/project-b');
  const stale = f.core.saveFile('main.c', 'A unsaved text', '/project-a');
  release();
  await blocked;
  await switched;
  await assert.rejects(stale, /collaborationProjectChanged/);
  assert.deepEqual(f.writes, []);
  assert.equal(f.files.get('/project-a'), 'saved A');
  assert.equal(f.files.get('/project-b'), 'saved B');
  await f.core.saveFile('main.c', 'updated B', '/project-b');
  assert.equal(f.files.get('/project-b'), 'updated B');
  await f.core.saveFile('main.c', 'legacy B');
  assert.equal(f.files.get('/project-b'), 'legacy B');
});

test('Core save rejects the wrong expected project before touching disk', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-save-boundary-'));
  const project = path.join(temporary, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'main.c'), 'unchanged');
  const core = await createCore({
    projectRoot: project,
    dataRoot: path.join(temporary, 'data'),
    onEvent() {},
    createRuntimes: () => [],
    refreshDevices: false,
  });
  t.after(async () => {
    await core.shutdown();
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.match(path.basename(temporary), /^blode-save-boundary-/);
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await assert.rejects(
    core.saveFile('main.c', 'foreign text', path.join(temporary, 'other')),
    /collaborationProjectChanged/,
  );
  assert.equal(await fs.readFile(path.join(project, 'main.c'), 'utf8'), 'unchanged');
  await core.saveFile('main.c', 'accepted', project);
  assert.equal(await fs.readFile(path.join(project, 'main.c'), 'utf8'), 'accepted');
  const initialConfig = (await core.getState()).config;
  const marker = path.join(project, 'be');
  const markerBefore = await fs.readFile(marker, 'utf8').catch(() => undefined);
  await assert.rejects(
    core.saveConfig({ ...initialConfig, name: 'wrong project' }, path.join(temporary, 'other')),
    /collaborationProjectChanged/,
  );
  assert.equal(await fs.readFile(marker, 'utf8').catch(() => undefined), markerBefore);
  assert.equal((await core.getState()).config.name, initialConfig.name);
  await core.saveConfig({ ...initialConfig, name: 'accepted project' }, project);
  assert.equal((await core.getState()).config.name, 'accepted project');
});

test('Web saves retain expected project roots and keep the two-argument API compatible', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-save-http-'));
  const server = await startWebServer({
    api: f.core,
    dataRoot: temporary,
    appRoot: temporary,
    isPackaged: true,
    allowExternal: false,
    requireToken: true,
    port: 0,
  });
  t.after(async () => {
    await server.close();
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.match(path.basename(temporary), /^blode-save-http-/);
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const token = (await fs.readFile(server.tokenFile, 'utf8')).trim();
  const save = (args: unknown[]) =>
    fetch(server.endpoint + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-blode-token': token },
      body: JSON.stringify({ method: 'saveFile', args }),
    });
  await f.core.setProjectRoot('/project-b');
  const stale = await save(['main.c', 'A unsaved text', '/project-a']);
  assert.equal(stale.status, 400);
  assert.match(await stale.text(), /collaborationProjectChanged/);
  assert.equal(f.files.get('/project-b'), 'saved B');
  const malformed = await save(['main.c', 'wrong', {}]);
  assert.equal(malformed.status, 400);
  assert.match(await malformed.text(), /invalidParams/);
  const matching = await save(['main.c', 'matching B', '/project-b']);
  assert.equal(matching.status, 200);
  await matching.text();
  const legacy = await save(['main.c', 'legacy B']);
  assert.equal(legacy.status, 200);
  await legacy.text();
  assert.equal(f.files.get('/project-b'), 'legacy B');
});

test('Web configuration saves preserve the root guard and the legacy one-argument API', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-config-http-'));
  const roots: (string | undefined)[] = [];
  const server = await startWebServer({
    api: {
      getState: async () => ({}),
      saveConfig: async (_config: unknown, root?: string) => {
        roots.push(root);
        if (root !== undefined && root !== '/project-b') throw new Error('error.collaborationProjectChanged');
      },
    } as unknown as CoreService,
    dataRoot: temporary,
    appRoot: temporary,
    isPackaged: true,
    allowExternal: false,
    requireToken: true,
    port: 0,
  });
  t.after(async () => {
    await server.close();
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.match(path.basename(temporary), /^blode-config-http-/);
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const token = (await fs.readFile(server.tokenFile, 'utf8')).trim();
  const save = (args: unknown[]) =>
    fetch(server.endpoint + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-blode-token': token },
      body: JSON.stringify({ method: 'saveConfig', args }),
    });
  const stale = await save([{}, '/project-a']);
  assert.equal(stale.status, 400);
  assert.match(await stale.text(), /collaborationProjectChanged/);
  const matching = await save([{}, '/project-b']);
  assert.equal(matching.status, 200);
  await matching.text();
  const legacy = await save([{}]);
  assert.equal(legacy.status, 200);
  await legacy.text();
  const malformed = await save([{}, null]);
  assert.equal(malformed.status, 400);
  assert.match(await malformed.text(), /invalidParams/);
  assert.deepEqual(roots, ['/project-a', '/project-b', undefined]);
});
