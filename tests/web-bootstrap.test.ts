import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { bootstrapDataRoot, bootstrapOptions, runtimeDirectory } from '../scripts/web-bootstrap';
import { browserLaunch } from '../src/core/open-browser';
import { webCliHelp } from '../src/shared/web-cli';

test('launcher flags are removed from host arguments', () => {
  assert.deepEqual(bootstrapOptions([]), { serverArgs: [], openBrowser: true });
  assert.deepEqual(bootstrapOptions(['--no-open', '--port', '0']), {
    serverArgs: ['--port', '0'],
    openBrowser: false,
  });
  assert.deepEqual(bootstrapOptions(['--open', '--project', '.']), {
    serverArgs: ['--project', '.'],
    openBrowser: true,
  });
  assert.deepEqual(bootstrapOptions(['--no-open', '--open']), { serverArgs: [], openBrowser: true });
  assert.deepEqual(bootstrapOptions(['--open', '--no-open']), { serverArgs: [], openBrowser: false });
});

test('help output never opens a browser', () => {
  assert.equal(bootstrapOptions(['--help']).openBrowser, false);
  assert.equal(bootstrapOptions(['-h']).openBrowser, false);
});

test('data root follows host precedence without creating a directory', () => {
  const environment = { BLODE_DATA_ROOT: path.join(os.tmpdir(), 'blode-data-root-fixture') };
  assert.equal(bootstrapDataRoot([], environment), path.resolve(environment.BLODE_DATA_ROOT));
  const explicit = path.join(os.tmpdir(), 'blode-explicit-data-root');
  assert.equal(bootstrapDataRoot(['--data-root', explicit], environment), path.resolve(explicit));
  // A missing value is left to the host's own validation; the launcher must not
  // resolve it to the project directory.
  assert.notEqual(bootstrapDataRoot(['--data-root'], environment), path.resolve('.'));
});

test('runtime directories are keyed by the payload hash', () => {
  const hash = 'a'.repeat(64);
  const directory = runtimeDirectory('C:\\data', hash);
  assert.equal(directory, path.join('C:\\data', 'runtime', `bundle-${'a'.repeat(16)}`));
});

test('browser launch uses the platform opener', () => {
  assert.deepEqual(browserLaunch('win32', 'http://127.0.0.1:1/?token=x'), {
    command: 'cmd',
    args: ['/c', 'start', '', 'http://127.0.0.1:1/?token=x'],
  });
  assert.deepEqual(browserLaunch('darwin', 'http://127.0.0.1:1/'), {
    command: 'open',
    args: ['http://127.0.0.1:1/'],
  });
  assert.deepEqual(browserLaunch('linux', 'http://127.0.0.1:1/'), {
    command: 'xdg-open',
    args: ['http://127.0.0.1:1/'],
  });
});

test('shared help describes both editions without drift', () => {
  const version = '1.2.3.4';
  const launcher = webCliHelp(version, {
    program: 'Blode Studio Web executable',
    launcher: true,
  });
  assert.ok(launcher.includes(`Blode Studio Web host ${version}`));
  assert.match(launcher, /Usage: Blode Studio Web executable \[options\]/);
  assert.match(launcher, /--no-open/);
  assert.match(launcher, /--version/);
  const source = webCliHelp(version, { program: 'node dist/web-server.cjs' });
  assert.match(source, /Usage: node dist\/web-server\.cjs \[options\]/);
  assert.doesNotMatch(source, /--no-open/);
});
