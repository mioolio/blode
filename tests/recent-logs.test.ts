import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecentLogs } from '../src/core/recent-logs';
import { mergeRecentLogs } from '../src/shared/recent-logs';
import type { LogEvent } from '../src/shared/contracts';

const event = (sequence: number, message: string, kind: LogEvent['kind'] = 'log'): LogEvent => ({
  sequence,
  message,
  kind,
  level: 'info',
  time: new Date(sequence * 1000).toISOString(),
});

test('latest build output replaces prior build output while preserving serial data', () => {
  const before = [event(1, 'old output'), event(2, 'serial bytes', 'serial')];
  const after = mergeRecentLogs(before, [event(3, 'status.buildStarted'), event(4, 'new output')]);
  assert.deepEqual(
    after.map((entry) => entry.message),
    ['serial bytes', 'status.buildStarted', 'new output'],
  );
});

test('reconnect replay and live events merge without duplicates', () => {
  const live = [event(3, 'status.buildStarted'), event(4, 'compiler output')];
  const replay = [
    event(3, 'status.buildStarted'),
    event(4, 'compiler output'),
    event(5, 'status.buildSucceeded'),
  ];
  assert.deepEqual(
    mergeRecentLogs(live, replay).map((entry) => entry.sequence),
    [3, 4, 5],
  );
});

test('PTY notifications stay live without displacing compiler output or creating blank console rows', () => {
  const logs = new RecentLogs();
  logs.publish(event(1, 'compiler output'));
  for (let index = 2; index < 600; index++) {
    const notification = logs.publish(event(index, '', 'terminal'));
    assert.equal(notification.kind, 'terminal', 'the live channel must still notify terminal renderers');
  }
  assert.deepEqual(
    logs.snapshot().map((entry) => entry.message),
    ['compiler output'],
  );
  assert.deepEqual(
    mergeRecentLogs([], [event(4, '', 'terminal'), event(5, 'output')]).map((entry) => entry.message),
    ['output'],
  );
});

test('a delayed snapshot of an older build cannot resurrect discarded output', () => {
  const current = [event(10, 'status.buildStarted'), event(11, 'latest compiler output')];
  const stale = [event(1, 'status.buildStarted'), event(2, 'obsolete compiler output')];
  assert.deepEqual(
    mergeRecentLogs(current, stale).map((entry) => entry.sequence),
    [10, 11],
  );
});

test('a replay batch containing multiple builds keeps only the final build output', () => {
  const batch = [
    event(2, 'status.buildStarted'),
    event(3, 'older output'),
    event(4, 'status.buildStarted'),
    event(5, 'latest output'),
  ];
  assert.deepEqual(
    mergeRecentLogs([], batch).map((entry) => entry.sequence),
    [4, 5],
  );
});

test('recent log storage is bounded and progress-only AI events are live-only', () => {
  const logs = new RecentLogs();
  for (let index = 0; index < 550; index++) logs.publish(event(index + 1, `output-${index}`));
  const transient = logs.publish({ ...event(551, 'status.aiPredictionReady id'), progressOnly: true });
  assert.equal(transient.sequence, 551);
  assert.equal(logs.snapshot().length, 500);
  assert.ok(logs.snapshot().every((entry) => !entry.progressOnly));
  assert.equal(logs.snapshot().at(-1)?.sequence, 550);
  const next = logs.publish({ kind: 'log', level: 'info', message: 'next', time: new Date().toISOString() });
  assert.equal(next.sequence, 552);
});
