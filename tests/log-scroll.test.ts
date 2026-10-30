import test from 'node:test';
import assert from 'node:assert/strict';
import { LogScrollController } from '../src/renderer/workspace/logScroll';

test('new output follows its tail while a reader above the tail keeps their position', () => {
  const scroll = new LogScrollController();
  const viewport = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
  scroll.update('serial', viewport, true);
  assert.equal(viewport.scrollTop, 900);
  viewport.scrollTop = 120;
  scroll.remember('serial', viewport);
  viewport.scrollHeight = 1400;
  scroll.update('serial', viewport, true);
  assert.equal(viewport.scrollTop, 120);
  viewport.scrollTop = 1300;
  scroll.remember('serial', viewport);
  viewport.scrollHeight = 1800;
  scroll.update('serial', viewport, true);
  assert.equal(viewport.scrollTop, 1700);
});

test('serial and compiler output retain separate scroll positions across view switches', () => {
  const scroll = new LogScrollController();
  const viewport = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
  scroll.update('serial', viewport, true);
  viewport.scrollTop = 200;
  scroll.remember('serial', viewport);
  viewport.scrollHeight = 600;
  scroll.update('output', viewport, true);
  assert.equal(viewport.scrollTop, 500);
  viewport.scrollHeight = 1100;
  scroll.update('serial', viewport, true);
  assert.equal(viewport.scrollTop, 200);
});

test('hidden panels do not scroll and reopening restores the same reviewed output', () => {
  const scroll = new LogScrollController();
  const viewport = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
  scroll.update('serial', viewport, true);
  viewport.scrollTop = 320;
  scroll.remember('serial', viewport);
  scroll.update('serial', viewport, false);
  viewport.scrollHeight = 1600;
  scroll.update('serial', viewport, false);
  assert.equal(viewport.scrollTop, 320);
  viewport.scrollTop = 0;
  scroll.update('serial', viewport, true);
  assert.equal(viewport.scrollTop, 320);
});

test('resizing follows the tail only for a view already following it', () => {
  const scroll = new LogScrollController();
  const viewport = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
  scroll.update('serial', viewport, true);
  viewport.clientHeight = 300;
  scroll.update('serial', viewport, true);
  assert.equal(viewport.scrollTop, 700);
  viewport.scrollTop = 150;
  scroll.remember('serial', viewport);
  viewport.clientHeight = 450;
  scroll.update('serial', viewport, true);
  assert.equal(viewport.scrollTop, 150);
});
