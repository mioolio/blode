const legacyRuntimeIds: Readonly<Record<string, string>> = {
  'esp32-s3': 'Esp32_S3_CAM',
  stm32: 'STM32F103C8T6',
};

/** Canonical names are shared by host parsing and descriptor editors. */
export function canonicalBoardId(id: string): string {
  return Object.hasOwn(legacyRuntimeIds, id) ? legacyRuntimeIds[id] : id;
}

/** Move legacy platform keys without mutating the descriptor or dropping language overrides. */
export function migrateLegacyBuildPlatforms(value: unknown): unknown {
  const record = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === 'object' && !Array.isArray(input);
  if (!record(value) || !record(value.settings) || !record(value.settings.platforms)) return value;
  const platforms = { ...value.settings.platforms };
  for (const legacy of Object.keys(legacyRuntimeIds)) {
    if (!Object.hasOwn(platforms, legacy)) continue;
    const canonical = canonicalBoardId(legacy);
    const older = platforms[legacy];
    const newer = platforms[canonical];
    platforms[canonical] = record(older) && record(newer) ? { ...older, ...newer } : (newer ?? older);
    delete platforms[legacy];
  }
  return { ...value, settings: { ...value.settings, platforms } };
}
