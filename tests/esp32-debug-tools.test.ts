import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectConfig, InstallationProgress } from '../src/shared/contracts';
import type { runCommand } from '../src/core/process';
import {
  discoverEsp32DebugTools,
  esp32DebugReleases,
  installEsp32DebugRelease,
  installEsp32DebugTools,
  type Esp32DebugRelease,
} from '../src/core/esp32-debug-tools';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-esp32-tools-'));
  const root = path.join(directory, 'tools'),
    dataRoot = path.join(directory, 'data');
  const write = async (relative: string, contents = '') => {
    const file = path.join(directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    return file;
  };
  return {
    directory,
    root,
    dataRoot,
    write,
    options: { root, dataRoot, platform: 'win32' as const, env: {} },
    dispose: async () => {
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.match(path.basename(directory), /^blode-esp32-tools-/);
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test('finds matching Arduino GDB and OpenOCD scripts without starting tools', async () => {
  const f = await fixture();
  try {
    const gdb = await f.write(
      'tools/arduino-data/packages/esp32/tools/xtensa-esp-elf-gdb/16.2/bin/xtensa-esp-elf-gdb.exe',
    );
    const openocd = await f.write(
      'tools/arduino-data/packages/esp32/tools/openocd-esp32/0.12/bin/openocd.exe',
    );
    const scripts = path.join(path.dirname(openocd), '..', 'share', 'openocd', 'scripts');
    await f.write(path.relative(f.directory, path.join(scripts, 'board/esp32s3-builtin.cfg')));
    await f.write(path.relative(f.directory, path.join(scripts, 'target/esp32s3.cfg')));
    assert.deepEqual(await discoverEsp32DebugTools(f.options), {
      gdb,
      openocd,
      scripts: path.resolve(scripts),
    });
  } finally {
    await f.dispose();
  }
});

test('selects newest bounded IDF installation and prefers GDB without a Python runtime dependency', async () => {
  const f = await fixture();
  try {
    await f.write('idf/tools/xtensa-esp-elf-gdb/12.1/xtensa-esp-elf-gdb/bin/xtensa-esp-elf-gdb.exe');
    await f.write('idf/tools/xtensa-esp-elf-gdb/16.2/xtensa-esp-elf-gdb/bin/xtensa-esp-elf-gdb.exe');
    const expected = await f.write(
      'idf/tools/xtensa-esp-elf-gdb/16.2/xtensa-esp-elf-gdb/bin/xtensa-esp-elf-gdb-no-python.exe',
    );
    const found = await discoverEsp32DebugTools({
      ...f.options,
      env: { IDF_TOOLS_PATH: path.join(f.directory, 'idf') },
    });
    assert.equal(found.gdb, expected);
    assert.equal(found.openocd, null);
  } finally {
    await f.dispose();
  }
});

test('explicit paths take precedence; a broken custom choice never silently selects another tool', async () => {
  const f = await fixture();
  try {
    const alternative = await f.write('path/xtensa-esp-elf-gdb.exe');
    const custom = await f.write('custom/my-gdb.exe');
    const config = { debugger: { gdbPath: custom }, toolchain: {} } as ProjectConfig;
    assert.equal(
      (await discoverEsp32DebugTools({ ...f.options, config, env: { PATH: path.dirname(alternative) } })).gdb,
      custom,
    );
    config.debugger!.gdbPath = path.join(f.directory, 'missing.exe');
    assert.equal(
      (await discoverEsp32DebugTools({ ...f.options, config, env: { PATH: path.dirname(alternative) } })).gdb,
      null,
    );
  } finally {
    await f.dispose();
  }
});

test('portable version stores, custom Arduino stores and Linux PATH are recognized', async () => {
  const f = await fixture();
  try {
    const expected = await f.write(
      'custom-store/arduino-data/packages/esp32/tools/esp-xs3/2302/bin/xtensa-esp32s3-elf-gdb.exe',
    );
    const config = {
      toolchain: { packageDirectory: path.join(f.directory, 'custom-store') },
    } as ProjectConfig;
    assert.equal((await discoverEsp32DebugTools({ ...f.options, config })).gdb, expected);
    const linux = await f.write('linux/bin/xtensa-esp-elf-gdb');
    assert.equal(
      (await discoverEsp32DebugTools({ ...f.options, platform: 'linux', env: { PATH: path.dirname(linux) } }))
        .gdb,
      linux,
    );
  } finally {
    await f.dispose();
  }
});

test('OpenOCD without ESP32-S3 scripts is reported separately from a working installation', async () => {
  const f = await fixture();
  try {
    const openocd = await f.write('tools/openocd-esp32/bin/openocd.exe');
    assert.deepEqual(await discoverEsp32DebugTools(f.options), { gdb: null, openocd, scripts: null });
  } finally {
    await f.dispose();
  }
});

test('release catalog uses platform-specific Espressif archives and pinned publisher hashes', () => {
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
  ] as const) {
    const releases = esp32DebugReleases(platform, arch);
    assert.equal(releases.length, 2);
    for (const entry of releases) {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.ok(entry.size > 1_000_000);
      assert.match(entry.url, /^https:\/\/github\.com\/espressif\//);
    }
  }
  assert.throws(() => esp32DebugReleases('win32', 'arm64'), /esp32DebugInstallUnsupported/);
  assert.throws(() => esp32DebugReleases('darwin', 'x64'), /esp32DebugInstallUnsupported/);
});

const bytes = Buffer.from('test publisher archive');
const release: Esp32DebugRelease = {
  kind: 'xtensa-esp-elf-gdb',
  version: '16.2_20250324',
  url: 'https://github.com/espressif/binutils-gdb/releases/download/esp-gdb-v16.2_20250324/test.zip',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
};
test('installer verifies bytes before extraction and promotes a runnable distribution with progress', async () => {
  const f = await fixture();
  try {
    const progress: InstallationProgress[] = [];
    const calls: string[] = [];
    const runner: typeof runCommand = async (command, args) => {
      calls.push(command);
      if (args[0] === '-tf')
        return { code: 0, output: 'xtensa-esp-elf-gdb/bin/xtensa-esp-elf-gdb-no-python.exe\n' };
      if (args[0] === '-xf') {
        const bin = path.join(args[3], 'xtensa-esp-elf-gdb/bin');
        await fs.mkdir(bin, { recursive: true });
        await fs.writeFile(path.join(bin, 'xtensa-esp-elf-gdb-no-python.exe'), 'tool');
        return { code: 0, output: '' };
      }
      return { code: 0, output: 'GNU gdb (esp-gdb) 16.2_20250324' };
    };
    await installEsp32DebugRelease(release, {
      ...f.options,
      runner,
      fetcher: async () => new Response(bytes),
      onProgress: (p) => progress.push(p),
    });
    const found = await discoverEsp32DebugTools(f.options);
    assert.equal(
      found.gdb,
      path.join(
        f.root,
        'esp32-debug/xtensa-esp-elf-gdb/16.2_20250324/xtensa-esp-elf-gdb/bin/xtensa-esp-elf-gdb-no-python.exe',
      ),
    );
    assert.equal(calls.length, 3);
    assert.equal(progress.at(-1)?.phase, 'completed');
    assert.ok(progress.some((p) => p.phase === 'downloading' && p.receivedBytes === bytes.length));
    assert.ok(
      progress.findIndex((p) => p.phase === 'verifying') <
        progress.findIndex((p) => p.phase === 'extracting'),
    );
    const dirs = await fs.readdir(path.join(f.root, 'esp32-debug/xtensa-esp-elf-gdb'));
    assert.deepEqual(dirs, ['16.2_20250324']);
  } finally {
    await f.dispose();
  }
});

test('checksum and archive traversal failures preserve an existing installed tool', async () => {
  for (const failure of ['checksum', 'traversal', 'version'] as const) {
    const f = await fixture();
    try {
      const original = await f.write(
        'tools/esp32-debug/xtensa-esp-elf-gdb/16.2_20250324/keep.txt',
        'original',
      );
      let extracted = false;
      const runner: typeof runCommand = async (_command, args) => {
        if (args[0] === '-tf')
          return {
            code: 0,
            output:
              failure === 'traversal'
                ? 'xtensa-esp-elf-gdb/../../escape.exe'
                : 'xtensa-esp-elf-gdb/bin/xtensa-esp-elf-gdb.exe',
          };
        if (args[0] === '-xf') {
          extracted = true;
          const bin = path.join(args[3], 'xtensa-esp-elf-gdb/bin');
          await fs.mkdir(bin, { recursive: true });
          await fs.writeFile(path.join(bin, 'xtensa-esp-elf-gdb.exe'), 'bad');
          return { code: 0, output: '' };
        }
        return { code: 1, output: 'missing DLL' };
      };
      await assert.rejects(
        installEsp32DebugRelease(release, {
          ...f.options,
          runner,
          fetcher: async () => new Response(failure === 'checksum' ? Buffer.from('bad') : bytes),
        }),
        /esp32DebugChecksum|esp32DebugArchive|esp32DebugToolInvalid/,
      );
      assert.equal(await fs.readFile(original, 'utf8'), 'original');
      assert.equal(extracted, failure === 'version');
      assert.deepEqual(await fs.readdir(path.dirname(path.dirname(original))), ['16.2_20250324']);
    } finally {
      await f.dispose();
    }
  }
});

test('OpenOCD installation rejects incomplete scripts rather than reporting success then unavailable', async () => {
  const f = await fixture();
  try {
    const phases: string[] = [];
    const runner: typeof runCommand = async (_command, args) => {
      if (args[0] === '-tf') return { code: 0, output: 'openocd-esp32/bin/openocd.exe\n' };
      if (args[0] === '-xf') {
        const distribution = path.join(args[3], 'openocd-esp32');
        await fs.mkdir(path.join(distribution, 'bin'), { recursive: true });
        await fs.writeFile(path.join(distribution, 'bin/openocd.exe'), 'mock');
        const board = path.join(distribution, 'share/openocd/scripts/board');
        await fs.mkdir(board, { recursive: true });
        await fs.writeFile(path.join(board, 'esp32s3-builtin.cfg'), 'source target/esp32s3.cfg');
        return { code: 0, output: '' };
      }
      return { code: 0, output: 'Open On-Chip Debugger esp32' };
    };
    await assert.rejects(
      installEsp32DebugRelease(
        { ...release, kind: 'openocd-esp32' },
        {
          ...f.options,
          runner,
          fetcher: async () => new Response(bytes),
          onProgress: (progress) => phases.push(progress.phase),
        },
      ),
      /esp32DebugArchive/,
    );
    assert.equal(phases.at(-1), 'failed');
    assert.equal(phases.includes('completed'), false);
  } finally {
    await f.dispose();
  }
});

test('cancellation and unsupported platforms do not download or run a tool', async () => {
  const f = await fixture();
  try {
    const network = async () => {
      throw new Error('unexpected download');
    };
    await assert.rejects(
      installEsp32DebugTools({ ...f.options, signal: AbortSignal.abort(), fetcher: network }),
      /operationCancelled/,
    );
    await assert.rejects(
      installEsp32DebugTools({ ...f.options, platform: 'win32', arch: 'arm64', fetcher: network }),
      /esp32DebugInstallUnsupported/,
    );
  } finally {
    await f.dispose();
  }
});
