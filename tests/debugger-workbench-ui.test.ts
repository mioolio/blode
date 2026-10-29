import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HardwareDebuggerView } from '../src/renderer/components/HardwareDebuggerView';

test('debugger first paint exposes resizeable disassembly, registers and memory panes without synthetic CPU telemetry', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __blodeFrameless: false, __blodeWeb: true },
  });
  try {
    const html = renderToStaticMarkup(createElement(HardwareDebuggerView));
    assert.match(html, /class="debug-dock-grid"/);
    assert.match(html, /role="separator"[^>]*aria-orientation="vertical"/);
    assert.match(html, /class="debug-card debug-instructions"/);
    assert.match(html, /class="debug-card debug-registers"/);
    assert.match(html, /class="debug-card debug-memory-view"/);
    assert.match(html, /class="debug-card debug-stack"/);
    assert.match(html, /class="debug-card debug-breakpoints"/);
    assert.doesNotMatch(html, /class="debug-cpu-flow"|ALU · R0/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
