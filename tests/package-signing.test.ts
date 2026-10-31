import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertPackageApproval,
  hashSignedDirectory,
  publisherKeyId,
  signObe,
  verifyObe,
  verifyPackageFiles,
} from '../src/core/package-signing';
import { OfflineTools } from '../src/core/tool-offline';
import { ToolVersions } from '../src/core/tool-versions';
import { runCommand } from '../src/core/process';
import { getBoardAdapter } from '../extensions/registry';
import { readZip } from '../src/core/zip-reader';
import { writeZip } from '../src/core/zip';
import { DevicePackages } from '../src/core/device-packages';
import { readDevicePackage } from '../src/core/device-package-source';
import { readExtensionSource } from '../src/core/general-extensions/package';
import { inspectSmallPackage } from '../src/core/package-inspection';
import { ComponentLibraries } from '../src/core/components';
import { GeneralExtensions } from '../src/core/general-extensions';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keys = [{ keyId: publisherKeyId(publicPem), publisher: 'Blode Studio', publicKey: publicPem }];
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const records = (files: Map<string, Buffer>) =>
  [...files].map(([path, data]) => ({ path, size: data.length, sha256: sha(data) }));
const subject = { kind: 'component' as const, id: 'Example', version: '1.0' };

test('release sidecars detect changed artifact bytes independently of file extensions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-obe-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Blode.Studio.zip'),
    data = Buffer.from('release fixture');
  await fs.writeFile(file, data);
  await fs.writeFile(
    file + '.obe',
    signObe(
      [{ path: path.basename(file), size: data.length, sha256: sha(data) }],
      { kind: 'application', id: 'Blode.Studio', version: '0.3.5.2' },
      privatePem,
    ),
  );
  assert.equal((await inspectSmallPackage(file, 'application')).status, 'untrusted');
  await fs.writeFile(file, Buffer.from('changed release'));
  const result = await inspectSmallPackage(file, 'application');
  assert.equal(result.status, 'tampered');
  assert.equal(result.signatureValid, true);
});

test('component and extension installation enforce the current signature review at the host boundary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-obe-host-'));
  const project = path.join(root, 'project'),
    library = path.join(root, 'library');
  await fs.mkdir(project);
  await fs.mkdir(library);
  await fs.writeFile(path.join(library, 'part.c'), 'int part(void){return 42;}');
  await fs.writeFile(
    path.join(library, 'obe'),
    signObe((await hashSignedDirectory(library)).records, subject, privatePem),
  );
  const components = new ComponentLibraries({
    projectRoot: () => project,
    config: () => getBoardAdapter('STM32F103C8T6').createConfig(),
    dataRoot: path.join(root, 'data'),
    enforceSignatures: true,
  });
  const inspected = await inspectSmallPackage(library, 'component');
  await assert.rejects(components.importDirectory(library, project), /ApprovalRequired/);
  await components.importDirectory(
    library,
    project,
    {},
    { fingerprint: inspected.fingerprint, allowUntrusted: true },
  );
  assert.equal((await components.list()).components.length, 1);
  const extensions = new GeneralExtensions({
    dataRoot: path.join(root, 'extensions-data'),
    enforceSignatures: true,
  });
  t.after(async () => {
    await extensions.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const review = await extensions.review({ path: path.resolve('extensions/plugins/Personalization') });
  assert.equal(review.verification!.status, 'verified');
  await assert.rejects(extensions.install({ ...review, confirm: true }), /ApprovalRequired/);
  const installed = await extensions.install({
    ...review,
    confirm: true,
    approval: { fingerprint: review.verification!.fingerprint },
  });
  assert.equal(installed.plugins.length, 1);
});

test('the official extension verifies against the public publisher identity shipped with Blode', async () => {
  const pack = await readExtensionSource(path.resolve('extensions/plugins/Personalization'));
  const result = verifyPackageFiles(pack.files, {
    kind: 'extension',
    id: pack.manifest.id,
    version: pack.manifest.version,
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.publisher, 'Blode Studio');
});

test('OBE binds every file, metadata and publisher to a trusted public key', () => {
  const files = new Map([
    ['src/模块.c', Buffer.from('int answer=42;')],
    ['README.md', Buffer.from('Read me')],
  ]);
  const obe = signObe(records(files), subject, privatePem);
  const checked = verifyObe(records(files), obe, subject, keys);
  assert.equal(checked.status, 'verified');
  assert.equal(checked.trusted, true);
  assert.equal(verifyObe(records(files), obe, subject, []).status, 'untrusted');
  assert.equal(verifyObe(records(files), undefined).status, 'unsigned');
  const edited = JSON.parse(obe.toString());
  edited.subject.version = '2.0';
  assert.equal(
    verifyObe(records(files), Buffer.from(JSON.stringify(edited)), subject, keys).status,
    'invalid',
  );
  for (const changed of [
    new Map([...files, ['extra.exe', Buffer.from('payload')]]),
    new Map([['README.md', files.get('README.md')!]]),
    new Map([...files, ['src/模块.c', Buffer.from('int answer=99;')]]),
  ]) {
    const result = verifyObe(records(changed), obe, subject, keys);
    assert.equal(result.status, 'tampered');
    assert.equal(result.signatureValid, true);
    assert.equal(result.integrityValid, false);
  }
  assert.equal(verifyObe(records(files), obe, { ...subject, id: 'Other' }, keys).status, 'tampered');
});

test('approval is tied to the reviewed bytes and modified payloads need separate consent', () => {
  const files = new Map<string, Buffer>([['code.c', Buffer.from('int n;')]]);
  files.set('obe', signObe(records(files), subject, privatePem));
  const unknown = verifyPackageFiles(files, subject);
  assert.throws(() => assertPackageApproval(unknown), /ApprovalRequired/);
  assert.throws(
    () => assertPackageApproval(unknown, { fingerprint: unknown.fingerprint }),
    /ApprovalRequired/,
  );
  assertPackageApproval(unknown, { fingerprint: unknown.fingerprint, allowUntrusted: true });
  files.set('code.c', Buffer.from('int m;'));
  const modified = verifyPackageFiles(files, subject);
  assert.throws(
    () =>
      assertPackageApproval(modified, {
        fingerprint: unknown.fingerprint,
        allowUntrusted: true,
        allowModified: true,
      }),
    /ApprovalRequired/,
  );
  assert.throws(
    () => assertPackageApproval(modified, { fingerprint: modified.fingerprint, allowUntrusted: true }),
    /ApprovalRequired/,
  );
  assertPackageApproval(modified, {
    fingerprint: modified.fingerprint,
    allowUntrusted: true,
    allowModified: true,
  });
  assert.throws(() => signObe([{ path: '../escape', size: 0, sha256: '0'.repeat(64) }], subject, privatePem));
  assert.throws(() =>
    signObe(
      [
        { path: 'A.c', size: 0, sha256: '0'.repeat(64) },
        { path: 'a.c', size: 0, sha256: '0'.repeat(64) },
      ],
      subject,
      privatePem,
    ),
  );
});

test('signed tool ZIP round-trip preserves OBE; a changed binary requires explicit approval before install', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-obe-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = path.join(root, 'tools'),
    sdk = path.join(tools, 'versions/armcc/5.06-u5-b528');
  await fs.mkdir(path.join(sdk, 'bin'), { recursive: true });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['armcc', 'armasm', 'armlink', 'fromelf'])
    await fs.writeFile(path.join(sdk, 'bin', name + suffix), 'fixture compiler');
  await fs.writeFile(
    path.join(sdk, 'obe'),
    signObe(
      (await hashSignedDirectory(sdk)).records,
      { kind: 'tool', id: 'armcc:5.06-u5-b528', version: '5.06-u5-b528' },
      privatePem,
    ),
  );
  const options = {
    root: tools,
    dataRoot: path.join(root, 'data'),
    config: () => getBoardAdapter('STM32F103C8T6').createConfig(),
    env: { PATH: '', Path: '' },
    runner: async (file: string, args: string[], opts?: any) =>
      path.basename(file).toLowerCase() === 'armcc' + suffix
        ? { code: 0, output: 'ARM Compiler 5.06 update 5 (build 528)' }
        : runCommand(file, args, opts),
  };
  const inventory = await new ToolVersions(options).toolVersionsState();
  const offline = new OfflineTools(options);
  const archive = await offline.exportInstalled({
    id: inventory.localTools!.find((item) => item.kind === 'armcc')!.id,
    confirm: true,
  });
  const zip = offline.downloadFile(archive.id).path;
  const receiver = new OfflineTools({
    ...options,
    root: path.join(root, 'receiver'),
    enforceSignatures: true,
  });
  const original = await receiver.inspect(zip);
  assert.equal(original.status, 'untrusted');
  await assert.rejects(receiver.install({ path: zip, confirm: true }), /ApprovalRequired/);
  await receiver.install({
    path: zip,
    confirm: true,
    approval: { fingerprint: original.fingerprint, allowUntrusted: true },
  });
  assert.equal(
    (await fs.readFile(path.join(root, 'receiver/versions/armcc/5.06-u5-b528/obe'))).toString(),
    (await fs.readFile(path.join(sdk, 'obe'))).toString(),
  );
  const changed = readZip(await fs.readFile(zip));
  changed.set('files/bin/armcc' + suffix, Buffer.from('replaced compiler'));
  const changedZip = path.join(root, 'changed.zip');
  await writeZip(
    changedZip,
    (async function* () {
      for (const [path, data] of changed) yield { path, data };
    })(),
  );
  const other = new OfflineTools({ ...options, root: path.join(root, 'other'), enforceSignatures: true });
  const review = await other.inspect(changedZip);
  assert.equal(review.status, 'tampered');
  await assert.rejects(
    other.install({
      path: changedZip,
      confirm: true,
      approval: { fingerprint: review.fingerprint, allowUntrusted: true },
    }),
    /ApprovalRequired/,
  );
  await other.install({
    path: changedZip,
    confirm: true,
    approval: { fingerprint: review.fingerprint, allowUntrusted: true, allowModified: true },
  });
  assert.equal(
    await fs.readFile(path.join(root, 'other/versions/armcc/5.06-u5-b528/bin/armcc' + suffix), 'utf8'),
    'replaced compiler',
  );
});

test('a signed device module keeps its signature through export and cannot bypass installation review', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-obe-device-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'source');
  await fs.mkdir(directory);
  const original = getBoardAdapter('STM32F103C8T6').definition.runtimePlugin!;
  const manifest = {
    ...original,
    id: 'SignedDevice',
    languages: undefined,
    documentation: undefined,
    runtime: 'runtime.mjs',
    defaultConfig: { ...original.defaultConfig, boardId: 'SignedDevice' },
  };
  delete (manifest as { entry?: unknown }).entry;
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, 'runtime.mjs'), 'throw Error("inspection must not execute code")');
  await fs.writeFile(
    path.join(directory, 'obe'),
    signObe(
      (await hashSignedDirectory(directory)).records,
      { kind: 'device', id: manifest.id, version: manifest.version },
      privatePem,
    ),
  );
  const loaded = await readDevicePackage(directory);
  const sender = new DevicePackages({
    dataRoot: path.join(root, 'sender'),
    builtinRoot: '',
    plugins: async () => ({
      plugins: [
        {
          id: manifest.id,
          name: manifest.name,
          directory,
          manifest,
          trust: 'required',
          fingerprint: 'a'.repeat(64),
        },
      ],
      errors: [],
    }),
  });
  const archive = await sender.export({ id: manifest.id, confirm: true });
  assert.equal(
    verifyPackageFiles((await readDevicePackage(sender.download(archive.id).path)).files).status,
    'untrusted',
  );
  const receiver = new DevicePackages({
    dataRoot: path.join(root, 'receiver'),
    builtinRoot: '',
    plugins: async () => ({ plugins: [], errors: [] }),
    enforceSignatures: true,
  });
  const first = await receiver.review({ path: directory });
  await assert.rejects(receiver.install({ ...first, confirm: true }), /ApprovalRequired/);
  const second = await receiver.review({ path: directory });
  await receiver.install({
    ...second,
    confirm: true,
    approval: { fingerprint: second.verification!.fingerprint, allowUntrusted: true },
  });
  assert.deepEqual(
    await fs.readFile(path.join(root, 'receiver/plugins/SignedDevice/obe')),
    loaded.files.get('obe'),
  );
});
