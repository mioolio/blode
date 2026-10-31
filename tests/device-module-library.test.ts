import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceModulePage } from '../src/renderer/components/deviceModuleModel';

test('large device collections use bounded pages, combined search and clamped navigation', () => {
  const modules = Array.from({ length: 10000 }, (_, index) => ({
    id: `Device_${index}`,
    name: `Device ${index}`,
    version: '1.0',
    source: 'plugin' as const,
    directory: '',
    exportId: `Device_${index}`,
    support: [index % 2 ? 'ESP32-S3' : 'STM32F103'],
    transport: 'serial',
  }));
  assert.equal(deviceModulePage(modules, '', 0).entries.length, 25);
  assert.equal(deviceModulePage(modules, '', 399).entries.at(-1)?.id, 'Device_9999');
  const search = deviceModulePage(modules, 'device_9999 ESP32', 399);
  assert.equal(search.total, 1);
  assert.equal(search.page, 0);
  assert.equal(search.entries[0].id, 'Device_9999');
  assert.deepEqual(deviceModulePage(modules, 'missing', 500).entries, []);
});
