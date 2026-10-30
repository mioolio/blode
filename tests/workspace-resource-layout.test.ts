import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { esp32S3Adapter } from '../extensions/boards/Esp32_S3_CAM/device/adapter';
import { ConsolePanel } from '../src/renderer/components/ConsolePanel';
import { CollaborationAvatars } from '../src/renderer/components/CollaborationStatus';
import { ProjectExplorer } from '../src/renderer/components/ProjectExplorer';
import type { Studio } from '../src/renderer/workspace/useStudio';
import type { CollaborationPeer } from '../src/shared/collaboration';
import { workspaceConsoleTabs } from '../src/shared/workspace-surfaces';
import { translate } from '../src/renderer/i18n';

function fixture(tab: 'resources' = 'resources'): Studio {
  const config = esp32S3Adapter.createConfig();
  return {
    t: (key: string) => key,
    tab,
    config,
    state: {
      workspaceOpen: true,
      projectRoot: '/workspace/project',
      boards: [esp32S3Adapter.definition],
      config,
      inventory: {
        entries: [{ path: 'main.cpp', kind: 'file', size: 1024, editable: true }],
        totalBytes: 1024,
        fileCount: 1,
        directoryCount: 0,
        truncated: false,
      },
      files: [],
      build: {},
      ports: [],
      toolchain: {},
    },
    board: esp32S3Adapter.definition,
    activePath: '',
    drafts: {},
    logs: [{ time: new Date().toISOString(), level: 'info', message: 'compiler-only-output' }],
    errors: [],
    warnings: [],
    consolePanelVisible: true,
    devicePanelVisible: true,
    busy: '',
    runtimeExpanded: false,
  } as unknown as Studio;
}

test('registered usage panels render their content without clear-log actions or compiler output', () => {
  for (const tab of ['resources'] as const) {
    const html = renderToStaticMarkup(createElement(ConsolePanel, { studio: fixture(tab) }));
    for (const registered of workspaceConsoleTabs) assert.match(html, new RegExp(`console\.${registered}`));
    assert.match(html, new RegExp(`console-resource-view resource-view-${tab}`));
    assert.match(html, /memory-meter flash/);
    assert.match(html, /project-usage/);
    assert.doesNotMatch(html, /console\.memory|console\.project/);
    assert.doesNotMatch(html, /log-scroll|compiler-only-output|lucide-trash-2|console-empty/);
    assert.ok(html.includes(`aria-label="${translate('zh-CN', 'view.hideConsolePanel')}"`));
  }
});

test('project-only usage tabs disappear on the welcome page', () => {
  const studio = fixture('resources');
  studio.state!.workspaceOpen = false;
  const html = renderToStaticMarkup(createElement(ConsolePanel, { studio }));
  assert.doesNotMatch(html, /console\.resources|console-resource-view/);
  assert.match(html, /console\.output/);
  assert.match(html, /console\.serial/);
});

test('runtime selector follows the file tree as its own collapsible footer', () => {
  const html = renderToStaticMarkup(createElement(ProjectExplorer, { studio: fixture('resources') }));
  assert.ok(html.indexOf('class="runtime-selector"') > html.indexOf('class="file-tree explorer-tree"'));
  assert.match(html, /<details class="runtime-selector"><summary>/);
  assert.doesNotMatch(html, /runtime-support|runtime-modules/);
});

test('collaborator stack caps individual avatars and orders overlap before the overflow count', () => {
  const peers: CollaborationPeer[] = Array.from({ length: 6 }, (_, index) => ({
    userId: `user-${index}`,
    peerId: `peer-${index}`,
    name: `User ${index + 1}`,
    path: 'main.cpp',
    color: '#2563eb',
    editing: index === 0,
    startLine: 1,
    endLine: 10,
    seenAt: new Date().toISOString(),
  }));
  const html = renderToStaticMarkup(createElement(CollaborationAvatars, { peers, path: 'main.cpp' }));
  assert.equal((html.match(/class="collaboration-avatar(?: editing)?"/g) ?? []).length, 3);
  assert.match(html, /z-index:3/);
  assert.match(html, /z-index:2/);
  assert.match(html, /z-index:1/);
  assert.match(html, /collaboration-overflow[^]*>\+3<\/span>/);
});
