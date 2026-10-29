import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getBoardAdapter, listBoards } from '../extensions/registry';
import type { AppState, ProjectConfig } from '../src/shared/contracts';
import { DeviceInspector } from '../src/renderer/components/DeviceInspector';
import { StudioDialogs } from '../src/renderer/components/StudioDialogs';
import { StudioStatusBar } from '../src/renderer/components/StudioStatusBar';
import type { Studio } from '../src/renderer/workspace/useStudio';
import { validatesExistingFirmware } from '../src/renderer/workspace/buildMode';

const serialNumber = '0670FF485053877567113131';

function studioFor(config: ProjectConfig): Studio {
  const state: AppState = {
    projectRoot: '/project',
    workspaceOpen: true,
    build: {},
    config,
    files: [],
    inventory: { entries: [], totalBytes: 0, fileCount: 0, directoryCount: 0, truncated: false },
    boards: listBoards(),
    ports: [{ path: 'COM7', manufacturer: 'Monitor UART' }],
    debugProbes: [{ serialNumber, name: `ST-Link ${serialNumber}`, chipId: '0x410', flashSize: 65536 }],
    detection: {
      candidates: [
        {
          id: 'usb:COM7',
          platformId: 'esp32-s3',
          transport: 'serial',
          name: 'USB UART · COM7',
          port: 'COM7',
        },
        {
          id: `stlink:${serialNumber}`,
          platformId: 'stm32',
          transport: 'stlink',
          name: `ST-Link ${serialNumber}`,
          serialNumber,
        },
      ],
      unavailablePlatforms: [],
    },
    toolchain: {
      arduinoCli: false,
      esp32Core: false,
      python: false,
      esptool: false,
      stlink: true,
      versions: {},
    },
    drivers: [],
    lastBuild: null,
    buildStale: false,
    pipe: { endpoint: '', tokenFile: '' },
    web: { endpoint: '', tokenFile: '', allowExternal: false },
  };
  const partial: Partial<Studio> = {
    t: (key) => key,
    state,
    config,
    board: state.boards.find((item) => item.id === config.boardId),
    isStm32: config.boardId === 'stm32',
    isAuto: config.boardId === 'auto',
    usesStlink: config.boardId === 'stm32' || config.programmer?.transport === 'stlink',
    busy: '',
    drafts: {},
    stale: false,
    dirty: false,
    configDirty: false,
    hasBuildEntry: false,
    validatesFirmware: validatesExistingFirmware(
      state.boards.find((item) => item.id === config.boardId),
      state.build,
    ),
    errors: [],
    warnings: [],
  };
  return partial as Studio;
}

test('STM32 inspector separates the selected ST-Link from the optional monitor COM port', () => {
  const config = getBoardAdapter('stm32').createConfig();
  config.port = 'COM7';
  config.programmer!.serialNumber = serialNumber;
  const html = renderToStaticMarkup(createElement(DeviceInspector, { studio: studioFor(config) }));
  assert.match(html, /device\.debugProbe/);
  assert.match(html, /device\.serialMonitorPort/);
  assert.match(html, /device\.swdFrequency/);
  assert.match(html, new RegExp(`<option value="${serialNumber}" selected="">`));
  assert.match(html, /<option value="COM7" selected="">/);
  assert.doesNotMatch(html, /device\.speed/);
  assert.doesNotMatch(html, /device\.stm32EntryHint|resource\.sourceNotice/);
});

test('an attached ST-Link is not implicitly selected and COM alone cannot enable its probe action', () => {
  const config = getBoardAdapter('stm32').createConfig();
  config.port = 'COM7';
  config.programmer = { transport: 'stlink', serialNumber: '', frequencyKhz: 1800 };
  const html = renderToStaticMarkup(createElement(DeviceInspector, { studio: studioFor(config) }));
  assert.match(html, /<option value="" selected="">device\.debugProbePlaceholder/);
  assert.match(html, /<button class="secondary" disabled="">[^]*?action\.probe<\/button>/);
  assert.doesNotMatch(html, new RegExp(`<option value="${serialNumber}" selected="">`));
});

test('automatic detection offers one combined device choice and permits identification without a selection', () => {
  const config = getBoardAdapter('auto').createConfig();
  config.programmer = { transport: 'auto', serialNumber: '', frequencyKhz: 1800 };
  config.port = 'COM1'; // Optional serial monitor settings are not an identification target.
  const studio = studioFor(config);
  studio.state!.ports.push({ path: 'COM1', manufacturer: 'ACPI motherboard port' });
  const html = renderToStaticMarkup(createElement(DeviceInspector, { studio }));
  assert.match(html, /<option value="" selected="">device\.autoSelection/);
  assert.match(html, /<option value="usb:COM7">USB UART · COM7<\/option>/);
  assert.match(html, new RegExp(`<option value="stlink:${serialNumber}">ST-Link ${serialNumber}<\/option>`));
  assert.match(html, /<button class="secondary">[^]*?action\.probe<\/button>/);
  assert.doesNotMatch(html, /device\.(?:transport|swdFrequency|speed)/);
  const deviceSelect = html.match(
    /<select[^>]*>(?:(?!<\/select>)[\s\S])*device\.autoSelection(?:(?!<\/select>)[\s\S])*<\/select>/,
  )?.[0];
  assert.ok(deviceSelect);
  assert.doesNotMatch(deviceSelect, /COM1/);

  const status = renderToStaticMarkup(createElement(StudioStatusBar, { studio }));
  assert.match(status, /device\.autoSelection/);
  assert.doesNotMatch(status, /COM1/);
});

test('the serial ESP inspector keeps upload baud and its existing COM selection', () => {
  const config = getBoardAdapter('esp32-s3').createConfig();
  config.port = 'COM7';
  const html = renderToStaticMarkup(createElement(DeviceInspector, { studio: studioFor(config) }));
  assert.match(html, /device\.port/);
  assert.match(html, /device\.speed/);
  assert.doesNotMatch(html, /device\.debugProbe/);
});

test('the first loading snapshot keeps saved connectors visible without reporting missing tools', () => {
  const config = getBoardAdapter('stm32').createConfig();
  config.port = 'COM7';
  config.programmer!.serialNumber = serialNumber;
  const studio = studioFor(config);
  studio.state!.initializing = true;
  studio.state!.ports = [];
  studio.state!.debugProbes = [];
  studio.state!.toolchain.stlink = false;
  const html = renderToStaticMarkup(createElement(DeviceInspector, { studio }));
  assert.match(html, new RegExp(`<option value="${serialNumber}" selected="">`));
  assert.match(html, /<option value="COM7" selected="">COM7 · device\.connectionChecking/);
  assert.match(html, /device\.connectionChecking/);
  assert.doesNotMatch(html, /device\.(?:stlinkToolsMissing|debugProbeMissing)/);
  assert.match(html, /<button class="secondary" disabled="">[^]*?action\.probe<\/button>/);
  const status = renderToStaticMarkup(createElement(StudioStatusBar, { studio }));
  assert.match(status, /device\.connectionChecking/);
  assert.doesNotMatch(status, /status\.offline/);
});

test('STM32 flash confirmation identifies the probe and physical target address instead of COM', () => {
  const config = getBoardAdapter('stm32').createConfig();
  config.port = 'COM7';
  config.programmer!.serialNumber = serialNumber;
  config.partitions[0].offset = 0x4000;
  config.partitions[0].size -= 0x4000;
  const studio = studioFor(config);
  studio.confirmFlash = true;
  const html = renderToStaticMarkup(createElement(StudioDialogs, { studio }));
  assert.match(html, new RegExp(`ST-Link ${serialNumber}`));
  assert.match(html, /0x08004000/);
  assert.match(html, /dialog\.stm32FlashBody/);
  assert.doesNotMatch(html, /COM7/);
});
