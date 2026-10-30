import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface DiffRow {
  text: string;
  kind: 'meta' | 'hunk' | 'context' | 'added' | 'removed';
  before?: number;
  after?: number;
}
/** Unified-diff coordinates stay attached to their original/deleted and resulting/added sides. */
export function unifiedDiffRows(diff: string): DiffRow[] {
  let before = 0,
    after = 0,
    inHunk = false;
  return diff.split('\n').map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      inHunk = true;
      return { text, kind: 'hunk' };
    }
    if (!inHunk || text.startsWith('diff --git ') || text.startsWith('\\')) {
      if (text.startsWith('diff --git ')) inHunk = false;
      return { text, kind: 'meta' };
    }
    if (text.startsWith('+')) return { text, kind: 'added', after: after++ };
    if (text.startsWith('-')) return { text, kind: 'removed', before: before++ };
    if (text.startsWith(' ')) return { text, kind: 'context', before: before++, after: after++ };
    return { text, kind: 'meta' };
  });
}

/** A bounded viewport keeps large diffs from mounting thousands of highlighted rows. */
export function GitDiff({ value }: { value: string }) {
  const rows = useMemo(() => unifiedDiffRows(value), [value]);
  const container = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    element.scrollTop = 0;
    setTop(0);
    const measure = () => setHeight(element.clientHeight || 400);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);
  const start = Math.max(0, Math.floor(top / 20) - 12);
  const end = Math.min(rows.length, Math.ceil((top + height) / 20) + 12);
  const width = useMemo(
    () => rows.reduce((width, row) => Math.max(width, row.text.length * 7.2 + 100), 500),
    [rows],
  );
  return (
    <div
      className="git-diff-scroll"
      ref={container}
      tabIndex={0}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
    >
      <div className="git-diff-canvas" style={{ height: rows.length * 20, minWidth: width }}>
        <div className="git-diff-window" style={{ top: start * 20 }}>
          {rows.slice(start, end).map((row, index) => (
            <div className={`git-diff-line ${row.kind}`} key={start + index}>
              <span className="git-diff-number" aria-hidden="true">
                {row.before ?? ''}
              </span>
              <span className="git-diff-number" aria-hidden="true">
                {row.after ?? ''}
              </span>
              <code>{row.text || ' '}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
