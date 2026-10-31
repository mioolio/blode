import test from 'node:test';
import assert from 'node:assert/strict';
import { unsignedNodeExecutable } from '../scripts/sea-executable';

function fixture() {
  const bytes = Buffer.alloc(1040);
  bytes.write('MZ');
  bytes.writeUInt32LE(128, 0x3c);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148);
  bytes.writeUInt16LE(0x20b, 152);
  bytes.writeUInt32LE(16, 260);
  bytes.writeUInt32LE(1024, 296);
  bytes.writeUInt32LE(16, 300);
  bytes.writeUInt32LE(512, 408);
  bytes.writeUInt32LE(512, 412);
  bytes.fill(7, 512, 1024);
  bytes.fill(9, 1024);
  return bytes;
}

test('SEA signing removes only the original trailing certificate, preserving executable sections', () => {
  const source = fixture();
  const result = unsignedNodeExecutable(source);
  assert.equal(result.length, 1024);
  assert.equal(result.readUInt32LE(296), 0);
  assert.equal(result.readUInt32LE(300), 0);
  assert.deepEqual(result.subarray(512), source.subarray(512, 1024));
  assert.equal(source.readUInt32LE(296), 1024);
});

test('SEA signing accepts unsigned runtimes and rejects certificates pointing inside code or added resources', () => {
  const unsigned = fixture();
  unsigned.fill(0, 296, 304);
  assert.deepEqual(unsignedNodeExecutable(unsigned), unsigned);
  const bad = fixture();
  bad.writeUInt32LE(512, 296);
  bad.writeUInt32LE(528, 300);
  assert.throws(() => unsignedNodeExecutable(bad), /refusing/);
  assert.throws(() => unsignedNodeExecutable(Buffer.concat([fixture(), Buffer.alloc(8)])), /refusing/);
  assert.throws(() => unsignedNodeExecutable(Buffer.from('not a PE')), /Invalid/);
});
