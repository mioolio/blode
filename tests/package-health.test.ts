import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { packageHealth } from '../src/shared/package-health';
import { DevicePackages } from '../src/core/device-packages';
import { getBoardAdapter } from '../extensions/registry';
import { hashSignedDirectory, signObe } from '../src/core/package-signing';

test('the component health model has only normal, abnormal and danger states', () => {
  assert.equal(packageHealth({ status: 'verified' }), 'normal');
  assert.equal(packageHealth({ status: 'unsigned' }), 'abnormal');
  assert.equal(packageHealth({ status: 'untrusted' }), 'abnormal');
  assert.equal(packageHealth({ status: 'invalid' }), 'danger');
  assert.equal(packageHealth({ status: 'tampered' }), 'danger');
});
test('visible module verification detects new tampering on every refresh without executing runtimes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'module');
  await fs.mkdir(directory);
  const manifest = { ...getBoardAdapter('STM32F103C8T6').definition.runtimePlugin!, id: 'Health_Board' };
  await fs.writeFile(path.join(directory, 'runtime.mjs'), 'throw Error("must never execute")');
  const manager = new DevicePackages({
    dataRoot: root,
    builtinRoot: path.join(root, 'builtin'),
    plugins: async () => ({
      plugins: [
        {
          id: manifest.id,
          name: manifest.name,
          manifest,
          directory,
          trust: 'required',
          fingerprint: 'a'.repeat(64),
        },
      ],
      errors: [],
    }),
  });
  assert.deepEqual(await manager.verify([manifest.id]), [{ id: manifest.id, health: 'abnormal' }]);
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await fs.writeFile(
    path.join(directory, 'obe'),
    signObe(
      (await hashSignedDirectory(directory)).records,
      { kind: 'device', id: manifest.id, version: manifest.version },
      pem,
    ),
  );
  assert.deepEqual(await manager.verify([manifest.id]), [{ id: manifest.id, health: 'abnormal' }]);
  await fs.writeFile(path.join(directory, 'runtime.mjs'), 'modified runtime');
  assert.deepEqual(await manager.verify([manifest.id]), [{ id: manifest.id, health: 'danger' }]);
  await fs.writeFile(path.join(directory, 'obe'), 'broken signature');
  assert.deepEqual(await manager.verify([manifest.id]), [{ id: manifest.id, health: 'danger' }]);
  await assert.rejects(manager.verify(['missing']), /devicePackageUnknown/);
  await assert.rejects(manager.verify(Array(26).fill(manifest.id)), /invalidArguments/);
});
