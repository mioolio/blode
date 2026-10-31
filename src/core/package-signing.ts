import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import trustedKeys from '../shared/package-publishers.json';
import type { PackageApproval, PackageSubject, PackageVerification } from '../shared/package-signing';

export const OBE = 'obe';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const safeSignedPath = (name: string) =>
  !!name &&
  name.length <= 4096 &&
  !/[\\<>:"|?*\x00-\x1f\x7f]/.test(name) &&
  !name
    .split('/')
    .some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );
const recordSchema = z
  .object({
    path: z.string().refine(safeSignedPath),
    size: z.number().int().nonnegative().max(8_000_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SignedFile = z.infer<typeof recordSchema>;
const bodySchema = z
  .object({
    format: z.literal('blode-obe'),
    version: z.literal(1),
    algorithm: z.literal('Ed25519'),
    publisher: z.string().min(1).max(128),
    keyId: z.string().regex(/^[a-f0-9]{64}$/),
    publicKey: z.string().min(1).max(2048),
    signedAt: z.string().datetime(),
    subject: z
      .object({
        kind: z.enum(['device', 'extension', 'component', 'tool', 'application']),
        id: z.string().min(1).max(256),
        version: z.string().max(128),
      })
      .strict(),
    files: z.array(recordSchema).min(1).max(100000),
  })
  .strict();
const envelopeSchema = bodySchema.extend({ signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) });
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson((value as any)[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};
export const publisherKeyId = (pem: string) =>
  sha(createPublicKey(pem).export({ type: 'spki', format: 'der' }));
export function signObe(
  records: SignedFile[],
  subject: PackageSubject,
  privateKey: string,
  publisher = 'Blode Studio',
): Buffer {
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const body = bodySchema.parse({
    format: 'blode-obe',
    version: 1,
    algorithm: 'Ed25519',
    publisher,
    keyId: publisherKeyId(publicKey),
    publicKey,
    signedAt: new Date().toISOString(),
    subject,
    files: records
      .filter((file) => file.path !== OBE)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
  if (new Set(body.files.map((file) => file.path.toLowerCase())).size !== body.files.length)
    throw new Error('error.packagePathCollision');
  return Buffer.from(
    JSON.stringify(
      { ...body, signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString('base64') },
      null,
      2,
    ) + '\n',
  );
}
export function verifyObe(
  records: SignedFile[],
  bytes?: Buffer,
  expected?: Partial<PackageSubject>,
  keys: readonly { keyId: string; publisher: string; publicKey: string }[] = trustedKeys.keys,
): PackageVerification {
  const files = records
    .filter((file) => file.path !== OBE)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const result: PackageVerification = {
    status: bytes ? 'invalid' : 'unsigned',
    fingerprint: sha(canonicalJson({ files, obe: bytes ? sha(bytes) : '' })),
    signatureValid: false,
    trusted: false,
    integrityValid: !bytes,
    changed: [],
  };
  if (!bytes || bytes.length > 64_000_000) return result;
  try {
    const { signature, ...body } = envelopeSchema.parse(JSON.parse(bytes.toString('utf8')));
    const key = createPublicKey(body.publicKey);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      publisherKeyId(body.publicKey) !== body.keyId ||
      !verify(null, Buffer.from(canonicalJson(body)), key, Buffer.from(signature, 'base64'))
    )
      return result;
    result.signatureValid = true;
    result.trusted = keys.some(
      (key) =>
        key.keyId === body.keyId &&
        key.publisher === body.publisher &&
        publisherKeyId(key.publicKey) === body.keyId,
    );
    Object.assign(result, {
      publisher: body.publisher,
      keyId: body.keyId,
      signedAt: body.signedAt,
      subject: body.subject,
    });
    const saved = new Map(body.files.map((file) => [file.path, file]));
    if (
      saved.size !== body.files.length ||
      new Set(body.files.map((file) => file.path.toLowerCase())).size !== saved.size ||
      saved.has(OBE)
    )
      return { ...result, status: 'invalid', signatureValid: false };
    const actual = new Map(files.map((file) => [file.path, file]));
    for (const name of new Set([...saved.keys(), ...actual.keys()])) {
      const before = saved.get(name),
        after = actual.get(name);
      if (!before || !after || before.size !== after.size || before.sha256 !== after.sha256) {
        if (result.changed.length < 50) result.changed.push(name);
      }
    }
    if (
      expected &&
      Object.entries(expected).some(([key, value]) => body.subject[key as keyof PackageSubject] !== value)
    )
      result.changed.push('obe:subject');
    result.integrityValid = result.changed.length === 0;
    result.status = !result.integrityValid ? 'tampered' : result.trusted ? 'verified' : 'untrusted';
    return result;
  } catch {
    return result;
  }
}
export function verifyPackageFiles(files: Map<string, Buffer>, expected?: Partial<PackageSubject>) {
  return verifyObe(
    [...files].map(([name, data]) => ({ path: name, size: data.length, sha256: sha(data) })),
    files.get(OBE),
    expected,
  );
}
export async function hashSignedDirectory(
  root: string,
  options: { signal?: AbortSignal; exclude?: (relative: string, directory: boolean) => boolean } = {},
) {
  root = path.resolve(root);
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('error.packagePathCollision');
  const records: SignedFile[] = [];
  let obe: Buffer | undefined,
    total = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 64) throw new Error('error.packageTooLarge');
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      options.signal?.throwIfAborted();
      const full = path.join(directory, item.name),
        relative = path.relative(root, full).replaceAll('\\', '/');
      if (options.exclude?.(relative, item.isDirectory())) continue;
      if (!safeSignedPath(relative) || item.isSymbolicLink()) throw new Error('error.packagePathCollision');
      if (item.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const before = await fs.lstat(full);
      if (
        !before.isFile() ||
        before.nlink > 1 ||
        records.length >= 100000 ||
        (total += before.size) > 8_000_000_000
      )
        throw new Error('error.packageTooLarge');
      if (relative === OBE) {
        if (before.size > 64_000_000) throw new Error('error.packageTooLarge');
        obe = await fs.readFile(full);
        continue;
      }
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(full, { signal: options.signal })) hash.update(chunk);
      const after = await fs.lstat(full);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.isSymbolicLink()
      )
        throw new Error('error.packageChanged');
      records.push({ path: relative, size: after.size, sha256: hash.digest('hex') });
    }
  };
  await walk(root, 0);
  if (new Set(records.map((file) => file.path.toLowerCase())).size !== records.length)
    throw new Error('error.packagePathCollision');
  return { records, obe };
}
export async function verifyPackageDirectory(
  root: string,
  expected?: Partial<PackageSubject>,
  options?: Parameters<typeof hashSignedDirectory>[1],
) {
  const { records, obe } = await hashSignedDirectory(root, options);
  return verifyObe(records, obe, expected);
}
export function assertPackageApproval(review: PackageVerification, approval?: PackageApproval) {
  if (!approval || approval.fingerprint !== review.fingerprint)
    throw new Error('error.packageApprovalRequired');
  if (review.status !== 'verified' && !approval.allowUntrusted)
    throw new Error('error.packageApprovalRequired');
  if ((review.status === 'tampered' || review.status === 'invalid') && !approval.allowModified)
    throw new Error('error.packageApprovalRequired');
}
export async function verifyPackageArtifact(file: string) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 8_000_000_000)
    throw new Error('error.packageTooLarge');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await fs.lstat(file);
  if (
    before.size !== after.size ||
    before.ctimeMs !== after.ctimeMs ||
    before.mtimeMs !== after.mtimeMs ||
    after.isSymbolicLink()
  )
    throw new Error('error.packageChanged');
  const sidecar = file + '.obe',
    metadata = await fs.lstat(sidecar).catch(() => null);
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64000000))
    throw new Error('error.packageTooLarge');
  return verifyObe(
    [{ path: path.basename(file), size: after.size, sha256: hash.digest('hex') }],
    metadata ? await fs.readFile(sidecar) : undefined,
    { kind: 'application' },
  );
}
