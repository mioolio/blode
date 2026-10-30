import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

interface Options {
  directory: string;
  platform?: NodeJS.Platform;
  protect?: (secret: string) => Promise<string>;
  unprotect?: (encoded: string) => Promise<string>;
}

/** The credential is sent over stdin, never through command arguments or application logs. */
function dpapi(value: string, decrypt: boolean): Promise<string> {
  const script = decrypt
    ? "$null=[Reflection.Assembly]::LoadWithPartialName('System.Security');$v=[Convert]::FromBase64String([Console]::In.ReadToEnd());$b=[Security.Cryptography.ProtectedData]::Unprotect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($b))"
    : "$null=[Reflection.Assembly]::LoadWithPartialName('System.Security');$v=[Convert]::FromBase64String([Console]::In.ReadToEnd());$b=[Security.Cryptography.ProtectedData]::Protect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($b))";
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error
        ? reject(error)
        : resolve(decrypt ? Buffer.from(output.trim(), 'base64').toString('utf8') : output.trim());
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('error.aiCredentialStore'));
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 100_000) {
        child.kill();
        finish(new Error('error.aiCredentialStore'));
      }
    });
    child.stderr.resume();
    child.on('error', () => finish(new Error('error.aiCredentialStore')));
    child.on('close', (code) =>
      finish(code === 0 && output ? undefined : new Error('error.aiCredentialStore')),
    );
    child.stdin.on('error', () => finish(new Error('error.aiCredentialStore')));
    child.stdin.end(decrypt ? value : Buffer.from(value, 'utf8').toString('base64'), 'utf8');
  });
}

/** Per-host encrypted storage. Public settings contain only whether a key exists. */
export class ModelCredentials {
  private cache = new Map<string, string>();
  constructor(private readonly options: Options) {}
  private file(id: string) {
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(id)) throw new Error('rpc.invalidParams');
    return path.join(this.options.directory, `${id}.credential`);
  }
  private async machineKey() {
    const file = path.join(this.options.directory, '.key');
    await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const key = await fs.readFile(file);
    if (key.length !== 32) throw new Error('error.aiCredentialStore');
    return key;
  }
  private async encrypt(value: string) {
    if (this.options.protect) return `protected:${await this.options.protect(value)}`;
    if ((this.options.platform ?? process.platform) === 'win32') return `dpapi:${await dpapi(value, false)}`;
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', await this.machineKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `aes:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
  }
  private async decrypt(value: string) {
    if (value.startsWith('protected:') && this.options.unprotect)
      return this.options.unprotect(value.slice(10));
    if (value.startsWith('dpapi:') && (this.options.platform ?? process.platform) === 'win32')
      return dpapi(value.slice(6), true);
    if (value.startsWith('aes:')) {
      const bytes = Buffer.from(value.slice(4), 'base64');
      if (bytes.length < 29) throw new Error('error.aiCredentialStore');
      const decipher = createDecipheriv('aes-256-gcm', await this.machineKey(), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
    throw new Error('error.aiCredentialStore');
  }
  async has(id: string): Promise<boolean> {
    return this.cache.has(id) || !!(await fs.stat(this.file(id)).catch(() => undefined))?.isFile();
  }
  async get(id: string): Promise<string | undefined> {
    if (this.cache.has(id)) return this.cache.get(id);
    const raw = await fs.readFile(this.file(id), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!raw) return undefined;
    if (raw.length > 100_000) throw new Error('error.aiCredentialStore');
    const secret = await this.decrypt(raw);
    this.cache.set(id, secret);
    return secret;
  }
  async set(id: string, secret: string) {
    if (!secret || secret.length > 8192 || /[\r\n\0]/.test(secret)) throw new Error('rpc.invalidParams');
    const file = this.file(id),
      temporary = `${file}.${randomUUID()}.tmp`;
    const encoded = await this.encrypt(secret);
    await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    this.cache.set(id, secret);
  }
  async remove(id: string) {
    this.cache.delete(id);
    await fs.unlink(this.file(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
