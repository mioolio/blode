import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { repairInstalledToolIntegrity } from '../src/core/tool-integrity';
import { InstallationTracker } from '../src/core/installation';
import type { LogEvent } from '../src/shared/contracts';

test('new tool integrity normalization stays within its private install staging tree', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows integrity labels');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-tool-labels-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const staged = path.join(root, 'staged'),
    child = path.join(staged, 'tool'),
    other = path.join(root, 'other');
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(other);
  await fs.writeFile(path.join(child, 'tool.exe'), 'fixture');
  const calls: { command: string; args: string[] }[] = [];
  const runner = async (command: string, args: string[]) => {
    calls.push({ command, args });
    return { code: 0, output: '' };
  };
  await assert.rejects(() => repairInstalledToolIntegrity(staged, staged, runner), /toolPackageExtract/);
  await assert.rejects(() => repairInstalledToolIntegrity(other, staged, runner), /toolPackageExtract/);
  assert.equal(calls.length, 0);
  await repairInstalledToolIntegrity(child, staged, runner);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [await fs.realpath(child), '/setintegritylevel', '(OI)(CI)M', '/T', '/L']);
});

test('download completion is retained as downloaded and never reported as installed', async () => {
  const events: LogEvent[] = [],
    tracker = new InstallationTracker((event) => events.push(event));
  await tracker.run('fixture', async () => {
    tracker.progress({
      tool: 'fixture',
      phase: 'downloading',
      operation: 'download',
      receivedBytes: 5,
      totalBytes: 10,
    });
    tracker.progress({ tool: 'fixture', phase: 'completed', operation: 'download' });
  });
  assert.equal(tracker.snapshot()?.operation, 'download');
  assert.equal(tracker.snapshot()?.status, 'completed');
  assert.equal(events.at(-1)?.message, 'status.downloadCompleted');
  assert.ok(!events.some((event) => event.message === 'status.installCompleted'));
});
