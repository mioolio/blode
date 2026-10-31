import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listBoards } from '../extensions/registry';
import { GeneralExtensions } from '../src/core/general-extensions';
import { generalExtensionManifestSchema } from '../src/core/general-extensions/schema';
import { readExtensionSource } from '../src/core/general-extensions/package';
import { readComponentZip } from '../src/core/component-zip';
import { applyShellAppearance } from '../src/renderer/extensions/ShellAppearance';
import { updateGeneralExtensions, useGeneralExtensions } from '../src/renderer/extensions/ShellAppearance';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const sample = path.resolve('extensions/plugins/Personalization');
async function fixture(t: any, options: Partial<ConstructorParameters<typeof GeneralExtensions>[0]> = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-general-extension-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'),
    dataRoot = path.join(base, 'data');
  await fs.cp(sample, source, { recursive: true });
  let changed = 0;
  const manager = new GeneralExtensions({ dataRoot, changed: () => changed++, ...options });
  const install = async () => {
    const review = await manager.review({ path: source });
    await manager.install({ ticket: review.ticket, fingerprint: review.fingerprint, confirm: true });
    return review;
  };
  return { base, source, dataRoot, manager, install, changed: () => changed };
}

test('a panel opened by an independent view activates the host workspace and checks enablement first', async (t) => {
  const calls: string[] = [];
  const f = await fixture(t, {
    openPanel: async (id, view) => {
      calls.push(`${id}/${view.id}`);
    },
  });
  const review = await f.install();
  await assert.rejects(f.manager.openView({ id: 'Personalization', view: 'preview' }), /extensionPermission/);
  assert.deepEqual(calls, []);
  await f.manager.enable({
    id: 'Personalization',
    fingerprint: review.fingerprint,
    confirm: true,
    permanent: false,
  });
  assert.deepEqual(await f.manager.openView({ id: 'Personalization', view: 'preview' }), {
    destination: 'panel',
  });
  assert.deepEqual(calls, ['Personalization/preview']);
  await f.manager.close();
});

test('general extension permission declarations are independent of board/compiler registration', async () => {
  const before = listBoards().map((board) => board.id),
    pack = await readExtensionSource(sample);
  assert.equal(pack.manifest.kind, 'extension');
  assert.deepEqual(
    listBoards().map((board) => board.id),
    before,
  );
  assert.equal(before.includes('Personalization'), false);
  assert.equal(
    generalExtensionManifestSchema.safeParse({ ...pack.manifest, runtime: 'runtime/native.mjs' }).success,
    false,
  );
  assert.equal(
    generalExtensionManifestSchema.safeParse({ ...pack.manifest, permissions: ['settings'] }).success,
    false,
  );
  assert.equal(generalExtensionManifestSchema.safeParse({ ...pack.manifest, kind: 'board' }).success, false);
  assert.equal(
    generalExtensionManifestSchema.safeParse({
      ...pack.manifest,
      ui: { appearance: { variables: { '--bg': 'url(https://example.com)' } } },
    }).success,
    false,
  );
  assert.equal(
    generalExtensionManifestSchema.safeParse({
      ...pack.manifest,
      ui: { ...pack.manifest.ui, appearance: { desktopGlass: true } },
    }).success,
    true,
  );
  assert.equal(
    generalExtensionManifestSchema.safeParse({
      ...pack.manifest,
      ui: { ...pack.manifest.ui, appearance: { desktopGlass: true } },
      permissions: pack.manifest.permissions.filter((permission) => permission !== 'ui.appearance'),
    }).success,
    false,
  );
  assert.equal(
    generalExtensionManifestSchema.safeParse({
      ...pack.manifest,
      ui: { ...pack.manifest.ui, desktopGlassSetting: 'preset' },
    }).success,
    false,
  );
});

test('review/install copy a self-contained package without enabling it, and reject source changes', async (t) => {
  const f = await fixture(t),
    review = await f.manager.review({ path: f.source });
  await fs.appendFile(path.join(f.source, 'runtime/appearance.mjs'), '\n// changed after review');
  await assert.rejects(
    f.manager.install({ ticket: review.ticket, fingerprint: review.fingerprint, confirm: true }),
    /extensionChanged/,
  );
  assert.equal((await f.manager.state()).plugins.length, 0);
  const reviewed = await f.install(),
    state = await f.manager.state(),
    plugin = state.plugins[0];
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.trust, 'required');
  assert.equal(plugin.fingerprint, reviewed.fingerprint);
  await fs.rm(f.source, { recursive: true });
  assert.ok(
    (await fs.readFile(path.join(plugin.directory, 'runtime/appearance.mjs'), 'utf8')).includes(
      'export async function start',
    ),
  );
  assert.equal(f.changed(), 1);
  await assert.rejects(f.manager.viewDocument({ id: plugin.id, view: 'appearance' }), /extensionDisabled/);
});

test('malformed locale catalogs and defaults are rejected during review before installation', async (t) => {
  const f = await fixture(t),
    defaults = path.join(f.source, 'settings/defaults.json'),
    locale = path.join(f.source, 'locales/en.json');
  await fs.writeFile(defaults, '{ invalid JSON');
  await assert.rejects(f.manager.review({ path: f.source }), /extensionSettings/);
  await fs.writeFile(defaults, JSON.stringify({ preset: 'unknown-preset' }));
  await assert.rejects(f.manager.review({ path: f.source }), /extensionSettings/);
  await fs.writeFile(defaults, JSON.stringify({ preset: 'glass', undeclared: true }));
  await assert.rejects(f.manager.review({ path: f.source }), /extensionSettings/);
  await fs.writeFile(defaults, JSON.stringify({ preset: 'glass' }));
  await fs.writeFile(locale, JSON.stringify({ title: { object: 'not a string' } }));
  await assert.rejects(f.manager.review({ path: f.source }), /extensionManifest/);
  assert.equal((await f.manager.state()).plugins.length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.dataRoot, 'extensions')), []);
});

test('native code runs only after matching explicit trust, disposes on disable and needs restart when replaced', async (t) => {
  const f = await fixture(t),
    manifestPath = path.join(f.source, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions.push('native');
  manifest.runtime = 'runtime/native.mjs';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(
    path.join(f.source, 'runtime/native.mjs'),
    `import {promises as fs} from 'node:fs'; import path from 'node:path'; export async function activate(host) { await fs.writeFile(path.join(host.dataDirectory,'activated'),'yes'); return {dispose:()=>fs.writeFile(path.join(host.dataDirectory,'disposed'),'yes')}; }`,
  );
  const review = await f.install(),
    sentinel = path.join(f.dataRoot, 'extension-data/Personalization/activated');
  assert.equal(await fs.stat(sentinel).catch(() => null), null);
  await assert.rejects(
    f.manager.enable({ id: 'Personalization', fingerprint: '0'.repeat(64), confirm: true, permanent: false }),
    /extensionChanged/,
  );
  await f.manager.enable({
    id: 'Personalization',
    fingerprint: review.fingerprint,
    confirm: true,
    permanent: false,
  });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'yes');
  await f.manager.disable({ id: 'Personalization' });
  assert.equal(await fs.readFile(path.join(path.dirname(sentinel), 'disposed'), 'utf8'), 'yes');
  const plugin = (await f.manager.state()).plugins[0];
  await fs.appendFile(path.join(plugin.directory, 'runtime/native.mjs'), '\n// changed native code');
  const changed = (await f.manager.state()).plugins[0];
  assert.equal(changed.enabled, false);
  assert.equal(changed.restartRequired, true);
  assert.equal(changed.trust, 'required');
  await assert.rejects(
    f.manager.enable({ id: changed.id, fingerprint: changed.fingerprint, confirm: true, permanent: false }),
    /extensionRestartRequired/,
  );
});

test('permanent approval is package/machine-bound and deleting .uel requires fresh approval', async (t) => {
  const f = await fixture(t),
    review = await f.install();
  await f.manager.enable({
    id: 'Personalization',
    fingerprint: review.fingerprint,
    confirm: true,
    permanent: true,
  });
  await f.manager.close();
  await assert.rejects(f.manager.state(), /operationCancelled/);
  const reboot = new GeneralExtensions({ dataRoot: f.dataRoot });
  const plugin = (await reboot.state()).plugins[0];
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.trust, 'permanent');
  await fs.unlink(path.join(plugin.directory, '.uel'));
  const revoked = (await reboot.state()).plugins[0];
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.trust, 'required');
  await reboot.enable({ id: plugin.id, fingerprint: plugin.fingerprint, confirm: true, permanent: true });
  await fs.appendFile(path.join(plugin.directory, 'styles/appearance.css'), '\n/* new version */');
  const changed = (await reboot.state()).plugins[0];
  assert.equal(changed.enabled, false);
  assert.equal(changed.trust, 'required');
});

test('isolated views inline package resources and approved settings drive appearance without host source imports', async (t) => {
  const f = await fixture(t),
    review = await f.install();
  await f.manager.enable({
    id: 'Personalization',
    fingerprint: review.fingerprint,
    confirm: true,
    permanent: false,
  });
  const html = await f.manager.viewDocument({ id: 'Personalization', view: 'appearance' });
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /window\.blodeExtension/);
  assert.match(html, /export async function start/);
  assert.doesNotMatch(html, /src="\.\.\/runtime|href="\.\.\/styles/);
  const state = await f.manager.configure({ id: 'Personalization', values: { preset: 'glass' } });
  assert.match(state.plugins[0].appearance?.backgroundData ?? '', /^data:image\/svg\+xml;base64,/);
  assert.equal(state.plugins[0].appearance?.translucent, true);
  assert.equal(state.plugins[0].appearance?.desktopGlass, false);
  const frosted = await f.manager.configure({
    id: 'Personalization',
    values: { desktopGlass: true },
  });
  assert.equal(frosted.plugins[0].appearance?.desktopGlass, true);
  await assert.rejects(
    f.manager.configure({ id: 'Personalization', values: { preset: 'unknown' } }),
    /extensionSettings/,
  );
  await assert.rejects(
    f.manager.configure({ id: 'Personalization', values: { arbitraryHostPath: 'C:/private' } }),
    /extensionSettings/,
  );
  assert.deepEqual(await f.manager.openView({ id: 'Personalization', view: 'preview' }), {
    destination: 'panel',
  });
  assert.equal(
    (await f.manager.openView({ id: 'Personalization', view: 'appearance' })).destination,
    'browser',
  );
});

test('ZIP sharing excludes .uel and survives copying to a fresh binary-style application data directory', async (t) => {
  const f = await fixture(t),
    review = await f.install();
  await f.manager.enable({
    id: 'Personalization',
    fingerprint: review.fingerprint,
    confirm: true,
    permanent: true,
  });
  const exported = await f.manager.export({ id: 'Personalization', confirm: true }),
    artifact = f.manager.download(exported.id),
    bytes = await fs.readFile(artifact.path);
  const files = readComponentZip(bytes);
  assert.equal(files.has('.uel'), false);
  assert.ok(files.has('locales/en.json'));
  assert.ok(files.has('settings/defaults.json'));
  assert.ok([...files.keys()].every((file) => !file.includes('node_modules') && !file.includes('src/core')));
  const other = new GeneralExtensions({ dataRoot: path.join(f.base, 'portable-user') });
  const reviewed = await other.review({ path: artifact.path });
  await other.install({ ticket: reviewed.ticket, fingerprint: reviewed.fingerprint, confirm: true });
  assert.equal((await other.state()).plugins[0].trust, 'required');
  await other.enable({
    id: reviewed.manifest.id,
    fingerprint: reviewed.fingerprint,
    confirm: true,
    permanent: false,
  });
  assert.match(
    await other.viewDocument({ id: reviewed.manifest.id, view: 'appearance' }),
    /blode-extension-ui/,
  );
  const removed = await other.remove({ id: reviewed.manifest.id, confirm: true });
  assert.equal(removed.plugins.length, 0);
  assert.equal(await fs.stat(path.join(removed.directory, reviewed.manifest.id)).catch(() => null), null);
});

test('shell theme variables and classes are restored after disabling or uninstalling an extension', async (t) => {
  const f = await fixture(t),
    review = await f.install();
  await f.manager.enable({
    id: 'Personalization',
    fingerprint: review.fingerprint,
    confirm: true,
    permanent: false,
  });
  const plugin = (
    await f.manager.configure({
      id: 'Personalization',
      values: { preset: 'glass', desktopGlass: true },
    })
  ).plugins[0];
  const values = new Map([['--bg', '#original']]),
    classes = new Set<string>();
  const root = {
    style: {
      getPropertyValue: (key: string) => values.get(key) ?? '',
      getPropertyPriority: () => '',
      setProperty: (key: string, value: string) => values.set(key, value),
      removeProperty: (key: string) => values.delete(key),
    },
    classList: {
      contains: (key: string) => classes.has(key),
      toggle: (key: string, value: boolean) => (value ? classes.add(key) : classes.delete(key)),
    },
  } as unknown as HTMLElement;
  const restore = applyShellAppearance(root, [plugin]);
  assert.notEqual(values.get('--bg'), '#original');
  assert.ok(classes.has('extension-glass'));
  assert.ok(classes.has('extension-wallpaper'));
  assert.ok(classes.has('extension-desktop-glass'));
  restore();
  assert.equal(values.get('--bg'), '#original');
  assert.equal(values.has('--surface-1'), false);
  assert.equal(classes.size, 0);
});

test('extension directory imports reject junctions before review or installation', async (t) => {
  const f = await fixture(t),
    outside = path.join(f.base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'host.txt'), 'private');
  try {
    await fs.symlink(outside, path.join(f.source, 'linked'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return t.skip('junction creation unavailable');
    throw error;
  }
  await assert.rejects(f.manager.review({ path: f.source }), /extensionPath/);
  assert.equal((await f.manager.state()).plugins.length, 0);
});

test('extension state accepts a restarted host and rejects late snapshots from the previous host', async (t) => {
  const f = await fixture(t),
    previous = { ...(await f.manager.state()), revision: 20 };
  updateGeneralExtensions(previous);
  const nextHost = new GeneralExtensions({ dataRoot: path.join(f.base, 'new-host') });
  const next = await nextHost.state();
  assert.notEqual(next.instanceId, previous.instanceId);
  updateGeneralExtensions(next);
  let current: ReturnType<typeof useGeneralExtensions>['data'];
  function Probe() {
    current = useGeneralExtensions().data;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(current!.instanceId, next.instanceId);
  assert.equal(current!.revision, 0);
  updateGeneralExtensions({ ...previous, revision: 21 });
  renderToStaticMarkup(createElement(Probe));
  assert.equal(current!.instanceId, next.instanceId);
});
