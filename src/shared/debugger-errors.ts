/** Translate only recognizable USB-JTAG connection failures; retain every other diagnostic. */
export function debuggerErrorSummary(raw: string, transport?: 'swd' | 'usb-jtag'): string {
  const message = raw
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^Error:\s*/, '')
    .trim();
  const key = message.match(/^(error\.debuggerUsbJtag[A-Za-z]+)(?::|\s|$)/)?.[1];
  if (key) return key;
  if (
    transport === 'usb-jtag' &&
    /(?:could not (?:find or )?open device|could not find (?:or open )?(?:USB )?device|LIBUSB_ERROR_(?:ACCESS|NO_DEVICE|BUSY))/i.test(
      message,
    )
  )
    return 'error.debuggerUsbJtagUnavailable';
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningful =
    lines.find((line) =>
      /^(?:Error\s*:|error\.|fatal\s*:)|\b(?:failed|failure|permission denied|not found)\b/i.test(line),
    ) ??
    lines[0] ??
    '';
  return meaningful.length > 240 ? meaningful.slice(0, 237) + '…' : meaningful;
}

/** RPC failures may arrive before the next server snapshot. Keep their full text in the log. */
export function debuggerDiagnosticLog(serverLog: readonly string[], failures: readonly string[]): string[] {
  const result = [...serverLog];
  let existing = result.join('\n');
  for (const raw of failures) {
    const message = raw
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
      .replace(/^Error:\s*/, '')
      .trim();
    if (!message) continue;
    const lines = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.every((line) => existing.includes(line))) continue;
    result.push(message);
    existing += '\n' + message;
  }
  return result;
}
