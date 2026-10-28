import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getContextMenu } from '../extensions/menus';
import type { MenuTarget } from '../extensions/menus/types';
import type { AppState, ProjectBuildInputs } from '../src/shared/contracts';
import { ProjectExplorer } from '../src/renderer/components/ProjectExplorer';
import type { Studio } from '../src/renderer/workspace/useStudio';

function renderExplorer(build: ProjectBuildInputs): string {
  const state = {
    projectRoot: '/project',
    workspaceOpen: true,
    build,
    files: [{ path: 'src/main.c', language: 'c', content: 'int main(void) {}' }],
    inventory: {
      entries: [
        { path: 'src', kind: 'directory', size: 0, editable: false },
        { path: 'src/main.c', kind: 'file', size: 17, editable: true },
      ],
      totalBytes: 17,
      fileCount: 1,
      directoryCount: 1,
      truncated: false,
    },
  } as AppState;
  const studio: Partial<Studio> = {
    t: (key) => key,
    state,
    activePath: 'src/main.c',
    view: 'code',
    drafts: {},
    busy: '',
    dirty: false,
    configDirty: false,
    setBuildEntry: async () => {
      throw new Error('Rendering must not change the entry');
    },
    build: async () => {
      throw new Error('Rendering must not start a build');
    },
  };
  return renderToStaticMarkup(createElement(ProjectExplorer, { studio: studio as Studio }));
}

test('the explorer exposes Set as build entry for files, folders and the project root', () => {
  for (const target of ['file', 'folder', 'root'] as MenuTarget[]) {
    const commands = getContextMenu('explorer')
      .filter((entry) => !entry.separator && (!entry.when || entry.when.includes(target)))
      .filter((entry) => !entry.separator)
      .map((entry) => entry.command);
    assert.ok(commands.includes('explorer.setBuildEntry'), target);
  }
});

test('the selected source file is marked as the entry without changing or building the project', () => {
  const html = renderExplorer({ entry: 'src/main.c' });
  assert.match(html, /title="src\/main\.c · project\.buildEntry"/);
  assert.match(html, /is-file active is-build-entry/);
  assert.equal((html.match(/class="tree-build-entry"/g) ?? []).length, 1);
});

test('folder entries remain compatible with build.sketch and explicit root entries take precedence', () => {
  const legacy = renderExplorer({ sketch: 'src' });
  assert.match(legacy, /title="src · project\.buildEntry"/);
  assert.match(legacy, /is-directory  is-build-entry/);
  const root = renderExplorer({ entry: '.', sketch: 'src' });
  assert.match(root, /title="\/project · project\.buildEntry"/);
  assert.doesNotMatch(root, /title="src · project\.buildEntry"/);
  assert.equal((root.match(/class="tree-build-entry"/g) ?? []).length, 1);
});
