import * as z from 'zod';
import { canonicalBoardId } from '../shared/runtime-identity';

const partitionSchema = z
  .object({
    id: z.string().min(1).max(16),
    name: z.string().min(1).max(16),
    type: z.enum(['app', 'data', 'system']),
    offset: z.number().int().nonnegative(),
    size: z.number().int().positive(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(80),
    boardId: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .transform(canonicalBoardId),
    port: z.string().max(128),
    baudRate: z.number().int().min(1_200).max(3_000_000),
    flashSize: z.number().int().nonnegative(),
    flashSizeOverride: z.boolean().optional(),
    runtime: z
      .object({
        deviceId: z.string().max(1024).optional(),
        values: z
          .record(
            z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/),
            z.union([z.string().max(4096), z.number().finite(), z.boolean()]),
          )
          .optional(),
        forceCompiler: z.boolean().optional(),
        compilerRuntime: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/)
          .optional(),
        disabledCapabilities: z
          .array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/))
          .max(64)
          .optional(),
      })
      .strict()
      .optional(),
    partitions: z.array(partitionSchema).max(32),
    debugger: z
      .object({
        transport: z.enum(['usb-jtag', 'uart-gdb']).optional(),
        port: z.string().max(128).optional(),
        baudRate: z.number().int().min(1200).max(3000000).optional(),
        stubMode: z.enum(['runtime', 'panic']).optional(),
        gdbPath: z.string().max(4096).optional(),
        serverPath: z.string().max(4096).optional(),
        scriptsPath: z.string().max(4096).optional(),
        serialNumber: z
          .string()
          .regex(/^[A-Za-z0-9:_-]{0,128}$/)
          .optional(),
        frequencyKhz: z.number().int().min(5).max(40000).optional(),
      })
      .strict()
      .optional(),
    programmer: z
      .object({
        transport: z.enum(['auto', 'serial', 'stlink', 'usb', 'physical', 'custom']),
        serialNumber: z.string().regex(/^[a-fA-F0-9]{0,64}$/),
        frequencyKhz: z.number().int().min(5).max(4000),
        targetChipId: z
          .string()
          .regex(/^0x[a-fA-F0-9]{3,8}$/)
          .optional(),
      })
      .strict()
      .optional(),
    toolchain: z
      .object({
        mode: z.enum(['managed', 'custom']),
        arduinoCli: z.string().max(1024),
        python: z.string().max(1024),
        additionalUrls: z
          .array(
            z
              .string()
              .url()
              .refine((value) => /^https:\/\//.test(value), 'HTTPS required'),
          )
          .max(16),
        fqbn: z.string().regex(/^(?:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_=,.-]+)?)?$/),
        stlinkDirectory: z.string().max(1024).optional(),
        armCompilerDirectory: z.string().max(1024).optional(),
        packageDirectory: z.string().max(4096).optional(),
      })
      .strict(),
  })
  .strict();

export const debuggerSettingsRequestSchema = z
  .object({
    expectedProjectRoot: z.string().max(4096),
    expectedBoardId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    debugger: configSchema.shape.debugger.unwrap(),
  })
  .strict();
