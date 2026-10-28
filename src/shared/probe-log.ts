export const MAX_PROBE_LOG_BYTES = 2_000_000;
export type ProbeLogExportResult = 'saved' | 'cancelled' | 'download-started';

/** A caller supplies text only; filenames and save locations are chosen by the host. */
export function validateProbeLog(content: unknown): asserts content is string {
  if (typeof content !== 'string' || new TextEncoder().encode(content).byteLength > MAX_PROBE_LOG_BYTES)
    throw new Error('error.logExportTooLarge');
}

export function probeLogFilename(now = new Date()): string {
  return `blode-probe-${now.toISOString().replace(/[:.]/g, '-')}.log`;
}
