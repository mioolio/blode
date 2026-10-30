import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceAssets, assetByteRange } from '../src/core/workspace-assets';
import { assetKind, assetMime } from '../src/shared/assets';
import { readProjectFiles, isEditableTextFile } from '../src/core/workspace';
import { createCore } from '../src/core/service';
import { startWebServer } from '../src/core/web';

async function fixture(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-assets-'));
  const root = await fs.realpath(temporary);
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  let active = project;
  const assets = new WorkspaceAssets(() => active);
  t.after(async () => {
    assets.reset();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(root), /^blode-assets-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    assets,
    select: (value: string) => {
      active = value;
      assets.reset();
    },
  };
}
const ticket = (url: string) => url.split('/').at(-1)!;

test('bitmap and audio resources stay lazy while SVG source remains editable', async (t) => {
  const f = await fixture(t);
  for (const file of [
    'Main.C',
    'cover.PNG',
    'sound.m4a',
    'sound.aac',
    'sound.opus',
    'logo.svg',
    'film.webm',
    'photo.avif',
  ])
    await fs.writeFile(path.join(f.project, file), 'fixture');
  assert.equal(assetKind('Main.C'), 'binary');
  assert.equal(assetKind('cover.PNG'), 'image');
  assert.equal(assetMime('sound.opus'), 'audio/ogg');
  assert.equal(isEditableTextFile('logo.svg'), true);
  const files = await readProjectFiles(f.project);
  assert.deepEqual(files.map((file) => file.path).sort(), ['Main.C', 'logo.svg']);
});

test('large media is described without base64 and supports full, open, suffix and HEAD byte ranges', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  await fs.writeFile(path.join(f.project, 'sound.wav'), bytes);
  const preview = await f.assets.preview({ expectedProjectRoot: f.project, path: 'sound.wav' });
  assert.equal(preview.size, bytes.length);
  assert.equal(preview.kind, 'audio');
  assert.equal(preview.hex, undefined);
  assert.ok(JSON.stringify(preview).length < 512);
  const id = ticket(preview.url);
  for (const [range, start, end] of [
    ['bytes=0-15', 0, 15],
    ['bytes=-9', bytes.length - 9, bytes.length - 1],
    ['bytes=8388590-', 8388590, bytes.length - 1],
  ] as const) {
    const response = await f.assets.response(id, range);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  const head = await f.assets.response(id, null, true);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(head.body, null);
  const full = await f.assets.response(id);
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  for (const range of [
    'bytes=99999999-',
    'bytes=0-1,4-5',
    'items=0-9',
    'bytes=-0',
    'bytes=4-2',
    'bytes=9007199254740992-',
  ]) {
    const invalid = await f.assets.response(id, range);
    assert.equal(invalid.status, 416, range);
    assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`);
  }
});

test('unknown binary previews have a bounded hex prefix; SVG responses cannot run active content', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, 'firmware.bin'), Buffer.alloc(12000, 0xab));
  const binary = await f.assets.preview({ expectedProjectRoot: f.project, path: 'firmware.bin' });
  assert.equal(binary.hex, 'ab'.repeat(4096));
  assert.equal(binary.truncated, true);
  const response = await f.assets.response(ticket(binary.url), null, true);
  assert.equal(response.headers.get('content-disposition'), 'attachment');
  await fs.writeFile(path.join(f.project, 'logo.svg'), '<svg><script>alert(1)</script></svg>');
  const svg = await f.assets.preview({ expectedProjectRoot: f.project, path: 'logo.svg' });
  const image = await f.assets.response(ticket(svg.url));
  assert.equal(image.headers.get('content-type'), 'image/svg+xml');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.match(image.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.match(image.headers.get('content-security-policy')!, /sandbox/);
  await image.body?.cancel();
});

test('capabilities reject old projects, traversal, hidden paths, replaced files and links', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, 'pic.png'), 'image');
  for (const name of ['../outside.png', '.git/config', 'C:\\outside.png', 'folder/../pic.png'])
    await assert.rejects(
      f.assets.preview({ expectedProjectRoot: f.project, path: name }),
      /invalidPath|protectedPath|ENOENT/,
    );
  await assert.rejects(
    f.assets.preview({ expectedProjectRoot: f.root, path: 'pic.png' }),
    /assetProjectChanged/,
  );
  const first = await f.assets.preview({ expectedProjectRoot: f.project, path: 'pic.png' });
  const same = await f.assets.preview({ expectedProjectRoot: f.project, path: 'pic.png' });
  assert.equal(same.url, first.url);
  await fs.writeFile(path.join(f.project, 'pic.png'), 'changed-image');
  assert.equal((await f.assets.response(ticket(first.url))).status, 409);
  const second = await f.assets.preview({ expectedProjectRoot: f.project, path: 'pic.png' });
  assert.notEqual(second.url, first.url);
  f.select('');
  assert.equal((await f.assets.response(ticket(second.url))).status, 404);
  f.select(f.project);
  assert.equal((await f.assets.response(ticket(second.url))).status, 404);
  await fs.writeFile(path.join(f.root, 'outside.png'), 'outside');
  try {
    await fs.symlink(path.join(f.root, 'outside.png'), path.join(f.project, 'link.png'));
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code!)) return;
    throw error;
  }
  await assert.rejects(f.assets.preview({ expectedProjectRoot: f.project, path: 'link.png' }), /symlinkPath/);
});

test('range parser handles empty files and extreme integers without allocations', () => {
  assert.equal(assetByteRange(null, 0), null);
  assert.throws(() => assetByteRange('bytes=0-', 0));
  assert.deepEqual(assetByteRange('bytes=0-99999', 20), { start: 0, end: 19 });
  assert.deepEqual(assetByteRange('bytes=-99999', 20), { start: 0, end: 19 });
  assert.throws(() => assetByteRange('bytes=-99999999999999999999', 20));
});

test('project reset aborts active media reads and closes their file handles', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, 'long.wav'), Buffer.alloc(8 * 1024 * 1024));
  const preview = await f.assets.preview({ expectedProjectRoot: f.project, path: 'long.wav' });
  const response = await f.assets.response(ticket(preview.url));
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  f.select('');
  await assert.rejects(async () => {
    while (!(await reader.read()).done) {}
  });
  assert.equal((await f.assets.response(ticket(preview.url))).status, 404);
  await fs.rename(path.join(f.project, 'long.wav'), path.join(f.project, 'released.wav'));
});

test('HTTP grants only authenticated per-file capabilities and invalidates them on project changes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, '音乐 空格.wav'), '0123456789');
  const core = await createCore({
    projectRoot: f.project,
    dataRoot: path.join(f.root, 'data'),
    createRuntimes: () => [],
    refreshDevices: false,
    onEvent() {},
  });
  const web = await startWebServer({
    api: core,
    assets: (id, range, head) => core.workspaceAssetResponse(id, range, head),
    dataRoot: path.join(f.root, 'web'),
    appRoot: f.root,
    isPackaged: true,
    allowExternal: false,
    requireToken: true,
    port: 0,
  });
  t.after(async () => {
    await web.close();
    await core.shutdown();
  });
  const token = (await fs.readFile(web.tokenFile, 'utf8')).trim();
  const rpc = (authorized: boolean) =>
    fetch(web.endpoint + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorized ? { 'x-blode-token': token } : {}) },
      body: JSON.stringify({
        method: 'workspaceAsset',
        args: [{ expectedProjectRoot: f.project, path: '音乐 空格.wav' }],
      }),
    });
  assert.equal((await rpc(false)).status, 401);
  const result = await rpc(true);
  assert.equal(result.status, 200);
  const asset = await result.json();
  assert.ok(!asset.url.includes(token));
  const content = await fetch(web.endpoint + asset.url, { headers: { range: 'bytes=2-5' } });
  assert.equal(content.status, 206);
  assert.equal(await content.text(), '2345');
  const head = await fetch(web.endpoint + asset.url, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await fetch(web.endpoint + '/workspace/assets/' + 'a'.repeat(64))).status, 404);
  assert.equal(
    (await fetch(web.endpoint + asset.url, { headers: { Origin: 'https://foreign.example' } })).status,
    403,
  );
  assert.equal(
    (await fetch(web.endpoint + asset.url, { headers: { 'sec-fetch-site': 'cross-site' } })).status,
    403,
  );
  assert.equal(
    (await core.workspaceSnapshot()).inventory.entries.some((entry) => entry.path === '音乐 空格.wav'),
    true,
  );
  await core.closeProject();
  assert.equal((await fetch(web.endpoint + asset.url)).status, 404);
  await core.setProjectRoot(f.project);
  assert.equal((await fetch(web.endpoint + asset.url)).status, 404);
});
