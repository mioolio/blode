import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiAssistance } from '../src/core/ai-assistance';
import { resolveCompletionCatalog } from '../src/shared/completion-catalog';
import { predictionMatches } from '../src/renderer/editor/inlineCompletions';
import type { AiPredictionContext } from '../src/shared/ai';

const context = (overrides: Partial<AiPredictionContext> = {}): AiPredictionContext => ({
  editorId: 'editor-1',
  projectRoot: 'C:/projects/demo',
  path: 'src/main.c',
  modelVersion: 1,
  line: 2,
  column: 4,
  prefix: 'int main() {\n  r',
  suffix: '\n}',
  ...overrides,
});
async function fixture(run: (service: AiAssistance, directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-ai-'));
  try {
    await run(new AiAssistance({ dataRoot: directory, projectRoot: () => 'C:/projects/demo' }), directory);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('blode-ai-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('prediction starts disabled and creates no request or model connection', () =>
  fixture(async (service) => {
    const state = await service.aiAssistanceState();
    assert.equal(state.predictionEnabled, false);
    assert.equal(state.useBuiltins, true);
    assert.deepEqual(state.entries, []);
    assert.equal(await service.aiPredictionRequest(context()), null);
    assert.deepEqual(await service.aiPredictionPoll(), { cursor: 0, requests: [] });
  }));

test('AI catalog inspection follows the selected module, including an explicitly empty catalog', () =>
  fixture(async (_service, directory) => {
    let empty = false;
    const service = new AiAssistance({
      dataRoot: directory,
      projectRoot: () => 'C:/projects/demo',
      builtins: async () =>
        empty
          ? []
          : [{ language: 'cpp', symbols: [{ name: 'module_only', kind: 'function', detail: 'Module' }] }],
    });
    assert.deepEqual(
      (await service.aiAssistanceState()).builtins.map((pack) => pack.symbols?.[0].name),
      ['module_only'],
    );
    empty = true;
    assert.deepEqual((await service.aiAssistanceState()).builtins, []);
  }));

test('catalog configuration persists atomically and rejects stale revisions', () =>
  fixture(async (service, directory) => {
    const updated = await service.aiAssistanceConfigure({
      revision: 0,
      entries: [
        {
          language: 'cpp',
          name: 'board_init',
          kind: 'function',
          detail: 'void board_init()',
          insertText: 'board_init();',
        },
      ],
    });
    assert.equal(updated.revision, 1);
    await assert.rejects(
      service.aiAssistanceConfigure({ revision: 0, predictionEnabled: true }),
      /aiRevisionConflict/,
    );
    const restored = await new AiAssistance({
      dataRoot: directory,
      projectRoot: () => 'C:/projects/demo',
    }).aiAssistanceState();
    assert.deepEqual(restored.entries, updated.entries);
    assert.equal(restored.predictionEnabled, false);
    assert.deepEqual(
      (await fs.readdir(directory)).filter((entry) => entry.endsWith('.tmp')),
      [],
    );
  }));

test('parallel catalog writers cannot overwrite another revision', () =>
  fixture(async (service) => {
    const results = await Promise.allSettled([
      service.aiAssistanceConfigure({ revision: 0, predictionEnabled: true }),
      service.aiAssistanceConfigure({ revision: 0, useBuiltins: false }),
    ]);
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal((await service.aiAssistanceState()).revision, 1);
  }));

test('duplicate completion keys are rejected and catalog reset keeps prediction preference', () =>
  fixture(async (service) => {
    const entry = { language: 'cpp', name: 'LED', kind: 'constant' as const, detail: 'LED pin' };
    await assert.rejects(
      service.aiAssistanceConfigure({ revision: 0, entries: [entry, entry] }),
      /aiDuplicateEntry/,
    );
    await service.aiAssistanceConfigure({
      revision: 0,
      useBuiltins: false,
      entries: [entry],
      predictionEnabled: true,
    });
    const reset = await service.aiAssistanceConfigure({ revision: 1, resetCatalog: true });
    assert.deepEqual(reset.entries, []);
    assert.equal(reset.useBuiltins, true);
    assert.equal(reset.predictionEnabled, true);
  }));

test('typing invalidates prior suggestions; AI may answer only the latest editor snapshot', () =>
  fixture(async (service) => {
    await service.aiAssistanceConfigure({ revision: 0, predictionEnabled: true });
    const first = (await service.aiPredictionRequest(context()))!;
    await service.aiPredictionSubmit({ requestId: first.id, text: 'eturn 0;' });
    assert.equal((await service.aiPredictionRead({ requestId: first.id }))?.text, 'eturn 0;');
    const next = (await service.aiPredictionRequest(
      context({ modelVersion: 2, column: 5, prefix: 'int main() {\n  re' }),
    ))!;
    assert.equal(await service.aiPredictionRead({ requestId: first.id }), null);
    await assert.rejects(
      service.aiPredictionSubmit({ requestId: first.id, text: 'eturn 1;' }),
      /aiPredictionStale/,
    );
    const poll = await service.aiPredictionPoll({ after: first.sequence });
    assert.deepEqual(
      poll.requests.map((item) => item.id),
      [next.id],
    );
    await service.aiPredictionCancel({ editorId: next.editorId, requestId: first.id });
    assert.equal((await service.aiPredictionPoll()).requests.length, 1);
    await service.aiPredictionCancel({ editorId: next.editorId, requestId: next.id });
    assert.equal((await service.aiPredictionPoll()).requests.length, 0);
  }));

test('disabled, expired or switched-project requests cannot be answered', () =>
  fixture(async (_unused, directory) => {
    let clock = Date.now();
    let root = 'C:/projects/demo';
    const service = new AiAssistance({ dataRoot: directory, projectRoot: () => root, now: () => clock });
    await service.aiAssistanceConfigure({ revision: 0, predictionEnabled: true });
    const request = (await service.aiPredictionRequest(context()))!;
    clock += 60_001;
    await assert.rejects(
      service.aiPredictionSubmit({ requestId: request.id, text: 'return;' }),
      /aiPredictionStale/,
    );
    const next = (await service.aiPredictionRequest(context()))!;
    root = 'C:/projects/other';
    await assert.rejects(
      service.aiPredictionSubmit({ requestId: next.id, text: 'return;' }),
      /aiPredictionStale/,
    );
    await service.aiAssistanceConfigure({ revision: 1, predictionEnabled: false });
    assert.deepEqual((await service.aiPredictionPoll()).requests, []);
  }));

test('catalog overrides, suppressions and member entries remain declarative', () => {
  const packs = resolveCompletionCatalog(
    [
      {
        language: 'cpp',
        symbols: [
          { name: 'LED', kind: 'constant', detail: 'old' },
          { name: 'OLD', kind: 'constant', detail: 'remove' },
        ],
      },
    ],
    [
      { language: 'cpp', name: 'LED', kind: 'constant', detail: 'new' },
      { language: 'cpp', name: 'OLD', kind: 'constant', detail: '', disabled: true },
      { language: 'cpp', owner: 'Board', name: 'start', kind: 'method', detail: 'void start()' },
    ],
    true,
  );
  assert.deepEqual(
    packs[0]?.symbols?.map((entry) => [entry.name, entry.detail]),
    [['LED', 'new']],
  );
  assert.equal(packs[0]?.members?.[0]?.owner, 'Board');
  assert.deepEqual(resolveCompletionCatalog(packs, [], false), []);
});

test('a cancellation during asynchronous project lookup cannot resurrect a suggestion', () =>
  fixture(async (_unused, directory) => {
    let delayed = false;
    let release!: (value: string) => void;
    let started!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new AiAssistance({
      dataRoot: directory,
      projectRoot: () =>
        delayed
          ? new Promise<string>((resolve) => {
              release = resolve;
              started();
            })
          : 'C:/projects/demo',
    });
    await service.aiAssistanceConfigure({ revision: 0, predictionEnabled: true });
    const request = (await service.aiPredictionRequest(context()))!;
    delayed = true;
    const submission = service.aiPredictionSubmit({ requestId: request.id, text: 'return 0;' });
    await lookupStarted;
    await service.aiPredictionCancel({ editorId: request.editorId, requestId: request.id });
    release('C:/projects/demo');
    await assert.rejects(submission, /aiPredictionStale/);
  }));

test('prediction acceptance requires unchanged source version, path and cursor', () => {
  const request = {
    ...context(),
    id: 'request',
    sequence: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.equal(predictionMatches(request, context()), true);
  assert.equal(predictionMatches(request, context({ modelVersion: 2 })), false);
  assert.equal(predictionMatches(request, context({ column: 5 })), false);
  assert.equal(predictionMatches(request, context({ path: 'other.c' })), false);
});
