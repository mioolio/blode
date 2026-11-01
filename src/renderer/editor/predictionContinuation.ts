/** Reuse ghost text only for exact typing through it at the original insertion point. */
export function advancePrediction(before: string, offset: number, suggestion: string, after: string) {
  const added = after.length - before.length;
  const inserted = after.slice(offset, offset + added).replace(/\r\n/g, '\n');
  if (
    added < 1 ||
    inserted.length > suggestion.length ||
    after.slice(0, offset) !== before.slice(0, offset) ||
    inserted !== suggestion.slice(0, inserted.length) ||
    after.slice(offset + added) !== before.slice(offset)
  )
    return null;
  const nextOffset = offset + added;
  const lines = after.slice(0, nextOffset).split('\n');
  return {
    offset: nextOffset,
    text: suggestion.slice(inserted.length),
    line: lines.length,
    column: lines.at(-1)!.length + 1,
  };
}
