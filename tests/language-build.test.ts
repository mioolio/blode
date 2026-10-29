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
