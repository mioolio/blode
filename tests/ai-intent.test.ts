import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { aiSourceLabel, aiSourceLines } from '../src/shared/ai-context';
import { advancePrediction } from '../src/renderer/editor/predictionContinuation';
import {
  cleanPrediction,
  predictionHeaders,
  predictionInput,
  predictionInstructions,
} from '../src/core/model-service/prediction-context';
import { modelServiceParameterSchemas } from '../src/core/model-service/schemas';
import type { AiPredictionRequest } from '../src/shared/ai';

test('reference labels use selected line ranges with an exclusive ending, including CRLF and Chinese', () => {
  const source = {
    path: 'src/main.c',
    content: '// 中文\r\nint a;\r\nint b;\r\n',
    selection: { start: 7, end: 15 },
  };
  assert.deepEqual(aiSourceLines(source), { startLine: 2, endLine: 2 });
  assert.equal(aiSourceLabel(source), 'main.c:L2');
  assert.equal(aiSourceLabel({ ...source, selection: { start: 7, end: 22 } }), 'main.c:L2–L3');
});

test('typing through a prediction keeps the untyped portion, while deletion and unrelated edits invalidate it', () => {
  const before = 'int ma)';
  assert.deepEqual(advancePrediction(before, 6, 'in(void', 'int main)'), {
    offset: 8,
    text: '(void',
    line: 1,
    column: 9,
  });
  assert.equal(advancePrediction(before, 6, 'in(void', 'int maz)'), null);
  assert.equal(advancePrediction(before, 6, 'in(void', 'int m)'), null);
  assert.equal(advancePrediction(before, 6, 'in(void', 'Xint main)'), null);
  assert.deepEqual(advancePrediction('a', 1, '\n  b', 'a\r\n'), {
    offset: 3,
    text: '  b',
    line: 2,
    column: 1,
  });
});

test('completion output removes fences, echoed prefixes and suffix overlap without stripping useful indentation', () => {
  assert.equal(cleanPrediction('void main() {\n}', { prefix: 'void ma', suffix: '' }), 'in() {\n}');
  assert.equal(cleanPrediction('```cpp\nvalue);\n```', { prefix: 'print(', suffix: ');' }), 'value');
  assert.equal(cleanPrediction('  work();\n', { prefix: '//下一步\n', suffix: '' }), '  work();\n');
  assert.match(predictionInstructions, /not answer a chat message/);
});

test('reference context stays bounded and cannot change the selection edit target', () => {
  const request = {
    projectRoot: '/project',
    scope: 'selection',
    intent: 'edit',
    prompt: 'fix',
    source: { path: 'main.c', content: 'abc', selection: { start: 0, end: 1 } },
    confirm: true,
    references: [{ path: 'inc/device.h', content: 'void init(void);' }],
  };
  assert.equal(modelServiceParameterSchemas['ai.chat.start'].safeParse(request).success, true);
  for (const references of [
    Array(9).fill(request.references[0]),
    [{ path: '../outside.h', content: '' }],
    [{ path: 'C:/private.h', content: '' }],
    Array.from({ length: 8 }, (_, i) => ({ path: `${i}.h`, content: 'x'.repeat(10000) })),
  ]) {
    assert.equal(
      modelServiceParameterSchemas['ai.chat.start'].safeParse({ ...request, references }).success,
      false,
    );
  }
});

test('intent context resolves only direct workspace headers, refreshes modified declarations and stops on cancellation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-intent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/device.h'), 'void camera_sleep(void);');
  const request = {
    projectRoot: root,
    path: 'src/main.c',
    language: 'c',
    documentHead: '#include "device.h"\n#include "../../private.h"',
    prefix: '// 降低功耗\n',
    suffix: '\n}',
    line: 3,
    column: 1,
    recentEdits: [{ before: '', after: '// 降低功耗' }],
  } as AiPredictionRequest;
  const related = await predictionHeaders(request, new AbortController().signal);
  assert.deepEqual(related, [{ file: 'src/device.h', declarations: 'void camera_sleep(void);' }]);
  assert.deepEqual(predictionInput(request, related).recentEdits, request.recentEdits);
  assert.equal(predictionInput({ ...request, prefix: '// 发送完成后' }, []).cursorContext, 'line-comment');
  assert.equal(
    predictionInput({ ...request, prefix: '设备会', language: 'markdown' }, []).cursorContext,
    'prose',
  );
  await fs.writeFile(path.join(root, 'src/device.h'), 'void camera_shutdown(void);');
  assert.match(
    (await predictionHeaders(request, new AbortController().signal))[0].declarations,
    /camera_shutdown/,
  );
  await assert.rejects(predictionHeaders(request, AbortSignal.abort()));
});
