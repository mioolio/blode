'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

function matchesTarget(context, installed, { platform = process.platform, arch = process.arch } = {}) {
  const target = context?.platform?.nodeName ?? context?.platform;
  return (
    target === platform &&
    context.arch === arch &&
    typeof context.electronVersion === 'string' &&
    context.electronVersion === installed
  );
}
const probeSource = String.raw`
'use strict';
const path=require('node:path');const{createRequire}=require('node:module');
const root=process.argv[2],expected=process.argv[3],arch=process.argv[4],marker='Blode原生终端验证';
let terminal,timer;
const finish=(error)=>{clearTimeout(timer);try{terminal?.kill();}catch{}if(error){process.stderr.write(String(error.message||error).slice(0,4096));process.exitCode=1;}else process.stdout.write('BLODE_NATIVE_PROBE:'+JSON.stringify({ok:true,electron:process.versions.electron,platform:process.platform,arch:process.arch,serialport:true,pty:true,utf8:true})+'\n');};
try{
 if(process.versions.electron!==expected||process.arch!==arch)throw Error('Electron target mismatch');
 const localRequire=createRequire(path.join(root,'package.json'));
 const serial=localRequire('serialport'),bindings=localRequire('@serialport/bindings-cpp');
 if(typeof serial.SerialPort!=='function'||typeof bindings.autoDetect!=='function')throw Error('SerialPort API unavailable');
 const binding=bindings.autoDetect();if(typeof binding.open!=='function'||typeof binding.list!=='function')throw Error('SerialPort binding unavailable');
 const pty=localRequire('node-pty');if(typeof pty.spawn!=='function')throw Error('PTY API unavailable');
 const windows=process.platform==='win32',shell=windows?path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'/bin/sh';
 const command="$OutputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false;[Console]::Write('"+marker+"');exit 0";
 const args=windows?['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')]:['-c',"printf '%s' '"+marker+"';exit 0"];
 let output='',exited=false;terminal=pty.spawn(shell,args,{name:'xterm-256color',cols:100,rows:24,cwd:process.cwd(),env:{...process.env,NO_COLOR:'1',PYTHONUTF8:'1',LC_ALL:'C.UTF-8'}});
 terminal.onData(data=>{output=(output+data).slice(-16000);});
 terminal.onExit(({exitCode})=>{if(exited)return;exited=true;if(exitCode!==0||!output.includes(marker))finish(Error('PTY UTF-8/exit probe failed'));else finish();});
 timer=setTimeout(()=>{if(exited)return;exited=true;finish(Error('PTY probe timed out'));},15000);
}catch(error){finish(error);}
`;
async function probeNativeRuntime(
  context,
  { spawnProcess = spawn, host = { platform: process.platform, arch: process.arch } } = {},
) {
  let directory;
  try {
    const localRequire = createRequire(path.join(path.resolve(context.appDir), 'package.json'));
    const installed = localRequire('electron/package.json').version;
    if (!matchesTarget(context, installed, host)) return { ok: false, reason: 'target-mismatch' };
    const executable = localRequire('electron');
    if (typeof executable !== 'string') return { ok: false, reason: 'electron-unavailable' };
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-native-probe-'));
    const file = path.join(directory, 'probe.cjs');
    await fs.writeFile(file, probeSource, 'utf8');
    const { NODE_OPTIONS: _, ...environment } = process.env;
    return await new Promise((resolve) => {
      let child,
        output = '',
        stderr = '',
        settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          child?.kill();
        } catch {}
        finish({ ok: false, reason: 'probe-timeout' });
      }, 20000);
      try {
        child = spawnProcess(
          executable,
          [file, path.resolve(context.appDir), context.electronVersion, context.arch],
          {
            cwd: directory,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
          },
        );
      } catch {
        finish({ ok: false, reason: 'probe-start' });
        return;
      }
      child.stdout?.on('data', (data) => {
        output = (output + data).slice(-64000);
      });
      child.stderr?.on('data', (data) => {
        stderr = (stderr + data).slice(-4096);
      });
      child.once('error', () => finish({ ok: false, reason: 'probe-start' }));
      child.once('close', (code) => {
        if (code !== 0) return finish({ ok: false, reason: 'probe-failed', details: stderr });
        try {
          const line = output.split(/\r?\n/).find((line) => line.startsWith('BLODE_NATIVE_PROBE:'));
          const value = JSON.parse(line.slice('BLODE_NATIVE_PROBE:'.length));
          finish(
            value.ok === true &&
              value.electron === installed &&
              value.platform === host.platform &&
              value.arch === host.arch &&
              value.serialport &&
              value.pty &&
              value.utf8
              ? value
              : { ok: false, reason: 'probe-invalid' },
          );
        } catch {
          finish({ ok: false, reason: 'probe-invalid' });
        }
      });
    });
  } catch {
    return { ok: false, reason: 'probe-unavailable' };
  } finally {
    if (directory) {
      const checked = path.resolve(directory);
      if (
        path.dirname(checked) !== path.resolve(os.tmpdir()) ||
        !path.basename(checked).startsWith('blode-native-probe-')
      )
        throw Error('Unexpected native probe directory');
      await fs.rm(checked, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
async function beforeBuild(context) {
  try {
    await clearRuntimeStage(context);
  } catch (error) {
    throw new Error('Cannot prepare isolated native runtime staging', { cause: error });
  }
  const result = await probeNativeRuntime(context);
  if (result.ok) {
    try {
      const staged = await prepareRuntimeStage(context);
      console.log(
        `Native runtimes verified with Electron ${result.electron} ${result.platform}-${result.arch}; staged ${staged.packages.length} production dependencies.`,
      );
      return false;
    } catch {
      console.log('Native runtime dependency staging failed; continuing the standard dependency rebuild.');
      return true;
    }
  }
  console.log(`Native runtime probe ${result.reason}; continuing the standard dependency rebuild.`);
  // app-builder-lib treats every falsy return as externally handled; true is required here.
  return true;
}
module.exports = { matchesTarget, probeNativeRuntime, beforeBuild };
const syncFs = require('node:fs');
const runtimeEntries = ['serialport', 'node-pty', '@modelcontextprotocol/sdk', 'zod'];
function targetStage(context) {
  const platform =
    context.platform?.buildConfigurationKey ??
    { win32: 'win', darwin: 'mac', linux: 'linux' }[context.platform?.nodeName ?? context.platform];
  if (
    !['win', 'mac', 'linux'].includes(platform) ||
    !['x64', 'ia32', 'arm64', 'armv7l', 'universal'].includes(context.arch)
  )
    throw Error('Unsupported build target');
  const base = process.env.BLODE_NATIVE_STAGE_ROOT
    ? path.resolve(process.env.BLODE_NATIVE_STAGE_ROOT)
    : path.resolve(context.appDir, '.tools', 'native-runtime-stage');
  return { base, directory: path.join(base, platform + '-' + context.arch) };
}
async function clearRuntimeStage(context) {
  const { base, directory } = targetStage(context);
  await fs.mkdir(base, { recursive: true });
  const actualBase = await fs.realpath(base),
    appRoot = await fs.realpath(context.appDir);
  const relative = path.relative(appRoot, actualBase);
  if (
    (await fs.lstat(base)).isSymbolicLink() ||
    (!process.env.BLODE_NATIVE_STAGE_ROOT && relative !== path.join('.tools', 'native-runtime-stage'))
  )
    throw Error('Native runtime staging path escapes app directory');
  const stat = await fs.lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw Error('Native runtime staging must be a real directory');
  if (path.dirname(directory) !== base) throw Error('Unexpected native runtime staging directory');
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory);
  return directory;
}
function runtimeDependencies(appDir) {
  const top = new Map(),
    seen = new Set(),
    result = [];
  const resolve = (name, lookup) => {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw Error('Invalid runtime dependency name');
    for (const directory of lookup.resolve.paths(name) ?? []) {
      const file = path.join(directory, name, 'package.json');
      if (syncFs.existsSync(file))
        return {
          source: syncFs.realpathSync(path.dirname(file)),
          metadata: JSON.parse(syncFs.readFileSync(file, 'utf8')),
        };
    }
    throw Error('Missing runtime dependency: ' + name);
  };
  const visit = (name, lookup, parent, optional = false) => {
    let pack;
    try {
      pack = resolve(name, lookup);
    } catch (error) {
      if (optional) return;
      throw error;
    }
    const first = top.get(name);
    if (!first) top.set(name, pack.source);
    const destination =
      !first || first === pack.source ? 'node_modules/' + name : parent + '/node_modules/' + name;
    const key = pack.source + '\0' + destination;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ source: pack.source, destination });
    const childRequire = createRequire(path.join(pack.source, 'package.json'));
    for (const dependency of Object.keys({
      ...pack.metadata.dependencies,
      ...pack.metadata.optionalDependencies,
    }))
      visit(
        dependency,
        childRequire,
        destination,
        Object.hasOwn(pack.metadata.optionalDependencies ?? {}, dependency),
      );
  };
  const root = createRequire(path.join(path.resolve(appDir), 'package.json'));
  for (const name of runtimeEntries) visit(name, root, '');
  return result;
}
async function prepareRuntimeStage(context) {
  const directory = await clearRuntimeStage(context),
    packages = runtimeDependencies(context.appDir);
  try {
    for (const pack of packages) {
      const relative = pack.destination.slice('node_modules/'.length),
        destination = path.join(directory, relative);
      if (relative.startsWith('../') || path.isAbsolute(relative)) throw Error('Invalid dependency target');
      await fs.cp(pack.source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: async (file) => {
          const relative = path.relative(pack.source, file);
          if (
            relative
              .split(path.sep)
              .some(
                (part) =>
                  ['node_modules', '.git', '.tools', 'test', 'tests', 'node_gyp_bins'].includes(part) ||
                  part === '.env' ||
                  part === '.npmrc' ||
                  part === '.uel' ||
                  part.startsWith('.env.') ||
                  /\.(?:map|obj|o|pdb)$/.test(part),
              )
          )
            return false;
          if ((await fs.lstat(file)).isSymbolicLink())
            throw Error('Runtime dependency contains a symbolic link');
          return true;
        },
      });
    }
    return { directory, packages: packages.map((pack) => pack.destination) };
  } catch (error) {
    await clearRuntimeStage(context);
    throw error;
  }
}
module.exports.targetStage = targetStage;
module.exports.runtimeDependencies = runtimeDependencies;
module.exports.prepareRuntimeStage = prepareRuntimeStage;
