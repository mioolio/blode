import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelService } from '../src/core/model-service';
import { ModelCredentials } from '../src/core/model-service/credentials';
import { CollaborationService } from '../src/core/collaboration';
import type { AiChatSession } from '../src/shared/model-service';

const marker = 'ai-marker-中文.txt';
const markerText = '宿主命令已执行';
const outputText = '真实进程输出：中文通过';
const completeCommand =
  process.platform === 'win32'
    ? "$fixtureUtf8=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=$fixtureUtf8; [System.IO.File]::WriteAllText((Join-Path (Get-Location).Path 'ai-marker-中文.txt'),'宿主命令已执行',$fixtureUtf8); [Console]::Out.WriteLine('真实进程输出：中文通过')"
    : "printf '%s' '宿主命令已执行' > 'ai-marker-中文.txt'; printf '%s\\n' '真实进程输出：中文通过'";
const waitingCommand =
  process.platform === 'win32'
    ? "$fixtureUtf8=[System.Text.UTF8Encoding]::new($false); [System.IO.File]::WriteAllText((Join-Path (Get-Location).Path 'worker.pid'),[string]$PID,$fixtureUtf8); Start-Sleep -Seconds 30; [System.IO.File]::WriteAllText((Join-Path (Get-Location).Path 'late.txt'),'unexpected',$fixtureUtf8)"
    : "printf '%s' \"$$\" > worker.pid; while :; do :; done; printf '%s' 'unexpected' > late.txt";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reply = (content: string) =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }),
    { headers: { 'content-type': 'application/json' } },
  );
const tools = (calls: { id: string; name: string; args: unknown }[]) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );

async function settled(service: ModelService, session: AiChatSession) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const current = service.stateOf({ sessionId: session.id, sessionToken: session.token });
    if (current.status !== 'running') return current;
    await sleep(20);
  }
  throw new Error('The real-command fixture session did not finish');
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function stopped(pid: number) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (!alive(pid)) return;
    await sleep(25);
  }
  assert.fail('The owned fixture shell remained alive after cancellation');
}
async function fixture(t: TestContext, command: string, withWorkbench = false) {
  const validationRoot = path.resolve(
    process.env.BLODE_TEST_TMP_ROOT ?? path.join(os.tmpdir(), 'blode-model-real-command'),
  );
  await fs.mkdir(validationRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(validationRoot, 'run-'));
  const root = path.join(base, 'project'),
    dataRoot = path.join(base, 'data');
  const previousTemp = process.env.TEMP,
    previousTmp = process.env.TMP;
  const ownTemp = path.join(base, 'temp');
  await fs.mkdir(root);
  await fs.mkdir(ownTemp);
  process.env.TEMP = ownTemp;
  process.env.TMP = ownTemp;
  const collaboration = new CollaborationService({
    workspace: async () => ({ projectRoot: root, files: [] }),
    saveFile: async () => assert.fail('This command fixture must not save workspace documents'),
    publish() {},
  });
  const requests: any[] = [],
    workbench: { method: string; params: Record<string, unknown> }[] = [];
  let processResult: { code: number; output: string; stdout?: string; stderr?: string } | undefined;
  const service = new ModelService({
    dataRoot,
    projectRoot: () => root,
    collaboration,
    credentials: new ModelCredentials({
      directory: path.join(dataRoot, 'model-credentials'),
      platform: 'linux',
    }),
    // No command injection here: this intentionally exercises ModelService's default runCommand.
    fetcher: async (url, options) => {
      assert.equal(String(url), 'https://model-fixture.invalid/v1/chat/completions');
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      assert.ok(body.tools.some((tool: any) => tool.function.name === 'run_command'));
      if (requests.length === 1)
        return tools([
          { id: 'owned-shell', name: 'run_command', args: { command } },
          ...(withWorkbench
            ? [
                {
                  id: 'fixture-workbench',
                  name: 'workbench',
                  args: { method: 'capabilities.get', params: {} },
                },
              ]
            : []),
        ]);
      const commandMessage = body.messages.find(
        (message: any) => message.role === 'tool' && message.tool_call_id === 'owned-shell',
      );
      assert.ok(commandMessage, 'the real process result is returned to the model protocol');
      processResult = JSON.parse(commandMessage.content);
      return reply('完成');
    },
    automate: async (method, params) => {
      assert.equal(method, 'capabilities.get');
      assert.deepEqual(params, {});
      workbench.push({ method, params });
      return { fixture: true, available: ['state.get'] };
    },
  });
  t.after(async () => {
    service.close();
    collaboration.dispose();
    const ownedPid = Number(await fs.readFile(path.join(root, 'worker.pid'), 'utf8').catch(() => ''));
    if (Number.isSafeInteger(ownedPid) && ownedPid > 0 && ownedPid !== process.pid) await stopped(ownedPid);
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
    assert.equal(path.dirname(base), validationRoot);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  await service.configure({
    revision: 0,
    provider: 'custom',
    baseUrl: 'https://model-fixture.invalid/v1',
    model: 'fixture-model',
    predictionModel: 'fixture-model',
    predictionSource: 'external',
    apiKey: 'test-only-real-command-fixture-key',
    confirm: true,
  });
  return { root, service, requests, workbench, result: () => processResult };
}

test(
  'full mode uses the default real shell command and returns Chinese process output and workbench results',
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t, completeCommand, true);
    await assert.rejects(
      f.service.start({
        projectRoot: f.root,
        scope: 'computer',
        intent: 'edit',
        prompt: 'Run the fixed fixture command',
      }),
      /invalidParams/,
    );
    assert.equal(f.requests.length, 0);
    assert.equal(await fs.stat(path.join(f.root, marker)).catch(() => null), null);
    const session = await f.service.start({
      projectRoot: f.root,
      scope: 'computer',
      intent: 'edit',
      prompt:
        'Execute only the fixed test command inside this temporary project and read the fixture capabilities',
      confirm: true,
    });
    const completed = await settled(f.service, session);
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(await fs.readFile(path.join(f.root, marker), 'utf8'), markerText);
    assert.equal(f.result()?.code, 0);
    assert.match(f.result()?.output ?? '', new RegExp(outputText));
    assert.match(f.result()?.stdout ?? '', new RegExp(outputText));
    assert.deepEqual(f.workbench, [{ method: 'capabilities.get', params: {} }]);
    assert.ok(
      completed.messages.some((message) => message.role === 'tool' && message.content.includes(outputText)),
    );
    assert.ok(
      completed.messages.some(
        (message) =>
          message.role === 'tool' &&
          message.content.includes('fixture-workbench') === false &&
          message.content.includes('"fixture":true'),
      ),
    );
    assert.equal(
      completed.messages.filter((message) => message.role === 'assistant').at(-1)?.content,
      '完成',
    );
    assert.equal(f.requests.length, 2);
  },
);

for (const action of ['cancel', 'close'] as const)
  test(
    `full-mode ${action} stops its owned real shell before delayed writes`,
    { timeout: 25_000 },
    async (t) => {
      const f = await fixture(t, waitingCommand);
      const session = await f.service.start({
        projectRoot: f.root,
        scope: 'computer',
        intent: 'edit',
        prompt: 'Start only the owned temporary test shell',
        confirm: true,
      });
      let pid = 0;
      const end = Date.now() + 10_000;
      while (Date.now() < end) {
        pid = Number(await fs.readFile(path.join(f.root, 'worker.pid'), 'utf8').catch(() => ''));
        if (Number.isSafeInteger(pid) && pid > 0) break;
        await sleep(20);
      }
      assert.ok(pid > 0 && pid !== process.pid, 'the fixed fixture command reached its owned shell');
      assert.ok(alive(pid));
      if (action === 'cancel') f.service.cancel({ sessionId: session.id, sessionToken: session.token });
      else f.service.close();
      const cancelled = await settled(f.service, session);
      assert.equal(cancelled.status, 'cancelled');
      await stopped(pid);
      assert.equal(await fs.stat(path.join(f.root, 'late.txt')).catch(() => null), null);
      assert.equal(f.requests.length, 1, 'cancelled work never starts a second model turn');
    },
  );
