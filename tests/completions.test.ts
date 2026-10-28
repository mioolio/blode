import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCProjectCompletions, type CompletionFile } from '../extensions/completions/c';

const files: CompletionFile[] = [
  {
    path: 'src/main.c',
    content: `#include "board.h"
#include <stdint.h>
int main(void) { return 0; }
`,
  },
  {
    path: 'src/board.h',
    content: `#pragma once
#include "../inc/pins.h"
#define BOARD_LED 1
#define MAX(a, b) ((a) > (b) ? (a) : (b))
typedef struct board_state Board;
void board_init(int mode);
`,
  },
  {
    path: 'inc/pins.h',
    content: `#pragma once
#define PIN_LED 13
typedef enum { BOARD_OFF = 0, BOARD_ON = 1 } BoardState;
`,
  },
  {
    path: 'other.h',
    content: `#define UNRELATED_SYMBOL 1`,
  },
  {
    path: 'blode.completions.json',
    content: JSON.stringify({
      c: [
        {
          name: 'MY_CUSTOM',
          kind: 'constant',
          detail: 'custom board constant',
          insertText: 'MY_CUSTOM',
        },
      ],
    }),
  },
];

test('C completions resolve quoted includes recursively from the active file', () => {
  const entries = parseCProjectCompletions(files, 'src/main.c');
  const names = new Set(entries.map((entry) => entry.name));
  assert.ok(names.has('BOARD_LED'));
  assert.ok(names.has('PIN_LED'));
  assert.ok(names.has('board_init'));
  assert.ok(names.has('Board'));
  assert.ok(names.has('BoardState'));
  assert.ok(names.has('MAX'));
  assert.ok(names.has('MY_CUSTOM'));
  assert.ok(!names.has('UNRELATED_SYMBOL'));
  assert.equal(entries.find((entry) => entry.name === 'MAX')?.kind, 'function');
  assert.match(entries.find((entry) => entry.name === 'MAX')?.insertText ?? '', /\$\{1:/);
});

test('C completions follow relative includes and stop on include cycles', () => {
  const cyclic: CompletionFile[] = [
    { path: 'src/a.c', content: '#include "a.h"' },
    { path: 'src/a.h', content: '#include "b.h"\n#define A 1' },
    { path: 'src/b.h', content: '#include "a.h"\n#define B 1' },
  ];
  const entries = parseCProjectCompletions(cyclic, 'src/a.c');
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['A', 'B']);
});
