import type { AiSourceContext } from './model-service';

export function aiSourceLines(source: AiSourceContext) {
  const start = source.selection?.start ?? 0;
  const end = source.selection?.end ?? source.content.length;
  return {
    startLine: source.content.slice(0, start).split('\n').length,
    endLine: source.content.slice(0, Math.max(start, end - 1)).split('\n').length,
  };
}

/** Identifies the same snapshot that the composer displays and the host receives. */
export function aiSourceLabel(source: AiSourceContext) {
  const name = source.path.split(/[\\/]/).at(-1) ?? source.path;
  if (!source.selection) return name;
  const { startLine, endLine } = aiSourceLines(source);
  return `${name}:L${startLine}${endLine === startLine ? '' : `–L${endLine}`}`;
}
