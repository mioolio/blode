import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCore } from '../src/core/service';
import { getBoardAdapter } from '../extensions/registry';
import { persistConfig } from '../src/core/workspace';
import type { LogEvent } from '../src/shared/contracts';

test('invalid or error-level project language rules stop the build before running a compiler', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-language-build-'));
  const rulePath = 'languages/C/c17/rules.json';
  const events: LogEvent[] = [];
  let builds = 0;
  let core: Awaited<ReturnType<typeof createCore>> | undefined;
  try {
    await fs.mkdir(path.join(root, 'languages/C/c17'), { recursive: true });
    await persistConfig(root, getBoardAdapter('STM32F103C8T6').createConfig());
    await fs.writeFile(path.join(root, 'main.c'), 'int main(void) { forbidden(); return 0; }');
    await fs.writeFile(path.join(root, rulePath), '{ bad json');
    core = await createCore({
      projectRoot: root,
      dataRoot: path.join(root, '.blode'),
      onEvent: (event) => events.push(event),
      createRuntimes: () => [
        {
          id: 'STM32F103C8T6',
          transport: 'stlink',
          sourceInputs: [],
          invalidate() {},
          status: async () => ({
            arduinoCli: false,
            esp32Core: false,
            python: false,
            esptool: false,
            versions: {},
          }),
          discover: async () => [],
          probe: async () => {
            throw new Error('unexpected probe');
          },
          install: async () => {
            throw new Error('unexpected installation');
          },
          flash: async () => {
            throw new Error('unexpected flash');
          },
          build: async () => {
            builds++;
            throw new Error('unexpected compiler');
          },
        },
      ],
    });
    await assert.rejects(core.build(), /error.languageRulesInvalid/);
    assert.equal(builds, 0);
    assert.ok(events.some((event) => event.level === 'error' && event.message.startsWith(rulePath + ':')));
    await core.saveFile(
      rulePath,
      JSON.stringify({
        schemaVersion: 1,
        language: 'c',
        standard: 'c17',
        rules: [
          {
            id: 'forbidden',
            kind: 'call',
            names: ['forbidden'],
            severity: 'error',
            message: 'Use replacement',
            enabled: true,
          },
        ],
      }),
    );
    await assert.rejects(core.build(), /error.languageRulesInvalid/);
    assert.equal(builds, 0);
    assert.ok(
      events.some(
        (event) => event.message.startsWith('main.c:1:') && event.message.includes('Use replacement'),
      ),
    );
  } finally {
    await core?.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('build uses the selected module semantic rules without silently adding global C rules', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-module-language-build-'));
  const adapter = getBoardAdapter('STM32F103C8T6');
  const assets = adapter.languageAssets!;
  const assetPath = 'languages/C/c17/catalog.json';
  const previous = assets[assetPath];
  const events: LogEvent[] = [];
  let builds = 0;
  let core: Awaited<ReturnType<typeof createCore>> | undefined;
  try {
    assets[assetPath] = {
      schemaVersion: 1,
      language: 'cpp',
      rules: [
        {
          id: 'module-forbidden',
          kind: 'call',
          names: ['forbidden'],
          severity: 'error',
          message: 'Module rule',
        },
      ],
    };
    await persistConfig(root, adapter.createConfig());
    await fs.writeFile(path.join(root, 'main.c'), 'int main(void) { gets(0); forbidden(); return 0; }');
    core = await createCore({
      projectRoot: root,
      dataRoot: path.join(root, '.blode'),
      refreshDevices: false,
      onEvent: (event) => events.push(event),
      createRuntimes: () => [
        {
          id: 'STM32F103C8T6',
          transport: 'stlink',
          sourceInputs: [],
          invalidate() {},
          discover: async () => [],
          status: async () => ({
            arduinoCli: false,
            esp32Core: false,
            python: false,
            esptool: false,
            versions: {},
          }),
          install: async () => {
            throw Error('unexpected install');
          },
          probe: async () => {
            throw Error('unexpected probe');
          },
          flash: async () => {
            throw Error('unexpected flash');
          },
          build: async () => {
            builds++;
            return {
              success: false,
              flashUsed: 0,
              ramUsed: 0,
              flashTotal: 65536,
              ramTotal: 20480,
              artifacts: [],
              timestamp: '',
              output: 'fixture',
            };
          },
        },
      ],
    });
    await assert.rejects(core.build(), /languageRulesInvalid/);
    assert.equal(builds, 0);
    assert.ok(events.some((event) => event.message.includes('Module rule')));
    assert.equal(
      events.some((event) => event.message.includes('gets 已从')),
      false,
    );
    await core.saveFile('main.c', 'int main(void) { gets(0); return 0; }');
    await core.build();
    assert.equal(builds, 1);
    assets[assetPath] = { schemaVersion: 1, language: 'cpp', symbols: [{ kind: 'unknown' }] };
    await assert.rejects(core.build(), /languageRulesInvalid/);
    assert.equal(builds, 1);
    assert.ok(events.some((event) => event.message.includes('STM32F103C8T6/languages/C/c17/catalog.json:')));
  } finally {
    assets[assetPath] = previous;
    await core?.shutdown();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
