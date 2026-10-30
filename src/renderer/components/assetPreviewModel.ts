export interface HexPreviewRow {
  offset: string;
  hex: string;
  text: string;
}

export function assetHexRows(value: string): HexPreviewRow[] {
  if (!/^(?:[\da-f]{2})*$/i.test(value)) return [];
  const bytes = value.match(/[\da-f]{2}/gi) ?? [];
  const rows: HexPreviewRow[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.slice(offset, offset + 16);
    rows.push({
      offset: offset.toString(16).padStart(8, '0'),
      hex: chunk.map((byte) => byte.toUpperCase()).join(' '),
      text: chunk
        .map((byte) => {
          const code = Number.parseInt(byte, 16);
          return code >= 32 && code <= 126 ? String.fromCharCode(code) : '·';
        })
        .join(''),
    });
  }
  return rows;
}

export function assetDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const parts = [Math.floor(total / 60), total % 60];
  if (parts[0] >= 60) parts.unshift(Math.floor(parts[0] / 60));
  if (parts.length === 3) parts[1] %= 60;
  return parts.map((value, index) => (index ? String(value).padStart(2, '0') : String(value))).join(':');
}

export function stopAssetMedia(media: HTMLMediaElement | null) {
  if (!media) return;
  media.pause();
  media.removeAttribute('src');
  media.load();
}
