import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getBoardAdapter } from '../extensions/registry';
import { ResourceLayout } from '../src/renderer/components/ResourceLayout';
import { I18nProvider } from '../src/renderer/i18n';
import { supportsLayout, supportsPartitionEditing } from '../src/renderer/workspace/capabilities';
import { resizeAppRegion, resizeFixedLayout } from '../src/renderer/workspace/layout';

test('STM32 exposes a fixed allocation layout while ESP32 keeps partition editing', () => {
  const stm32 = getBoardAdapter('stm32').definition;
  const esp32 = getBoardAdapter('esp32-s3').definition;
  const auto = getBoardAdapter('auto').definition;

  assert.equal(supportsLayout(stm32), true);
  assert.equal(supportsPartitionEditing(stm32), false);
  assert.equal(supportsLayout(esp32), true);
  assert.equal(supportsPartitionEditing(esp32), true);
  assert.equal(supportsLayout(auto), false);
  assert.equal(supportsPartitionEditing(auto), false);
  // Older platform registrations only declared `partitions`; keep them visible.
  assert.equal(supportsLayout({ capabilities: ['partitions'] }), true);
  assert.equal(supportsPartitionEditing({ capabilities: ['layout'] }), false);

  assert.equal(stm32.layout?.baseAddress, 0x08000000);
  assert.ok(!stm32.capabilities.includes('partitions'));
});

test('fixed layout resizing keeps the single application in sync and records an override', () => {
  const config = getBoardAdapter('stm32').createConfigForFlash!(128 * 1024);
  const resized = resizeFixedLayout(config, 64 * 1024);
  assert.equal(resized.flashSize, 64 * 1024);
  assert.equal(resized.partitions[0]?.size, 64 * 1024);
  assert.equal(resized.flashSizeOverride, true);

  const detected = resizeFixedLayout(resized, 128 * 1024, false);
  assert.equal(detected.flashSize, 128 * 1024);
  assert.equal(detected.partitions[0]?.size, 128 * 1024);
  assert.equal(detected.flashSizeOverride, undefined);

  const allocated = resizeAppRegion(config, 48 * 1024);
  assert.equal(allocated.flashSize, 128 * 1024);
  assert.equal(allocated.partitions[0]?.size, 48 * 1024);
  const grown = resizeFixedLayout(allocated, 256 * 1024);
  assert.equal(grown.partitions[0]?.size, 48 * 1024, 'a reserved tail is not silently allocated');
  const shrunk = resizeFixedLayout(allocated, 32 * 1024);
  assert.equal(shrunk.partitions[0]?.size, 32 * 1024, 'the application cannot exceed physical Flash');
});

test('STM32 layout renders absolute Flash addresses and measured firmware usage', () => {
  const config = getBoardAdapter('stm32').createConfigForFlash!(128 * 1024);
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      children: createElement(ResourceLayout, {
        config,
        baseAddress: 0x08000000,
        firmwareUsed: 2136,
        firmwareStale: false,
        flashSizes: getBoardAdapter('stm32').definition.flashSizes,
        customFlashSize: true,
        onResize: () => {},
        onAllocate: () => {},
        onChangePartitions: () => {},
        onSave: () => {},
        ramUsed: 1024,
        ramTotal: 20 * 1024,
      }),
    }),
  );

  assert.match(html, /0x08000000/);
  assert.match(html, /0x08020000/);
  assert.match(html, /firmware/);
  assert.match(html, /单固件布局/);
  assert.match(html, /2\.1 KiB/);
  assert.match(html, /125\.9 KiB/);
  assert.match(html, /1 KiB \/ 20 KiB/);
  assert.doesNotMatch(html, /尚未编译/);
});

test('STM32 layout states that firmware usage is unknown before a build', () => {
  const config = getBoardAdapter('stm32').createConfig();
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      children: createElement(ResourceLayout, {
        config,
        baseAddress: 0x08000000,
        firmwareUsed: null,
        firmwareStale: false,
        flashSizes: getBoardAdapter('stm32').definition.flashSizes,
        customFlashSize: true,
        onResize: () => {},
        onAllocate: () => {},
        onChangePartitions: () => {},
        onSave: () => {},
        ramUsed: null,
        ramTotal: 20 * 1024,
      }),
    }),
  );

  assert.match(html, /尚未编译/);
  assert.doesNotMatch(html, /上次构建/);
});

test('a manual STM32 capacity is shown against the probe report', () => {
  const config = {
    ...getBoardAdapter('stm32').createConfigForFlash!(64 * 1024),
    flashSizeOverride: true,
  };
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      children: createElement(ResourceLayout, {
        config,
        baseAddress: 0x08000000,
        firmwareUsed: null,
        firmwareStale: false,
        flashSizes: getBoardAdapter('stm32').definition.flashSizes,
        customFlashSize: true,
        detectedFlashSize: 128 * 1024,
        onResize: () => {},
        onAllocate: () => {},
        onChangePartitions: () => {},
        onSave: () => {},
        ramUsed: null,
        ramTotal: 20 * 1024,
      }),
    }),
  );

  assert.match(html, /检测容量 128 KiB/);
  assert.match(html, /检测容量 128 KiB · 手动容量/);
  assert.match(html, /自定义容量 \(KiB\)/);
});

test('application allocation bounds the build and reports reserved Flash plus RAM usage', () => {
  const config = resizeAppRegion(getBoardAdapter('stm32').createConfigForFlash!(128 * 1024), 48 * 1024);
  const render = (firmwareUsed: number) =>
    renderToStaticMarkup(
      createElement(I18nProvider, {
        children: createElement(ResourceLayout, {
          config,
          baseAddress: 0x08000000,
          firmwareUsed,
          firmwareStale: false,
          flashSizes: getBoardAdapter('stm32').definition.flashSizes,
          customFlashSize: true,
          onResize: () => {},
          onAllocate: () => {},
          onChangePartitions: () => {},
          onSave: () => {},
          ramUsed: 1024,
          ramTotal: 20 * 1024,
        }),
      }),
    );

  const fits = render(40 * 1024);
  assert.match(fits, /应用区 \(KiB\)/);
  assert.match(fits, /48 KiB/);
  assert.match(fits, /80 KiB/);
  assert.match(fits, /40 KiB/);
  assert.match(fits, /8 KiB/);
  assert.match(fits, /1 KiB \/ 20 KiB/);
  assert.match(fits, /上次构建结果在应用区内/);

  const overflow = render(50 * 1024);
  assert.match(overflow, /固件超过当前应用区/);
  assert.doesNotMatch(overflow, /上次构建结果在应用区内/);
});

test('a stale build without measured RAM shows a placeholder instead of undefined', () => {
  const config = getBoardAdapter('stm32').createConfigForFlash!(64 * 1024);
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      children: createElement(ResourceLayout, {
        config,
        baseAddress: 0x08000000,
        firmwareUsed: 2136,
        firmwareStale: true,
        flashSizes: getBoardAdapter('stm32').definition.flashSizes,
        customFlashSize: true,
        onResize: () => {},
        onAllocate: () => {},
        onChangePartitions: () => {},
        onSave: () => {},
      }),
    }),
  );

  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /尚未编译/);
  assert.match(html, /上次构建（已过期）/);
});

test('user data regions keep custom names/colors and warn when firmware overlaps them', () => {
  const config = getBoardAdapter('stm32').createConfigForFlash!(64 * 1024);
  config.partitions = [
    { ...config.partitions[0]!, size: 32 * 1024 },
    { id: 'logs', name: 'logs', type: 'data', offset: 32 * 1024, size: 32 * 1024, color: '#112233' },
  ];
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      children: createElement(ResourceLayout, {
        config,
        baseAddress: 0x08000000,
        firmwareUsed: 40 * 1024,
        firmwareStale: false,
        flashSizes: getBoardAdapter('stm32').definition.flashSizes,
        customFlashSize: true,
        onResize: () => {},
        onAllocate: () => {},
        onChangePartitions: () => {},
        onSave: () => {},
        ramUsed: 1024,
        ramTotal: 20 * 1024,
      }),
    }),
  );

  assert.match(html, /logs/);
  assert.match(html, /background:#11223322/);
  assert.match(html, /固件越界并覆盖/);
  assert.match(html, /添加|数据区|系统区/);
});
