import test from 'node:test';
import assert from 'node:assert/strict';
import { getBoardAdapter, listBoards } from '../extensions/registry';
import type { AppState } from '../src/shared/contracts';
import { debuggerProjectConfig } from '../src/renderer/components/debuggerProfiles';

test('a headless or desktop auto workspace opens the last ESP target with the current physical connection', () => {
  const config = getBoardAdapter('auto').createConfig(),
    target = getBoardAdapter('Esp32_S3_CAM').createConfig();
  config.port = 'COM3';
  config.runtime = { deviceId: 'CURRENT-USB' };
  config.debugger = { transport: 'uart-gdb', port: 'COM3' };
  target.port = 'COM99';
  target.runtime = { deviceId: 'OLD-USB' };
  target.debugger = { transport: 'usb-jtag' };
  const state = {
    config,
    boards: listBoards(),
    buildTarget: {
      id: 'camera',
      name: 'Camera',
      root: 'Camera',
      config: target,
      buildDirectory: '.blode/targets/camera/build',
      stateFile: '.blode/targets/camera/build-state.json',
    },
    debugProbes: [],
  } as unknown as AppState;
  const selected = debuggerProjectConfig(state)!;
  assert.equal(selected.boardId, 'Esp32_S3_CAM');
  assert.equal(selected.port, 'COM3');
  assert.equal(selected.runtime?.deviceId, 'CURRENT-USB');
  assert.equal(selected.debugger?.transport, 'uart-gdb');
  const manuallyAdjusted = { ...selected, debugger: { transport: 'uart-gdb' as const, port: 'COM7' } };
  assert.equal(debuggerProjectConfig(state, manuallyAdjusted)?.debugger?.port, 'COM7');
});

test('a target cannot resurrect its saved probe after that physical probe is removed', () => {
  const config = getBoardAdapter('auto').createConfig(),
    target = getBoardAdapter('STM32F103C8T6').createConfig();
  config.programmer!.serialNumber = 'AABBCC';
  target.programmer!.serialNumber = '112233';
  const state = {
    config,
    boards: listBoards(),
    buildTarget: { config: target },
    debugProbes: [],
    connections: { probes: { state: 'ready' } },
  } as unknown as AppState;
  assert.equal(debuggerProjectConfig(state)?.programmer?.serialNumber, '');
  delete state.buildTarget;
  assert.equal(debuggerProjectConfig(state)?.boardId, 'STM32F103C8T6');
  assert.equal(debuggerProjectConfig(state)?.programmer?.serialNumber, '');
});
