import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputDecoder } from '../src/core/output-decoder';
import { runCommand } from '../src/core/process';

test('UTF-8 decoder retains every boundary and distinguishes legacy Chinese output on Windows', () => {
  for (const text of ['中文输出😀\n', 'error: 找不到文件\r\n']) {
    const decoder = new OutputDecoder('auto', true);
    let actual = '';
    for (const byte of Buffer.from(text)) actual += decoder.write(Buffer.from([byte]));
    actual += decoder.end();
    assert.equal(actual, text);
  }
  const legacy = new OutputDecoder('auto', true);
  const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xca, 0xe4, 0xb3, 0xf6]);
  let text = '';
  for (const byte of bytes) text += legacy.write(Buffer.from([byte]));
  assert.equal(text + legacy.end(), '中文输出');
  const utf16 = new OutputDecoder('auto', true);
  const encoded = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]);
  assert.equal(utf16.write(encoded.subarray(0, 1)) + utf16.write(encoded.subarray(1)) + utf16.end(), '中文');
});

test('command runner preserves split Chinese stdout/stderr and independent line fragments', async () => {
  const lines: string[] = [];
  const script = `const text=Buffer.from('中文输出\\n');let i=0;const tick=setInterval(()=>{if(i===text.length){clearInterval(tick);process.stderr.write('错误信息\\n');return;}process.stdout.write(text.subarray(i,i+1));i++;},2);`;
  const result = await runCommand(process.execPath, ['-e', script], {
    onLine: (line) => lines.push(line),
    timeout: 10000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '中文输出\n');
  assert.equal(result.stderr, '错误信息\n');
  assert.ok(lines.includes('中文输出'));
  assert.ok(lines.includes('错误信息'));
});
