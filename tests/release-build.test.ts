import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseVersions, releaseNotes } from '../scripts/build-release.mjs';

test('one-click release maps Windows versions to npm versions and rejects unsafe or invalid input', () => {
  assert.deepEqual(releaseVersions(' 0.3.5.9 '), { version: '0.3.5-9', releaseVersion: '0.3.5.9' });
  for (const value of ['0.3.5', '0.3.5.09', '1.2.3.65536', '../release', '0.3.5.9 & echo bad', ''])
    assert.throws(() => releaseVersions(value));
});

test('release notes reuse only unreleased changes and name all three editions', () => {
  const notes = releaseNotes(
    '0.3.5.9',
    '# Changelog\n\n## 未发布\n\n- New feature\n\n## 0.3.5.2\n\n- Old change',
    '2026-11-01',
  );
  assert.match(notes, /New feature/);
  assert.doesNotMatch(notes, /Old change/);
  assert.match(notes, /desktop-win-x64.exe/);
  assert.match(notes, /web-win-x64.exe/);
  assert.match(notes, /web-node-win-x64.zip/);
  assert.match(notes, /2026-11-01/);
});
