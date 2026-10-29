import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalPrompt } from '../src/core/terminal-prompt';

test('ConPTY completion OSC cannot finish before the actual output and rendered prompt', () => {
  const prompt = new TerminalPrompt();
  prompt.request();
  assert.equal(prompt.begin(1), true);
  prompt.prompt(1, 0, 'C:\\work', true);
  assert.equal(prompt.screen("Write-Output '中文'\r\n"), undefined);
  assert.equal(prompt.screen('中文\r\nPS C:\\wo'), undefined);
  assert.deepEqual(prompt.screen('rk>\x1b[1C\x1b[?25h'), { code: 0, execution: 1 });
  assert.equal(prompt.begin(1), false, 'late duplicate begin cannot restart a completed command');
});

test('a previous execution prompt or redraw cannot finish the newly submitted command', () => {
  const prompt = new TerminalPrompt();
  prompt.request();
  prompt.begin(1);
  prompt.prompt(1, 0, 'C:\\work', true);
  assert.ok(prompt.screen('PS C:\\work> '));
  prompt.request();
  prompt.prompt(1, 0, 'C:\\work', true);
  assert.equal(prompt.screen('PS C:\\work> '), undefined);
  assert.equal(prompt.begin(1), false);
  assert.equal(prompt.begin(2), true);
  prompt.prompt(2, 0, 'C:\\work', false);
  assert.equal(prompt.screen('PS C:\\work> '), undefined);
  assert.deepEqual(prompt.prompt(2, 7, 'C:\\work', true), { code: 7, execution: 2 });
});

test('rendered prompts support wrapping and two consecutive silent commands', () => {
  const prompt = new TerminalPrompt();
  for (let execution = 1; execution <= 2; execution++) {
    prompt.request();
    assert.equal(prompt.begin(execution), true);
    prompt.prompt(execution, 0, 'C:\\long directory\\project', true);
    assert.equal(prompt.screen('$null = 1\r\nPS C:\\long '), undefined);
    assert.deepEqual(prompt.screen('directory\\\r\nproject>\x1b[1C\r\n\x1b[10X\x1b[8;67H'), {
      code: 0,
      execution,
    });
  }
});

test('screen data can arrive before its OSC completion without losing the prompt barrier', () => {
  const prompt = new TerminalPrompt();
  prompt.request();
  assert.equal(prompt.awaitingBegin(), true);
  prompt.begin(1);
  assert.equal(prompt.awaitingBegin(), false);
  assert.equal(prompt.screen('result\r\nPS C:\\work>\x1b[1C'), undefined);
  assert.deepEqual(prompt.prompt(1, 0, 'C:\\work', true), { code: 0, execution: 1 });
});
