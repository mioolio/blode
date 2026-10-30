import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppState } from '../shared/contracts';
import type { RuntimeFirmwareImage } from '../../extensions/runtime';
import { artifactsMatch, loadBuildState } from './build-state';
import { safeWorkspacePath } from './workspace';
import {
  encodeIntelHex,
  encodeSRecord,
  MAX_FIRMWARE_BYTES,
  mergeSegments,
  normalizeSegments,
  parseIntelHex,
  parseSRecord,
  type FirmwareFormat,
  type FirmwareSegment,
} from './firmware-formats';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface PreparedFirmware {
  id: string;
  name: string;
  format: FirmwareFormat;
  size: number;
  address: number | null;
  segments: number;
  sha256: string;
}
interface Selection {
  metadata: PreparedFirmware;
  segments: FirmwareSegment[];
}

/** Native file paths never cross into the renderer. A selection is an immutable byte snapshot. */
export class FirmwareStore {
  private selections = new Map<string, Selection>();
  constructor(private readonly dataRoot: string) {}

  async choose(filePath: string): Promise<PreparedFirmware> {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('firmware.invalidFile');
    const extension = path.extname(filePath).toLowerCase();
    const format: FirmwareFormat =
      extension === '.bin'
        ? 'bin'
        : ['.hex', '.ihex'].includes(extension)
          ? 'hex'
          : ['.srec', '.s19', '.s28', '.s37', '.mot'].includes(extension)
            ? 'srec'
            : (() => {
                throw new Error('firmware.unsupportedFormat');
              })();
    if (info.size <= 0 || info.size > MAX_FIRMWARE_BYTES * (format === 'bin' ? 1 : 3))
      throw new Error('firmware.imageTooLarge');
    const data = await fs.readFile(filePath);
    if (data.length !== info.size) throw new Error('firmware.fileChanged');
    const segments =
      format === 'bin'
        ? [{ address: 0, data }]
        : format === 'hex'
          ? parseIntelHex(data.toString('utf8'))
          : parseSRecord(data.toString('utf8'));
    const metadata: PreparedFirmware = {
      id: randomUUID(),
      name: path.basename(filePath),
      format,
      size: segments.reduce((size, segment) => size + segment.data.length, 0),
      address: format === 'bin' ? null : segments[0].address,
      segments: segments.length,
      sha256: digest(data),
    };
    // Bound resident selected images; old IDs expire and are never reused.
    let total = metadata.size;
    for (const selection of this.selections.values()) total += selection.metadata.size;
    while (this.selections.size >= 4 || total > MAX_FIRMWARE_BYTES * 2) {
      const oldest = this.selections.keys().next().value;
      if (!oldest) break;
      total -= this.selections.get(oldest)!.metadata.size;
      this.selections.delete(oldest);
    }
    this.selections.set(metadata.id, { metadata, segments });
    return { ...metadata };
  }

  async withImage<T>(
    id: string,
    boardId: string,
    requestedAddress: number | undefined,
    action: (image: RuntimeFirmwareImage) => Promise<T>,
  ): Promise<T> {
    const selected = this.selections.get(id);
    if (!selected) throw new Error('firmware.selectionExpired');
    if (boardId !== 'STM32F103C8T6' && boardId !== 'Esp32_S3_CAM') throw new Error('firmware.selectPlatform');
    if (
      selected.metadata.format !== 'bin' &&
      requestedAddress !== undefined &&
      requestedAddress !== selected.metadata.address
    )
      throw new Error('firmware.addressInFile');
    const base = requestedAddress ?? (boardId === 'STM32F103C8T6' ? 0x08000000 : 0);
    const merged = mergeSegments(
      selected.metadata.format === 'bin'
        ? [{ address: base, data: selected.segments[0].data }]
        : selected.segments,
    );
    const root = path.join(path.resolve(this.dataRoot), 'firmware-staging');
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'image-'));
    const target = path.join(directory, 'image.bin');
    try {
      await fs.writeFile(target, merged.data, { flag: 'wx' });
      return await action({
        path: target,
        address: merged.address,
        size: merged.data.length,
        sha256: digest(merged.data),
      });
    } finally {
      // Delete only this generated leaf; never remove user-selected paths.
      await fs.unlink(target).catch(() => {});
      await fs.rmdir(directory).catch(() => {});
    }
  }
}

export interface BuildExport {
  data: Buffer;
  defaultName: string;
  filterExtension: string;
  manifest?: Buffer;
}

/** Export the actual verified successful build, never a renderer-supplied file path. */
export async function prepareBuildExport(
  root: string,
  state: AppState,
  format: FirmwareFormat | 'elf',
): Promise<BuildExport> {
  if (!root || !state.workspaceOpen || !state.lastBuild?.success || state.buildStale)
    throw new Error('firmware.buildRequired');
  const saved = await loadBuildState(root);
  if (
    !saved ||
    saved.result.timestamp !== state.lastBuild.timestamp ||
    !(await artifactsMatch(root, saved.artifactHashes))
  )
    throw new Error('firmware.buildRequired');
  const boardId = state.config.boardId;
  const app = state.config.partitions.find((partition) => partition.type === 'app');
  const inputs: { file: string; address: number }[] = [];
  if (boardId === 'Esp32_S3_CAM') {
    const suffixes = ['.ino.bootloader.bin', '.ino.partitions.bin', '.ino.bin'];
    for (const [index, suffix] of suffixes.entries()) {
      const file = saved.result.artifacts.find((item) => item.endsWith(suffix));
      if (!file || !app) throw new Error('firmware.incompleteBuild');
      inputs.push({ file, address: index === 0 ? 0 : index === 1 ? 0x8000 : app.offset });
    }
  } else if (boardId === 'STM32F103C8T6') {
    const file = saved.result.artifacts.find((item) => /(?:^|\/)firmware\.bin$/.test(item));
    if (!file) throw new Error('firmware.incompleteBuild');
    inputs.push({ file, address: 0x08000000 });
  } else throw new Error('firmware.selectPlatform');
  const segments: FirmwareSegment[] = [];
  for (const input of inputs) {
    const bytes = await fs.readFile(await safeWorkspacePath(root, input.file, { internal: true }));
    if (digest(bytes) !== saved.artifactHashes[input.file]) throw new Error('firmware.fileChanged');
    segments.push({ address: input.address, data: bytes });
  }
  const normalized = normalizeSegments(segments),
    merged = mergeSegments(normalized);
  const name = (state.config.name || 'firmware').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (format === 'elf') {
    if (boardId !== 'STM32F103C8T6') throw new Error('firmware.elfUnavailable');
    const elfPath = await safeWorkspacePath(root, '.blode/build/firmware.elf', { internal: true });
    const info = await fs.lstat(elfPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_FIRMWARE_BYTES)
      throw new Error('firmware.elfUnavailable');
    const bytes = await fs.readFile(elfPath).catch(() => {
      throw new Error('firmware.elfUnavailable');
    });
    verifyElfAgainstImage(bytes, merged);
    return { data: bytes, defaultName: name + '.elf', filterExtension: 'elf' };
  }
  const data =
    format === 'bin'
      ? merged.data
      : Buffer.from(format === 'hex' ? encodeIntelHex(normalized) : encodeSRecord(normalized));
  return {
    data,
    defaultName: name + '.' + format,
    filterExtension: format,
    manifest: Buffer.from(
      JSON.stringify(
        {
          version: 1,
          boardId,
          format,
          loadAddress: merged.address,
          size: data.length,
          sha256: digest(data),
          fillByte: 255,
          segments: inputs.map((item, index) => ({
            ...item,
            size: segments[index].data.length,
            sha256: digest(segments[index].data),
          })),
        },
        null,
        2,
      ) + '\n',
    ),
  };
}

/** PT_LOAD flash bytes must match the cached binary before exposing a companion ELF. */
export function verifyElfAgainstImage(elf: Buffer, image: FirmwareSegment): void {
  if (
    elf.length < 52 ||
    elf.toString('hex', 0, 4) !== '7f454c46' ||
    elf[4] !== 1 ||
    elf[5] !== 1 ||
    elf.readUInt16LE(18) !== 40
  )
    throw new Error('firmware.elfUnavailable');
  const start = elf.readUInt32LE(28),
    stride = elf.readUInt16LE(42),
    count = elf.readUInt16LE(44);
  if (!count || stride < 32 || start + count * stride > elf.length)
    throw new Error('firmware.elfUnavailable');
  let end = image.address;
  for (let i = 0; i < count; i++) {
    const pos = start + i * stride;
    if (elf.readUInt32LE(pos) !== 1) continue;
    const offset = elf.readUInt32LE(pos + 4),
      physical = elf.readUInt32LE(pos + 12),
      size = elf.readUInt32LE(pos + 16);
    if (!size) continue;
    const relative = physical - image.address;
    if (
      relative < 0 ||
      relative + size > image.data.length ||
      offset + size > elf.length ||
      !elf.subarray(offset, offset + size).equals(image.data.subarray(relative, relative + size))
    )
      throw new Error('firmware.elfUnavailable');
    end = Math.max(end, physical + size);
  }
  if (end !== image.address + image.data.length) throw new Error('firmware.elfUnavailable');
}
