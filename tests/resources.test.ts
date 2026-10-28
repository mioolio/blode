import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectFootprint } from '../src/renderer/workspace/resources';
import { MemoryUsage } from '../src/renderer/components/MemoryUsage';
import { I18nProvider } from '../src/renderer/i18n';
import { esp32S3Adapter } from '../extensions/boards/esp32-s3/adapter';

test('project footprint counts binary files, UTF-8 drafts, and real directory distribution', () => {
  const inventory = {
    entries: [
      { path: 'assets', kind: 'directory' as const, size: 0, editable: false },
      { path: 'assets/table.bin', kind: 'file' as const, size: 2048, editable: false },
      { path: 'main.ino', kind: 'file' as const, size: 3, editable: true },
    ],
    totalBytes: 2051,
    fileCount: 2,
    directoryCount: 1,
    truncated: false,
  };
  const result = projectFootprint(inventory, [], { 'main.ino': '你好' });
  assert.equal(result.totalBytes, 2054);
  assert.equal(result.fileCount, 2);
  assert.equal(result.directoryCount, 1);
  assert.deepEqual(
    result.groups.map((group) => [group.path, group.bytes]),
    [
      ['assets', 2048],
      ['/', 6],
    ],
  );
  assert.equal(inventory.totalBytes, 2051);
});

test('before first build resource panel displays actual configured budgets without inventing usage', () => {
  const config = esp32S3Adapter.createConfig();
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      children: createElement(MemoryUsage, { state: null, config, drafts: {}, stale: false }),
    }),
  );
  assert.match(html, /8 MiB/);
  assert.match(html, /3 MiB/);
  assert.match(html, /未编译|等待|待测|待计算/);
  assert.doesNotMatch(html, /0\.0%/);
});
