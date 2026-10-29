/** Keep platform recipe flags (including compile-only switches) when adding project options. */
export function arduinoExtraProperties(
  output: string,
  optimization: readonly string[],
  standard?: string,
): string[] {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([\w.-]+)=(.*)$/.exec(line);
    if (match) properties.set(match[1], match[2]);
  }
  if (!properties.has('compiler.cpp.flags') || !properties.has('recipe.cpp.o.pattern'))
    throw new Error('error.arduinoBuildProperties');
  const append = (key: string, flags: readonly string[]) =>
    `${key}=${[properties.get(key) ?? '', ...flags].filter(Boolean).join(' ')}`;
  return [
    append('compiler.c.extra_flags', [
      ...(standard ? [`-std=gnu${standard === 'c23' ? '2x' : standard.slice(1)}`] : []),
      ...optimization,
    ]),
    append('compiler.cpp.extra_flags', optimization),
    append('compiler.c.elf.extra_flags', ['-Wl,--gc-sections']),
  ];
}
