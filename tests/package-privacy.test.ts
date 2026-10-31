import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectProjectPackage, ProjectPackages } from '../src/core/project-package';
import { readComponentZip } from '../src/core/component-zip';
test('project delivery excludes host model credentials and profiles while retaining model-service source code', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-package-privacy-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project'),
    data = path.join(root, 'exports'),
    profile = path.join(project, 'custom-host-profile');
  await fs.mkdir(project);
  await fs.mkdir(data);
  await fs.mkdir(profile);
  const files = {
    'main.c': 'int main(void){return 0;}',
    'model-service.json': '{"apiKey":"SENTINEL-DO-NOT-SHARE"}',
    'model-credentials/private.credential': 'SENTINEL-DO-NOT-SHARE',
    'custom-host-profile/private.json': 'SENTINEL-DO-NOT-SHARE',
    'src/core/model-service/index.ts': 'export const source = true;',
    '.env': 'SECRET=not-shared',
    '.env.example': 'SECRET=example',
    '.signing/blode-studio-ed25519.pem': 'SENTINEL-DO-NOT-SHARE',
    '.signing/windows-signing.json': 'SENTINEL-DO-NOT-SHARE',
    '.signing/blode-studio.pfx': 'SENTINEL-DO-NOT-SHARE',
  };
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(project, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  const plan = await collectProjectPackage(project, { privateRoots: [profile] });
  assert.ok(plan.plan.files.some((file) => file.destination === 'src/core/model-service/index.ts'));
  assert.ok(plan.plan.files.some((file) => file.destination === '.env.example'));
  assert.ok(
    !plan.plan.files.some((file) =>
      /credential|model-service.json|custom-host-profile|^\.env$/.test(file.destination),
    ),
  );
  const manager = new ProjectPackages({
    dataRoot: data,
    projectRoot: () => project,
    privateRoots: () => [profile],
  });
  const result = await manager.export({});
  const zip = readComponentZip(await fs.readFile(manager.file(result.id).path));
  for (const bytes of zip.values()) assert.ok(!bytes.includes(Buffer.from('SENTINEL-DO-NOT-SHARE')));
});
