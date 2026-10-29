import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  DesktopLifecycle,
  type DesktopLifecycleOptions,
  type TraySpecification,
} from '../src/core/desktop-lifecycle';
import { createTrayIcon } from '../src/core/tray-icon';
import { crc32 } from '../src/core/zip';
import { APP_CLOSE_REQUEST_CHANNEL, type AppCloseRequest } from '../src/shared/desktop-lifecycle';

class WindowDouble extends EventEmitter {
  destroyed = false;
  hidden = 0;
  shown = 0;
  messages: AppCloseRequest[] = [];
  webContents = {
    isDestroyed: () => this.destroyed,
    mainFrame: {
      detached: false,
      isDestroyed: () => this.destroyed,
      send: (channel: string, request: AppCloseRequest) => {
        assert.equal(channel, APP_CLOSE_REQUEST_CHANNEL);
        this.messages.push(request);
      },
    },
  };
  isDestroyed() {
    return this.destroyed;
  }
  show() {
    this.shown++;
  }
  hide() {
    this.hidden++;
  }
  focus() {}
  close() {
    let prevented = false;
    this.emit('close', {
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(override: Partial<DesktopLifecycleOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-close-'));
  const window = new WindowDouble();
  const prepared: string[] = [];
  const trays: { spec: TraySpecification; destroyed: boolean }[] = [];
  let cancelled = 0,
    exited = 0;
  const controller = new DesktopLifecycle({
    window: window as unknown as DesktopLifecycleOptions['window'],
    dataRoot: directory,
    rendererReady: () => true,
    sharedDirty: async () => false,
    prepareShutdown: async (decision) => {
      prepared.push(decision);
    },
    cancelShutdown: async () => {
      cancelled++;
    },
    exit: () => {
      exited++;
    },
    createTray: (spec) => {
      const record = { spec, destroyed: false };
      trays.push(record);
      return {
        destroy() {
          record.destroyed = true;
        },
      };
    },
    ...override,
  });
  await controller.initialize();
  return {
    controller,
    window,
    directory,
    prepared,
    trays,
    counts: () => ({ cancelled, exited }),
    async dispose() {
      controller.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test('clean native close is coalesced and exits after one renderer acknowledgement', async () => {
  const f = await fixture();
  try {
    assert.equal(f.controller.state().closeToTray, false);
    assert.equal(f.window.close(), true);
    assert.equal(f.window.close(), true);
    await tick();
    assert.equal(f.window.messages.length, 1);
    const pending = f.controller.state().pendingClose!;
    assert.equal(pending.sharedDirty, false);
    const done = f.controller.requestQuit();
    await f.controller.reply({ id: pending.id, decision: 'clean' });
    await done;
    assert.deepEqual(f.prepared, ['clean']);
    assert.equal(f.counts().exited, 1);
    assert.equal(f.window.close(), false);
  } finally {
    await f.dispose();
  }
});

test('cancel keeps the application open and a subsequent close gets a fresh decision', async () => {
  const f = await fixture({ sharedDirty: async () => true });
  try {
    const done = f.controller.requestQuit();
    await tick();
    const first = f.controller.state().pendingClose!;
    await f.controller.reply({ id: first.id, decision: 'cancel' });
    await done;
    assert.deepEqual(f.counts(), { cancelled: 1, exited: 0 });
    assert.equal(f.controller.state().pendingClose, undefined);
    const retry = f.controller.requestQuit();
    await tick();
    const next = f.controller.state().pendingClose!;
    assert.notEqual(first.id, next.id);
    assert.equal(next.sharedDirty, true);
    await f.controller.reply({ id: next.id, decision: 'discard' });
    await retry;
    assert.deepEqual(f.prepared, ['discard']);
    assert.equal(f.counts().exited, 1);
  } finally {
    await f.dispose();
  }
});

test('collaborator edits arriving after clean review require a new explicit decision', async () => {
  let dirty = false;
  const decisions: string[] = [];
  const f = await fixture({
    sharedDirty: async () => dirty,
    prepareShutdown: async (decision) => {
      decisions.push(decision);
      if (decision === 'clean' && dirty) throw new Error('error.unsavedChanges');
    },
  });
  try {
    const done = f.controller.requestQuit();
    await tick();
    const first = f.controller.state().pendingClose!;
    dirty = true;
    await f.controller.reply({ id: first.id, decision: 'clean' });
    const next = f.controller.state().pendingClose!;
    assert.notEqual(first.id, next.id);
    assert.equal(next.sharedDirty, true);
    assert.equal(f.counts().exited, 0);
    assert.throws(() => f.controller.reply({ id: first.id, decision: 'discard' }), /closeRequestExpired/);
    await f.controller.reply({ id: next.id, decision: 'saved' });
    await done;
    assert.deepEqual(decisions, ['clean', 'saved']);
    assert.equal(f.counts().exited, 1);
  } finally {
    await f.dispose();
  }
});

test('a failed save preserves the pending review and does not exit or silently discard', async () => {
  const f = await fixture({
    sharedDirty: async () => true,
    prepareShutdown: async () => {
      throw new Error('disk-full');
    },
  });
  try {
    const done = f.controller.requestQuit();
    await tick();
    const first = f.controller.state().pendingClose!;
    await assert.rejects(f.controller.reply({ id: first.id, decision: 'saved' }), /disk-full/);
    const next = f.controller.state().pendingClose!;
    assert.equal(next.error, 'disk-full');
    assert.notEqual(first.id, next.id);
    assert.equal(f.counts().exited, 0);
    await f.controller.reply({ id: next.id, decision: 'cancel' });
    await done;
    assert.equal(f.counts().cancelled, 2);
  } finally {
    await f.dispose();
  }
});

test('tray close hides drafts without prompting; tray quit uses the save decision', async () => {
  const f = await fixture({ sharedDirty: async () => true });
  try {
    await f.controller.configure({ closeToTray: true, locale: 'en' });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(f.directory, 'desktop-lifecycle.json'), 'utf8')).closeToTray,
      true,
    );
    assert.equal(f.trays[0].spec.locale, 'en');
    assert.equal(f.window.close(), true);
    assert.equal(f.window.hidden, 1);
    assert.equal(f.window.messages.length, 0);
    f.trays[0].spec.show();
    assert.equal(f.window.shown, 1);
    f.trays[0].spec.quit();
    await tick();
    const pending = f.controller.state().pendingClose!;
    assert.equal(pending.sharedDirty, true);
    const done = f.controller.requestQuit();
    await f.controller.reply({ id: pending.id, decision: 'cancel' });
    await done;
    await f.controller.configure({ closeToTray: false });
    assert.equal(f.trays[0].destroyed, true);
    assert.equal(f.counts().exited, 0);
  } finally {
    await f.dispose();
  }
});

test('persisted preferences restore a tray, corrupt preferences keep ordinary close behavior', async () => {
  const f = await fixture();
  let replacement: DesktopLifecycle | undefined;
  try {
    await f.controller.configure({ closeToTray: true, locale: 'en' });
    f.controller.dispose();
    const options: DesktopLifecycleOptions = {
      window: f.window as unknown as DesktopLifecycleOptions['window'],
      dataRoot: f.directory,
      rendererReady: () => true,
      sharedDirty: async () => false,
      prepareShutdown: async () => {},
      cancelShutdown: async () => {},
      exit() {},
      createTray: () => ({ destroy() {} }),
    };
    replacement = new DesktopLifecycle(options);
    await replacement.initialize();
    assert.equal(replacement.state().closeToTray, true);
    replacement.dispose();
    await fs.writeFile(path.join(f.directory, 'desktop-lifecycle.json'), '{bad');
    replacement = new DesktopLifecycle(options);
    await replacement.initialize();
    assert.equal(replacement.state().closeToTray, false);
  } finally {
    replacement?.dispose();
    await f.dispose();
  }
});

test('initialization failure cannot silently discard drafts or exit without a renderer', async () => {
  const clean = await fixture({ rendererReady: () => false });
  const dirty = await fixture({ rendererReady: () => false, sharedDirty: async () => true });
  try {
    await clean.controller.requestQuit();
    assert.equal(clean.counts().exited, 1);
    assert.deepEqual(clean.prepared, ['clean']);
    await assert.rejects(dirty.controller.requestQuit(), /unsavedChanges/);
    assert.equal(dirty.counts().exited, 0);
    assert.deepEqual(dirty.prepared, []);
  } finally {
    await clean.dispose();
    await dirty.dispose();
  }
});

test('timed out renderer requests unlock safely and reject late approvals', async () => {
  const f = await fixture({ requestTimeoutMs: 15 });
  try {
    const done = f.controller.requestQuit();
    await tick();
    const first = f.controller.state().pendingClose!;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await done;
    assert.equal(f.controller.state().pendingClose, undefined);
    assert.equal(f.window.messages.at(-1)?.cancelled, true);
    assert.throws(() => f.controller.reply({ id: first.id, decision: 'discard' }), /closeRequestExpired/);
    assert.equal(f.counts().exited, 0);
    assert.equal(f.counts().cancelled, 1);
  } finally {
    await f.dispose();
  }
});

test('a save transaction can outlive the renderer handshake timeout without being cancelled', async () => {
  let finish!: () => void;
  const f = await fixture({
    requestTimeoutMs: 15,
    sharedDirty: async () => true,
    prepareShutdown: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  try {
    const done = f.controller.requestQuit();
    await tick();
    const first = f.controller.state().pendingClose!;
    const reply = f.controller.reply({ id: first.id, decision: 'saved' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.counts().cancelled, 0);
    assert.equal(f.controller.state().pendingClose?.id, first.id);
    finish();
    await reply;
    await done;
    assert.equal(f.counts().exited, 1);
  } finally {
    await f.dispose();
  }
});

test('the final renderer commit is replayable and exit waits for its explicit acknowledgement', async () => {
  const f = await fixture({ rendererCommit: true, sharedDirty: async () => true });
  try {
    const done = f.controller.requestQuit();
    await tick();
    const request = f.controller.state().pendingClose!;
    const reply = f.controller.reply({ id: request.id, decision: 'discard' });
    await tick();
    const commit = f.controller.state().pendingClose!;
    assert.equal(commit.phase, 'commit');
    assert.equal(commit.decision, 'discard');
    assert.equal(commit.id, request.id);
    assert.equal(commit.lifecycleId, f.controller.state().lifecycleId);
    assert.equal(f.window.messages.at(-1)?.phase, 'commit');
    assert.equal(f.counts().exited, 0, 'discard has not yet cleared renderer recovery storage');
    await f.controller.reply({ id: commit.id, decision: 'committed' });
    await reply;
    await done;
    assert.equal(f.counts().exited, 1);
    assert.throws(() => f.controller.reply({ id: commit.id, decision: 'committed' }), /closeRequestExpired/);
  } finally {
    await f.dispose();
  }
});

test('a late local edit discovered after the shared freeze creates a fresh review and unlocks writes', async () => {
  const f = await fixture({ rendererCommit: true });
  try {
    const done = f.controller.requestQuit();
    await tick();
    const request = f.controller.state().pendingClose!;
    const reply = f.controller.reply({ id: request.id, decision: 'clean' });
    await tick();
    await f.controller.reply({ id: request.id, decision: 'commitFailed', error: 'error.closeNeedsReview' });
    await reply;
    const review = f.controller.state().pendingClose!;
    assert.notEqual(review.id, request.id);
    assert.equal(review.phase, undefined);
    assert.equal(review.sharedDirty, true);
    assert.equal(f.counts().exited, 0);
    assert.equal(f.counts().cancelled, 1);
    await f.controller.reply({ id: review.id, decision: 'cancel' });
    await done;
  } finally {
    await f.dispose();
  }
});

test('a renderer lost during final commit cannot silently exit or approve a subsequent request', async () => {
  const f = await fixture({ rendererCommit: true, requestTimeoutMs: 20 });
  try {
    const done = f.controller.requestQuit();
    await tick();
    const request = f.controller.state().pendingClose!;
    const reply = f.controller.reply({ id: request.id, decision: 'discard' });
    const rejected = assert.rejects(reply, /closeRequestTimeout/);
    await new Promise((resolve) => setTimeout(resolve, 35));
    await rejected;
    const review = f.controller.state().pendingClose!;
    assert.notEqual(review.id, request.id);
    assert.equal(review.error, 'error.closeRequestTimeout');
    assert.equal(f.counts().exited, 0);
    assert.equal(f.counts().cancelled, 1);
    assert.throws(() => f.controller.reply({ id: request.id, decision: 'committed' }), /closeRequestExpired/);
    await f.controller.reply({ id: review.id, decision: 'cancel' });
    await done;
  } finally {
    await f.dispose();
  }
});

test('tray PNG has valid dimensions, pixels and CRCs without a native graphics dependency', () => {
  const png = createTrayIcon();
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8;
  const images: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset),
      type = png.subarray(offset + 4, offset + 8).toString();
    const payload = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length));
    if (type === 'IHDR') {
      assert.equal(payload.readUInt32BE(0), 32);
      assert.equal(payload.readUInt32BE(4), 32);
      assert.equal(payload[9], 6);
    }
    if (type === 'IDAT') images.push(payload);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(images));
  assert.equal(raw.length, 32 * 129);
  assert.equal(raw[1 + 3], 0);
  assert.equal(raw[16 * 129 + 1 + 16 * 4 + 3], 255);
});
