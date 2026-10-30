import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ModelService } from '../src/core/model-service';
import { ModelCredentials } from '../src/core/model-service/credentials';
import { ModelProviderClient } from '../src/core/model-service/provider';
import { CollaborationService } from '../src/core/collaboration';
import type { AiChatSession } from '../src/shared/model-service';
import { AiAssistance } from '../src/core/ai-assistance';

const fakeKey = 'test-only-model-credential';
const response = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
    headers: { 'content-type': 'application/json' },
  });
async function fixture(t: TestContext, content = 'before SELECT after\n') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-model-test-'));
  const root = path.join(temporary, 'project'),
    data = path.join(temporary, 'profile');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'main.c'), content);
  let currentRoot = root;
  const collaboration = new CollaborationService({
    workspace: async () => ({
      projectRoot: currentRoot,
      files: await Promise.all(
        (await fs.readdir(root))
          .filter((file) => file.endsWith('.c'))
          .map(async (file) => ({ path: file, content: await fs.readFile(path.join(root, file), 'utf8') })),
      ),
    }),
    saveFile: async (file, text) => fs.writeFile(path.join(root, file), text),
    publish() {},
  });
  const calls: { url: string; body: any; authorization: string | null }[] = [];
  const commands: string[][] = [];
  let fetcher: typeof fetch = async () =>
    response(JSON.stringify({ replacement: 'CHANGED', explanation: '已修改' }));
  const service = new ModelService({
    dataRoot: data,
    projectRoot: () => currentRoot,
    collaboration,
    command: async (command, args) => {
      commands.push([command, ...args]);
      return { code: 0, output: 'test command completed' };
    },
    credentials: new ModelCredentials({ directory: path.join(data, 'model-credentials'), platform: 'linux' }),
    fetcher: async (url, options) => {
      calls.push({
        url: String(url),
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
        authorization: new Headers(options?.headers).get('authorization'),
      });
      return fetcher(url, options);
    },
  });
  await service.configure({
    revision: 0,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    predictionModel: 'deepseek-flash',
    predictionSource: 'provider',
    apiKey: fakeKey,
    confirm: true,
  });
  t.after(async () => {
    service.close();
    collaboration.dispose();
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return {
    service,
    collaboration,
    calls,
    commands,
    root,
    data,
    fetcher: (value: typeof fetch) => {
      fetcher = value;
    },
    changeRoot: (value: string) => {
      currentRoot = value;
    },
  };
}
async function settled(service: ModelService, session: AiChatSession) {
  for (let count = 0; count < 1000; count++) {
    const current = service.stateOf({ sessionId: session.id, sessionToken: session.token });
    if (current.status !== 'running') return current;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Model session did not settle');
}

test('model credentials are encrypted, never returned in settings and bound to a provider URL', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.state()).hasKey, true);
  assert.ok(!JSON.stringify(await f.service.state()).includes(fakeKey));
  assert.ok(!(await fs.readFile(path.join(f.data, 'model-service.json'), 'utf8')).includes(fakeKey));
  for (const file of await fs.readdir(path.join(f.data, 'model-credentials')))
    assert.ok(
      !(await fs.readFile(path.join(f.data, 'model-credentials', file))).includes(Buffer.from(fakeKey)),
    );
  const state = await f.service.state();
  // Configure only the public input fields, without a copied credential.
  await f.service.configure({
    revision: state.revision,
    provider: 'custom',
    baseUrl: 'https://different.example/v1',
    model: 'custom',
    predictionModel: 'custom',
    predictionSource: 'provider',
    confirm: true,
  });
  assert.equal((await f.service.state()).hasKey, false);
  await assert.rejects(f.service.test(), /aiKeyMissing/);
  assert.equal(f.calls.length, 0);
});

test(
  'Windows DPAPI credentials survive a new store instance without writing plaintext',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-dpapi-test-'));
    t.after(async () => {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      await fs.rm(directory, { recursive: true, force: true });
    });
    const first = new ModelCredentials({ directory });
    await first.set('deepseek', fakeKey);
    assert.ok(!(await fs.readFile(path.join(directory, 'deepseek.credential'), 'utf8')).includes(fakeKey));
    assert.equal(await new ModelCredentials({ directory }).get('deepseek'), fakeKey);
  },
);

test('configured provider predictions use the existing ghost-text interface without exposing them to external pollers', async (t) => {
  const f = await fixture(t);
  f.fetcher(async () => response('const answer = 42;\n'));
  const ai = new AiAssistance({ dataRoot: f.data, projectRoot: () => f.root });
  ai.setPredictionEngine({
    handles: () => f.service.handlesPredictions(),
    complete: (request, signal) => f.service.predict(request, signal),
  });
  const state = await ai.aiAssistanceState();
  await ai.aiAssistanceConfigure({ revision: state.revision, predictionEnabled: true });
  const request = await ai.aiPredictionRequest({
    editorId: 'model-test',
    projectRoot: f.root,
    path: 'main.c',
    modelVersion: 1,
    line: 1,
    column: 1,
    prefix: '',
    suffix: '',
  });
  assert.ok(request);
  let suggestion;
  for (let count = 0; count < 100 && !suggestion; count++) {
    suggestion = await ai.aiPredictionRead({ requestId: request.id });
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(suggestion?.text, 'const answer = 42;\n');
  assert.deepEqual((await ai.aiPredictionPoll()).requests, []);
  await ai.aiPredictionCancel({ editorId: 'model-test' });
});

test('project mode rejects invented host commands while explicit full control can execute its own command tool', async (t) => {
  const f = await fixture(t);
  let turn = 0;
  f.fetcher(async () =>
    ++turn % 2 === 1
      ? new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: `call-${turn}`,
                      type: 'function',
                      function: {
                        name: 'run_command',
                        arguments: JSON.stringify({ command: 'test-only-command' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      : response('done'),
  );
  const project = await f.service.start({
    projectRoot: f.root,
    scope: 'project',
    intent: 'edit',
    prompt: 'test',
    confirm: true,
  });
  const result = await settled(f.service, project);
  assert.equal(result.status, 'completed');
  assert.ok(
    result.messages.some((message) => message.role === 'tool' && message.content.includes('error.aiScope')),
  );
  assert.equal(f.commands.length, 0);
  const full = await f.service.start({
    projectRoot: f.root,
    scope: 'computer',
    intent: 'edit',
    prompt: 'test',
    confirm: true,
  });
  assert.equal((await settled(f.service, full)).status, 'completed');
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0]!.at(-1), 'test-only-command');
});

test('AI selection edits preserve everything outside the selected range and retain peer undo ownership', async (t) => {
  const f = await fixture(t),
    actor = { peerId: 'browser', actorToken: 'a'.repeat(64) };
  const start = await f.service.start({
    projectRoot: f.root,
    scope: 'selection',
    intent: 'edit',
    prompt: 'replace selection',
    confirm: true,
    actor,
    source: { path: 'main.c', content: 'before SELECT after\n', selection: { start: 7, end: 13 } },
  });
  const result = await settled(f.service, start);
  assert.equal(result.status, 'completed');
  const doc = await f.collaboration.open(f.root, 'main.c');
  assert.equal(doc.content, 'before CHANGED after\n');
  assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'before SELECT after\n');
  const undo = await f.collaboration.undo(
    {
      projectRoot: f.root,
      session: doc.session,
      path: doc.path,
      ...actor,
      requestId: 'undo-ai-edit',
      direction: 'undo',
      scope: 'own',
    },
    false,
  );
  assert.equal(undo.document.content, 'before SELECT after\n');
});

test('concurrent edits and project changes reject late model writes', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.fetcher(async () => {
    await gate;
    return response(JSON.stringify({ replacement: 'old result', explanation: '' }));
  });
  const pending = await f.service.start({
    projectRoot: f.root,
    scope: 'file',
    intent: 'edit',
    prompt: 'edit',
    confirm: true,
    source: { path: 'main.c', content: 'before SELECT after\n' },
  });
  const doc = await f.collaboration.open(f.root, 'main.c');
  await f.collaboration.edit({
    projectRoot: f.root,
    session: doc.session,
    path: doc.path,
    peerId: 'other',
    requestId: 'newer-edit',
    baseRevision: doc.revision,
    changes: [{ start: 0, end: 0, text: 'NEW ' }],
  });
  release();
  assert.equal((await settled(f.service, pending)).error, 'error.aiSourceChanged');
  assert.equal((await f.collaboration.open(f.root, 'main.c')).content, 'NEW before SELECT after\n');
  f.changeRoot(path.join(f.root, 'different'));
  await assert.rejects(
    f.service.start({ projectRoot: f.root, scope: 'project', intent: 'ask', prompt: 'read' }),
    /collaborationProjectChanged/,
  );
});

test('cancellation while a model edit waits for the collaboration lock never applies it', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = f.collaboration.workspaceAction(() => gate);
  const pending = await f.service.start({
    projectRoot: f.root,
    scope: 'selection',
    intent: 'edit',
    prompt: 'edit',
    confirm: true,
    source: { path: 'main.c', content: 'before SELECT after\n', selection: { start: 7, end: 13 } },
  });
  f.service.cancel({ sessionId: pending.id, sessionToken: pending.token });
  try {
    assert.equal((await settled(f.service, pending)).status, 'cancelled');
  } finally {
    release();
    await blocked;
  }
  assert.equal((await f.collaboration.open(f.root, 'main.c')).content, 'before SELECT after\n');
});

test('model APIs enforce explicit edit/full-control confirmation and private conversation tokens', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.start({ projectRoot: f.root, scope: 'computer', intent: 'ask', prompt: 'test' }),
    /invalidParams/,
  );
  await assert.rejects(
    f.service.start({
      projectRoot: f.root,
      scope: 'selection',
      intent: 'edit',
      prompt: 'test',
      source: { path: 'main.c', content: 'abc', selection: { start: 0, end: 1 } },
    }),
    /invalidParams/,
  );
  const pending = await f.service.start({
    projectRoot: f.root,
    scope: 'file',
    intent: 'ask',
    prompt: 'explain',
    source: { path: 'main.c', content: 'before SELECT after\n' },
  });
  assert.throws(
    () => f.service.stateOf({ sessionId: pending.id, sessionToken: 'b'.repeat(64) }),
    /aiSession/,
  );
  await settled(f.service, pending);
});

test('provider transport decodes split UTF-8 SSE and never leaks provider authentication errors', async () => {
  const bytes = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"中文"}}]}\n\ndata: {"choices":[{"delta":{"content":"回答"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n',
  );
  let offset = 0;
  const client = new ModelProviderClient({
    fetcher: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (offset >= bytes.length) return controller.close();
            controller.enqueue(bytes.slice(offset, offset + 3));
            offset += 3;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  let received = '';
  const config = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: fakeKey,
  };
  const result = await client.complete(config, [{ role: 'user', content: 'hello' }], {
    onText: (text) => {
      received += text;
    },
  });
  assert.equal(result.content, '中文回答');
  assert.equal(received, result.content);
  const rejected = new ModelProviderClient({ fetcher: async () => new Response(fakeKey, { status: 401 }) });
  await assert.rejects(
    rejected.models(config),
    (error) =>
      error instanceof Error &&
      error.message === 'error.aiAuthentication' &&
      !error.message.includes(fakeKey),
  );
});

const providerConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: fakeKey,
};
const eventStream = (text: string) =>
  new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const called = (name: string, args: unknown, id = 'call-fixture') =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
const lastTool = (body: any) =>
  JSON.parse(body.messages.filter((message: any) => message.role === 'tool').at(-1).content);

test('SSE error events and missing terminal events fail without leaking upstream messages or invoking tools', async (t) => {
  const errors = [
    [
      'data: ' + JSON.stringify({ error: { code: 'invalid_api_key', message: fakeKey } }) + '\n\n',
      'aiAuthentication',
    ],
    ['event: error\ndata: ' + JSON.stringify({ message: fakeKey }) + '\n\n', 'aiInvalidResponse'],
    ['data: {"choices":[{"delta":{"content":"incomplete"}}]}\n\n', 'aiInvalidResponse'],
  ];
  for (const [text, error] of errors) {
    const client = new ModelProviderClient({ fetcher: async () => eventStream(text) });
    await assert.rejects(
      client.complete(providerConfig, [{ role: 'user', content: 'test' }], { onText() {} }),
      (reason) =>
        reason instanceof Error && reason.message === 'error.' + error && !reason.message.includes(fakeKey),
    );
  }
  const f = await fixture(t);
  f.fetcher(async () =>
    eventStream(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'truncated-command',
                    type: 'function',
                    function: {
                      name: 'run_command',
                      arguments: JSON.stringify({ command: 'must-never-run' }),
                    },
                  },
                ],
              },
            },
          ],
        }) +
        '\n\n',
    ),
  );
  const session = await f.service.start({
    projectRoot: f.root,
    scope: 'computer',
    intent: 'edit',
    prompt: 'test truncation',
    confirm: true,
  });
  const result = await settled(f.service, session);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'error.aiInvalidResponse');
  assert.equal(f.commands.length, 0);
});

test('SSE handles multiline data and stops at DONE without waiting for a provider to close its connection', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[\r\ndata: {"delta":{"content":"complete"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n',
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new ModelProviderClient({
    fetcher: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const result = await client.complete(providerConfig, [], { onText() {} });
  assert.equal(result.content, 'complete');
  assert.equal(result.finishReason, 'stop');
  assert.equal(cancelled, true);
});

test('body reads time out or cancel promptly even when the provider stream never closes', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    for (const contentType of ['application/json', 'text/event-stream']) {
      let cancelled = false;
      const client = new ModelProviderClient({
        timeoutMs: 15,
        fetcher: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(contentType === 'application/json' ? '{' : 'data: {"choices":['),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': contentType } },
          ),
      });
      await assert.rejects(client.complete(providerConfig, [], { onText() {} }), /aiTimeout/);
      assert.equal(cancelled, true);
    }
    const controller = new AbortController(),
      client = new ModelProviderClient({ fetcher: async () => new Promise<Response>(() => {}) });
    const request = client.complete(providerConfig, [], { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, /aiRequestCancelled/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('truncated JSON completions and duplicate tool IDs cannot become edits or duplicate host actions', async (t) => {
  const f = await fixture(t);
  f.fetcher(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ replacement: 'truncated' }) }, finish_reason: 'length' },
          ],
        }),
      ),
  );
  const pending = await f.service.start({
    projectRoot: f.root,
    scope: 'file',
    intent: 'edit',
    prompt: 'test',
    confirm: true,
    localOnly: true,
    source: { path: 'main.c', content: 'before SELECT after\n' },
  });
  const result = await settled(f.service, pending);
  assert.equal(result.error, 'error.aiResponseTooLarge');
  assert.equal(result.pendingEdit, undefined);
  assert.deepEqual(result.changedFiles, []);
  const call = {
    id: 'same-id',
    type: 'function',
    function: { name: 'run_command', arguments: JSON.stringify({ command: 'must-never-run' }) },
  };
  f.fetcher(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [call, call] }, finish_reason: 'tool_calls' }],
        }),
      ),
  );
  const full = await f.service.start({
    projectRoot: f.root,
    scope: 'computer',
    intent: 'edit',
    prompt: 'test',
    confirm: true,
  });
  assert.equal((await settled(f.service, full)).error, 'error.aiInvalidResponse');
  assert.equal(f.commands.length, 0);
});

test('untrusted provider exceptions cannot masquerade as application errors containing a credential', async () => {
  const client = new ModelProviderClient({
    fetcher: async () => {
      throw new Error('error.aiProviderFailed: ' + fakeKey);
    },
  });
  await assert.rejects(
    client.models(providerConfig),
    (reason) => reason instanceof Error && reason.message === 'error.aiNetwork',
  );
  const bodyClient = new ModelProviderClient({
    fetcher: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('error.aiProviderFailed: ' + fakeKey));
          },
        }),
      ),
  });
  await assert.rejects(
    bodyClient.complete(providerConfig, []),
    (reason) => reason instanceof Error && reason.message === 'error.aiInvalidResponse',
  );
});

test('local-only selection and file edits return staged changes without touching shared state or disk', async (t) => {
  for (const scope of ['selection', 'file'] as const) {
    const f = await fixture(t),
      source = {
        path: 'main.c',
        content: 'before SELECT after\n',
        ...(scope === 'selection' ? { selection: { start: 7, end: 13 } } : {}),
      };
    const pending = await f.service.start({
      projectRoot: f.root,
      scope,
      intent: 'edit',
      prompt: 'test',
      confirm: true,
      localOnly: true,
      source,
    });
    const result = await settled(f.service, pending);
    assert.equal(result.status, 'completed');
    assert.equal(result.pendingEdit?.path, 'main.c');
    assert.equal(result.pendingEdit?.text, 'CHANGED');
    assert.equal(result.pendingEdit?.start, scope === 'selection' ? 7 : 0);
    assert.equal(result.pendingEdit?.end, scope === 'selection' ? 13 : source.content.length);
    assert.deepEqual(result.changedFiles, []);
    assert.equal((await f.collaboration.open(f.root, 'main.c')).content, source.content);
    assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), source.content);
  }
});

test('local project staging enforces hashes, keeps successive edits, and forbids create or out-of-scope tools', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'second.c'), 'second original');
  let turn = 0,
    firstHash = '';
  f.fetcher(async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    turn++;
    if (turn === 1) return called('read_file', { path: 'main.c' });
    if (turn === 2) {
      firstHash = lastTool(body).hash;
      return called('edit_file', { path: 'main.c', expectedHash: firstHash, content: 'first staged' });
    }
    if (turn === 3) return called('read_file', { path: 'main.c' });
    if (turn === 4) {
      assert.equal(lastTool(body).content, 'first staged');
      return called('edit_file', { path: 'main.c', expectedHash: firstHash, content: 'stale overwrite' });
    }
    if (turn === 5) {
      assert.equal(lastTool(body).error, 'error.aiSourceChanged');
      return called('edit_file', {
        path: 'main.c',
        expectedHash: createHash('sha256').update('first staged').digest('hex'),
        content: 'final staged',
      });
    }
    if (turn === 6) return called('create_file', { path: 'created.c', content: 'must not exist' });
    if (turn === 7) {
      assert.equal(lastTool(body).error, 'error.aiScope');
      return called('read_file', { path: '../outside.txt' });
    }
    if (turn === 8) {
      assert.equal(lastTool(body).error, 'error.invalidPath');
      return called('read_file', { path: 'second.c' });
    }
    if (turn === 9)
      return called('edit_file', {
        path: 'second.c',
        expectedHash: lastTool(body).hash,
        content: 'second staged',
      });
    return response('done');
  });
  const pending = await f.service.start({
    projectRoot: f.root,
    scope: 'project',
    intent: 'edit',
    prompt: 'test',
    confirm: true,
    localOnly: true,
  });
  const result = await settled(f.service, pending);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.pendingEdits?.length, 2);
  assert.deepEqual(
    result.pendingEdits?.map(({ path, originalContent, text }) => ({ path, originalContent, text })),
    [
      { path: 'main.c', originalContent: 'before SELECT after\n', text: 'final staged' },
      { path: 'second.c', originalContent: 'second original', text: 'second staged' },
    ],
  );
  assert.equal((await f.collaboration.open(f.root, 'main.c')).content, 'before SELECT after\n');
  assert.equal(await fs.readFile(path.join(f.root, 'second.c'), 'utf8'), 'second original');
  assert.equal(await fs.stat(path.join(f.root, 'created.c')).catch(() => null), null);
});

test('cancelled edits queued behind a lock cannot apply after the same conversation restarts', async (t) => {
  const f = await fixture(t),
    original = await f.collaboration.open(f.root, 'main.c'),
    actualOpen = f.collaboration.open.bind(f.collaboration),
    actualEdit = f.collaboration.edit.bind(f.collaboration);
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    attempted = new Promise<void>((resolve) => {
      reached = resolve;
    });
  const blocked = f.collaboration.workspaceAction(() => gate);
  let first = true;
  t.mock.method(f.collaboration, 'open', (...args: Parameters<typeof actualOpen>) => {
    if (first) {
      first = false;
      return Promise.resolve(original);
    }
    return actualOpen(...args);
  });
  t.mock.method(f.collaboration, 'edit', (...args: Parameters<typeof actualEdit>) => {
    reached();
    return actualEdit(...args);
  });
  const pending = await f.service.start({
    projectRoot: f.root,
    scope: 'selection',
    intent: 'edit',
    prompt: 'old',
    confirm: true,
    source: { path: 'main.c', content: original.content, selection: { start: 7, end: 13 } },
  });
  await attempted;
  f.service.cancel({ sessionId: pending.id, sessionToken: pending.token });
  try {
    assert.equal((await settled(f.service, pending)).status, 'cancelled');
    f.fetcher(async () => response(JSON.stringify({ replacement: 'NEW', explanation: 'new request' })));
    const newer = await f.service.start({
      projectRoot: f.root,
      scope: 'selection',
      intent: 'edit',
      prompt: 'new',
      confirm: true,
      sessionId: pending.id,
      sessionToken: pending.token,
      source: { path: 'main.c', content: original.content, selection: { start: 7, end: 13 } },
    });
    release();
    await blocked;
    assert.equal((await settled(f.service, newer)).status, 'completed');
    assert.equal((await actualOpen(f.root, 'main.c')).content, 'before NEW after\n');
  } finally {
    release();
    await blocked;
  }
});

test('project file hashes reject a newer collaborator revision without overwriting it', async (t) => {
  const f = await fixture(t);
  let turn = 0;
  f.fetcher(async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    if (++turn === 1) return called('read_file', { path: 'main.c' });
    if (turn === 2) {
      const doc = await f.collaboration.open(f.root, 'main.c');
      await f.collaboration.edit({
        projectRoot: f.root,
        session: doc.session,
        path: doc.path,
        peerId: 'peer',
        requestId: 'new-peer-revision',
        baseRevision: doc.revision,
        changes: [{ start: 0, end: 0, text: 'PEER ' }],
      });
      return called('edit_file', {
        path: 'main.c',
        expectedHash: lastTool(body).hash,
        content: 'stale model overwrite',
      });
    }
    assert.equal(lastTool(body).error, 'error.aiSourceChanged');
    return response('The newer edit was preserved.');
  });
  const pending = await f.service.start({
    projectRoot: f.root,
    scope: 'project',
    intent: 'edit',
    prompt: 'test',
    confirm: true,
  });
  const result = await settled(f.service, pending);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.changedFiles, []);
  assert.equal((await f.collaboration.open(f.root, 'main.c')).content, 'PEER before SELECT after\n');
});

test('computer file creation refuses a directory alias into the host credential store', async (t) => {
  const f = await fixture(t),
    secrets = path.join(f.data, 'model-credentials'),
    alias = path.join(f.root, 'credential-alias');
  await fs.symlink(secrets, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let turn = 0;
  f.fetcher(async (_url, options) => {
    if (++turn === 1)
      return called('create_file', {
        path: path.join(alias, 'nested', 'injected.credential'),
        content: 'must not be created',
      });
    assert.equal(lastTool(JSON.parse(String(options?.body))).error, 'error.aiScope');
    return response('refused');
  });
  const session = await f.service.start({
    projectRoot: f.root,
    scope: 'computer',
    intent: 'edit',
    prompt: 'test',
    confirm: true,
  });
  assert.equal((await settled(f.service, session)).status, 'completed');
  assert.equal(await fs.stat(path.join(secrets, 'nested')).catch(() => null), null);
});

test('cancellation discards local project staging instead of releasing partial proposals', async (t) => {
  const f = await fixture(t);
  let turn = 0,
    release!: () => void,
    waiting!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    reached = new Promise<void>((resolve) => {
      waiting = resolve;
    });
  f.fetcher(async (_url, options) => {
    if (++turn === 1) return called('read_file', { path: 'main.c' });
    if (turn === 2)
      return called('edit_file', {
        path: 'main.c',
        expectedHash: lastTool(JSON.parse(String(options?.body))).hash,
        content: 'partial stage',
      });
    waiting();
    await gate;
    return response('done');
  });
  const session = await f.service.start({
    projectRoot: f.root,
    scope: 'project',
    intent: 'edit',
    prompt: 'test',
    confirm: true,
    localOnly: true,
  });
  await reached;
  f.service.cancel({ sessionId: session.id, sessionToken: session.token });
  try {
    const result = await settled(f.service, session);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.pendingEdits, undefined);
    assert.deepEqual(result.changedFiles, []);
  } finally {
    release();
  }
  assert.equal((await f.collaboration.open(f.root, 'main.c')).content, 'before SELECT after\n');
  assert.equal(await fs.readFile(path.join(f.root, 'main.c'), 'utf8'), 'before SELECT after\n');
});

test('providers using SSE for non-streaming edits are decoded, while pre-cancelled requests never reach fetch', async () => {
  const client = new ModelProviderClient({
    fetcher: async () =>
      eventStream(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: '{"replacement":"ok"}' }, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      ),
  });
  assert.equal((await client.complete(providerConfig, [], { json: true })).content, '{"replacement":"ok"}');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const cancelled = new ModelProviderClient({
    fetcher: async () => {
      calls++;
      return response('no');
    },
  });
  await assert.rejects(
    cancelled.complete(providerConfig, [], { signal: controller.signal }),
    /aiRequestCancelled/,
  );
  assert.equal(calls, 0);
});
