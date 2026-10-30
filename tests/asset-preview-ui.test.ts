import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetPreviewSurface } from '../src/renderer/components/AssetPreview';
import { FileIcon, fileVisual } from '../src/renderer/components/FileIcon';
import { FileAudio, FileImage, FileVideo } from 'lucide-react';
import { assetDuration, assetHexRows, stopAssetMedia } from '../src/renderer/components/assetPreviewModel';
import type { WorkspaceAssetPreview } from '../src/shared/assets';

const asset = (kind: WorkspaceAssetPreview['kind'], extension: string): WorkspaceAssetPreview => ({
  path: `resources/preview.${extension}`,
  kind,
  mime: `${kind}/${extension}`,
  size: 1024,
  modifiedAt: '2026-10-30T04:00:00.000Z',
  url: 'blode-asset://workspace/fixture',
});

test('image previews use an image context and offer fit, actual size and zoom controls', () => {
  const html = renderToStaticMarkup(
    createElement(AssetPreviewSurface, { asset: asset('image', 'svg'), onReload() {} }),
  );
  assert.match(html, /<img[^>]*src="blode-asset:\/\/workspace\/fixture"/);
  assert.match(html, /aria-label="原始大小"/);
  assert.match(html, /aria-label="放大"/);
  assert.match(html, /aria-pressed="true"[^>]*>适应窗口/);
  assert.doesNotMatch(html, /<(?:iframe|object|embed)\b|dangerouslySetInnerHTML/);
});

test('audio and video expose native playback controls without starting playback automatically', () => {
  for (const [kind, extension] of [
    ['audio', 'wav'],
    ['video', 'mp4'],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(AssetPreviewSurface, { asset: asset(kind, extension), onReload() {} }),
    );
    assert.match(html, new RegExp(`<${kind}[^>]*controls=""[^>]*preload="metadata"`));
    assert.doesNotMatch(html, /autoplay|autoPlay|<iframe/);
  }
});

test('binary previews retain offsets and printable text while bounding the display to the provided prefix', () => {
  const rows = assetHexRows('000a20417f80ff' + '42'.repeat(10));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    offset: '00000000',
    hex: '00 0A 20 41 7F 80 FF 42 42 42 42 42 42 42 42 42',
    text: '·· A···BBBBBBBBB',
  });
  assert.equal(rows[1].offset, '00000010');
  assert.deepEqual(assetHexRows('not hex'), []);
  assert.deepEqual(assetHexRows('1'), []);
  assert.deepEqual(assetHexRows(''), []);
  const html = renderToStaticMarkup(
    createElement(AssetPreviewSurface, {
      asset: { ...asset('binary', 'bin'), hex: '3c7363726970743e', truncated: true },
      onReload() {},
    }),
  );
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /显示前.*8 B/);
});

test('media duration supports hours and ignores unknown stream duration', () => {
  assert.equal(assetDuration(0), '0:00');
  assert.equal(assetDuration(65.9), '1:05');
  assert.equal(assetDuration(3661), '1:01:01');
  assert.equal(assetDuration(Infinity), '');
  assert.equal(assetDuration(Number.NaN), '');
  assert.equal(assetDuration(-1), '');
});

test('closing media pauses it and removes its source before releasing browser resources', () => {
  const events: string[] = [];
  stopAssetMedia({
    pause() {
      events.push('pause');
    },
    removeAttribute(name: string) {
      events.push('remove:' + name);
    },
    load() {
      events.push('load');
    },
  } as HTMLMediaElement);
  assert.deepEqual(events, ['pause', 'remove:src', 'load']);
  stopAssetMedia(null);
});

test('the file tree and tabs distinguish common media formats', () => {
  for (const [name, icon] of [
    ['SOUND.WAV', FileAudio],
    ['clip.mp4', FileVideo],
    ['photo.avif', FileImage],
  ] as const) {
    assert.equal(fileVisual(name).icon, icon);
    assert.match(renderToStaticMarkup(createElement(FileIcon, { name })), /aria-hidden="true"/);
  }
});
