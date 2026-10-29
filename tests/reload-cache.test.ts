import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnapshotCache } from '../src/core/snapshot-cache';

test('reload snapshots share a loader but return independent mutable copies', async () => {
  const cache = new SnapshotCache<{ files: { text: string }[] }>();
  let reads = 0;
  const load = async () => {
    reads++;
    return { files: [{ text: 'source' }] };
  };
  const [one, two] = await Promise.all([cache.get('project', load), cache.get('project', load)]);
  assert.equal(reads, 1);
  one.files[0]!.text = 'draft';
  assert.equal(two.files[0]!.text, 'source');
  assert.equal((await cache.get('project', load)).files[0]!.text, 'source');
  assert.equal(reads, 1);
});

test('failed snapshot reads are retried instead of poisoning Ctrl+R indefinitely', async () => {
  const cache = new SnapshotCache<string>();
  await assert.rejects(
    cache.get('project', async () => {
      throw new Error('temporary');
    }),
    /temporary/,
  );
  assert.equal(await cache.get('project', async () => 'recovered'), 'recovered');
});

test('a late old-project loader cannot replace the new project snapshot', async () => {
  const cache = new SnapshotCache<string>();
  let resolveOld!: (value: string) => void;
  const old = cache.get(
    'old',
    () =>
      new Promise<string>((resolve) => {
        resolveOld = resolve;
      }),
  );
  await Promise.resolve();
  const fresh = await cache.get('new', async () => 'new-project');
  resolveOld('old-project');
  assert.equal(await old, 'old-project');
  assert.equal(fresh, 'new-project');
  assert.equal(await cache.get('new', async () => 'should-not-read'), 'new-project');
});

test('invalidating during a read allows a fresh replacement and isolates late failure', async () => {
  const cache = new SnapshotCache<string>();
  let rejectOld!: (error: Error) => void;
  const old = cache.get(
    'project',
    () =>
      new Promise<string>((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  await Promise.resolve();
  cache.invalidate();
  assert.equal(await cache.get('project', async () => 'fresh'), 'fresh');
  rejectOld(new Error('outdated read'));
  await assert.rejects(old, /outdated read/);
  assert.equal(await cache.get('project', async () => 'unexpected'), 'fresh');
});
