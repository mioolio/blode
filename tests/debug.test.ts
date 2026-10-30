import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import {
  classifyDebugShortcut,
  installDebugControls,
  loadAppConfig,
  type DebugConfig,
  type DebugShortcutInput,
} from '../src/core/debug';

const enabled: DebugConfig = { enabled: true, openDevToolsOnStart: false };
const input = (key: string, modifiers: Partial<DebugShortcutInput> = {}): DebugShortcutInput => ({
  type: 'keyDown',
  key,
  ...modifiers,
});

describe('explicit debug shortcuts', () => {
  it('leaves Ctrl+R and function keys with a focused terminal, then restores reload after blur', () => {
    const calls: string[] = [];
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      reload: () => calls.push('reload'),
      reloadIgnoringCache: () => calls.push('reloadIgnoringCache'),
      toggleDevTools: () => calls.push('devtools'),
    });
    const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
    let terminalFocused = true;
    const dispose = installDebugControls(window as unknown as BrowserWindow, enabled, () => terminalFocused);
    const fire = (event: DebugShortcutInput) => {
      let prevented = false;
      contents.emit(
        'before-input-event',
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        event,
      );
      return prevented;
    };
    for (const event of [
      input('r', { control: true }),
      input('r', { control: true, shift: true }),
      input('F5'),
    ])
      assert.equal(fire(event), false, 'terminal input must reach its shell');
    assert.deepEqual(calls, []);
    assert.equal(fire(input('F12')), true);
    assert.deepEqual(calls, ['devtools']);
    terminalFocused = false;
    assert.equal(fire(input('r', { control: true })), true);
    assert.equal(fire(input('r', { control: true, shift: true })), true);
    assert.deepEqual(calls, ['devtools', 'reload', 'reloadIgnoringCache']);
    dispose();
    assert.equal(contents.listenerCount('before-input-event'), 0);
    assert.equal(window.listenerCount('closed'), 0);
    assert.equal(fire(input('r', { control: true })), false);
  });
  it('distinguishes ordinary reload, forced reload and developer tools', () => {
    assert.equal(classifyDebugShortcut(enabled, input('F12')), 'toggleDevTools');
    assert.equal(classifyDebugShortcut(enabled, input('F5')), 'reload');
    assert.equal(classifyDebugShortcut(enabled, input('r', { control: true })), 'reload');
    assert.equal(classifyDebugShortcut(enabled, input('F5', { control: true })), 'reloadIgnoringCache');
    assert.equal(
      classifyDebugShortcut(enabled, input('R', { control: true, shift: true })),
      'reloadIgnoringCache',
    );
  });
  it('does not capture typing, save/build shortcuts or unrelated function-key modifiers', () => {
    for (const event of [
      input('r'),
      input('s', { control: true }),
      input('b', { control: true, shift: true }),
      input('F12', { control: true }),
      input('F5', { shift: true }),
      input('F5', { alt: true }),
      input('F12', { meta: true }),
    ]) {
      assert.equal(classifyDebugShortcut(enabled, event), null);
    }
  });
  it('never repeats a held shortcut and does not act on key release or when disabled', () => {
    assert.equal(classifyDebugShortcut(enabled, input('F12', { isAutoRepeat: true })), null);
    assert.equal(classifyDebugShortcut(enabled, input('F5', { type: 'keyUp' })), null);
    for (const key of ['F12', 'F5', 'r'])
      assert.equal(
        classifyDebugShortcut({ ...enabled, enabled: false }, input(key, { control: key === 'r' })),
        null,
      );
  });
});

describe('application debug configuration', () => {
  it('uses fresh defaults for a missing file and fills omitted boolean options', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-debug-defaults-'));
    try {
      const file = path.join(root, 'application.json');
      const defaults = await loadAppConfig(file);
      assert.deepEqual(defaults, {
        debug: enabled,
        web: { enabled: true, allowExternal: false },
      });
      defaults.debug.enabled = false;
      assert.equal((await loadAppConfig(file)).debug.enabled, true);
      await fs.writeFile(file, JSON.stringify({ debug: { openDevToolsOnStart: true } }));
      assert.deepEqual(await loadAppConfig(file), {
        debug: { enabled: true, openDevToolsOnStart: true },
        web: { enabled: true, allowExternal: false },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('rejects invalid JSON, unknown keys and string booleans without silently enabling debug', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-debug-invalid-'));
    try {
      const file = path.join(root, 'application.json');
      for (const source of [
        '{bad',
        '{"debug":{"enabled":"false"}}',
        '{"debug":{"enabled":true,"arbitraryCommand":"x"}}',
        '{"debug":{},"unknown":true}',
      ]) {
        await fs.writeFile(file, source);
        await assert.rejects(loadAppConfig(file), /error.invalidApplicationConfig/);
      }
      await fs.writeFile(file, JSON.stringify({ debug: { enabled: false } }));
      assert.equal((await loadAppConfig(file)).debug.enabled, false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
