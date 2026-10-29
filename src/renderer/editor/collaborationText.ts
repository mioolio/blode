import type { CollaborationChange } from '../../shared/collaboration';

const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Minimal changed spans keep remote edits away from unchanged reader selections. */
export function textChanges(before: string, after: string): CollaborationChange[] {
  if (before === after) return [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length,
    nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const old = before.slice(start, end),
    next = after.slice(start, nextEnd);
  const multiline = old.includes('\n') && next.includes('\n');
  const a = multiline ? lines(old) : old.split(''),
    b = multiline ? lines(next) : next.split('');
  if (a.length * b.length > 250_000) return [{ start, end, text: next }];
  const matrix = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  const changes: CollaborationChange[] = [];
  let i = 0,
    j = 0,
    offset = start,
    pending: CollaborationChange | undefined;
  const flush = () => {
    if (pending) changes.push(pending);
    pending = undefined;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      offset += a[i++].length;
      j++;
    } else {
      pending ??= { start: offset, end: offset, text: '' };
      if (j < b.length && (i === a.length || matrix[i][j + 1] >= matrix[i + 1][j])) pending.text += b[j++];
      else {
        offset += a[i++].length;
        pending.end = offset;
      }
    }
  }
  flush();
  return changes;
}

export function applyTextChanges(value: string, changes: readonly CollaborationChange[]): string {
  for (const change of [...changes].sort((a, b) => b.start - a.start))
    value = value.slice(0, change.start) + change.text + value.slice(change.end);
  return value;
}

/** Resolve a reader anchor onto its original text, including insertions exactly at its start. */
export function mapTextOffset(offset: number, changes: readonly CollaborationChange[]): number {
  let delta = 0;
  for (const change of changes) {
    if (offset < change.start) break;
    if (offset >= change.end) delta += change.text.length - (change.end - change.start);
    else return change.start + delta + Math.min(offset - change.start, change.text.length);
  }
  return offset + delta;
}

/** Three-way merge. Overlapping replacements require a user's decision, never last-writer-wins. */
export function mergeText(base: string, local: string, remote: string): string | null {
  if (local === base || local === remote) return remote;
  if (remote === base) return local;
  const own = textChanges(base, local).map((change) => ({ ...change }));
  const incoming = textChanges(base, remote);
  for (const a of own)
    for (const b of incoming) {
      const aInsert = a.start === a.end,
        bInsert = b.start === b.end;
      if (aInsert && bInsert && a.start === b.start) continue;
      if (
        aInsert
          ? a.start > b.start && a.start < b.end
          : bInsert
            ? b.start > a.start && b.start < a.end
            : a.start < b.end && b.start < a.end
      )
        return null;
    }
  return applyTextChanges(
    remote,
    own.map((change) => ({
      start: mapTextOffset(change.start, incoming),
      end:
        change.start === change.end
          ? mapTextOffset(change.start, incoming)
          : incoming.reduce(
              (position, remote) =>
                remote.end <= change.end && remote.start < change.end
                  ? position + remote.text.length - (remote.end - remote.start)
                  : position,
              change.end,
            ),
      text: change.text,
    })),
  );
}
