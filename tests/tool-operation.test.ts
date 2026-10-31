import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstallationTracker } from '../src/core/installation';
import { InstallationOutput } from '../src/renderer/components/InstallationOutput';
import type { LogEvent } from '../src/shared/contracts';

test('export has correct operation labels from its first event and does not duplicate phase messages', async () => {
  const events: LogEvent[] = [];
  const tracker = new InstallationTracker((event) => events.push(event));
  await tracker.run(
    'installed:armclang:fixture',
    async () => {
      tracker.progress({ tool: 'Arm Compiler 6.22', operation: 'export', phase: 'starting' });
      tracker.progress({ tool: 'Arm Compiler 6.22', operation: 'export', phase: 'collecting' });
      tracker.progress({ tool: 'Arm Compiler 6.22', operation: 'export', phase: 'packing', percent: 20 });
      tracker.progress({ tool: 'Arm Compiler 6.22', operation: 'export', phase: 'packing', percent: 75 });
      const active = renderToStaticMarkup(
        createElement(InstallationOutput, { installation: tracker.snapshot() }),
      );
      assert.match(active, /正在压缩文件/);
      assert.match(active, /aria-valuenow="75"/);
      assert.doesNotMatch(active, /准备安装|安装完成/);
      tracker.progress({ tool: 'Arm Compiler 6.22', operation: 'export', phase: 'verifying' });
      tracker.progress({ tool: 'Arm Compiler 6.22', operation: 'export', phase: 'completed' });
    },
    'export',
  );
  assert.equal(events[0].installation?.operation, 'export');
  assert.equal(events[0].message, 'status.exportStarting');
  const messages = tracker.snapshot()!.logs.map((event) => event.message);
  assert.equal(messages.filter((message) => message === 'status.exportStarting').length, 1);
  assert.equal(messages.filter((message) => message === 'status.exportPacking').length, 1);
  assert.equal(messages.filter((message) => message === 'status.exportCompleted').length, 1);
  assert.ok(!events.some((event) => event.message.startsWith('status.install')));
  const completed = renderToStaticMarkup(
    createElement(InstallationOutput, { installation: tracker.snapshot() }),
  );
  assert.match(completed, /工具链导出|导出完成/);
  assert.doesNotMatch(completed, /准备安装|安装完成/);
});
