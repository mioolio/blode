import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportProbeLog } from '../src/core/log-export';
import { MAX_PROBE_LOG_BYTES, probeLogFilename, validateProbeLog } from '../src/shared/probe-log';

test('log export validates encoded size and uses a generated Windows-safe log filename', () => {
  assert.equal(
    probeLogFilename(new Date('2026-10-29T01:02:03.456Z')),
    'blode-probe-2026-10-29T01-02-03-456Z.log',
  );
  assert.doesNotThrow(() => validateProbeLog('x'.repeat(MAX_PROBE_LOG_BYTES)));
  assert.throws(() => validateProbeLog('中'.repeat(Math.ceil(MAX_PROBE_LOG_BYTES / 3))), /logExportTooLarge/);
  assert.throws(() => validateProbeLog({ content: 'log' }), /logExportTooLarge/);
});

test('native log export saves only after a destination is selected and leaves cancellation untouched', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-log-export-'));
  const projectRoot = path.join(temporary, 'project');
  const dataRoot = path.join(temporary, 'data');
  await fs.mkdir(projectRoot);
  const destination = path.join(projectRoot, 'chosen.log');
  try {
    const options = { content: '探测日志\nCOM3: no response\n', projectRoot, dataRoot };
    assert.equal(
      await exportProbeLog({
        ...options,
        choosePath: async (suggested) => {
          assert.equal(path.dirname(suggested), projectRoot);
          assert.match(path.basename(suggested), /^blode-probe-[\dTZ.-]+\.log$/);
          return undefined;
        },
      }),
      'cancelled',
    );
    assert.deepEqual(await fs.readdir(projectRoot), []);
    assert.equal(await exportProbeLog({ ...options, choosePath: async () => destination }), 'saved');
    assert.equal(await fs.readFile(destination, 'utf8'), options.content);
    // A failed write rejects, so the caller cannot report successful completion.
    await assert.rejects(exportProbeLog({ ...options, choosePath: async () => projectRoot }));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('an unusable project directory falls back to application exports and oversized logs never open a dialog', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-log-export-'));
  const projectRoot = path.join(temporary, 'not-a-directory');
  const dataRoot = path.join(temporary, 'data');
  await fs.writeFile(projectRoot, 'existing project data');
  let selected = '';
  try {
    const options = {
      projectRoot,
      dataRoot,
      choosePath: async (suggested: string) => {
        selected = suggested;
        return suggested;
      },
    };
    await assert.rejects(
      exportProbeLog({ ...options, content: '中'.repeat(MAX_PROBE_LOG_BYTES) }),
      /logExportTooLarge/,
    );
    assert.equal(selected, '');
    assert.equal(await exportProbeLog({ ...options, content: 'log' }), 'saved');
    assert.equal(path.dirname(selected), path.join(dataRoot, 'exports'));
    assert.equal(await fs.readFile(selected, 'utf8'), 'log');
    assert.equal(await fs.readFile(projectRoot, 'utf8'), 'existing project data');
    assert.equal((await fs.readdir(path.dirname(selected))).length, 1);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
