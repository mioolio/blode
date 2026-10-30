import { useEffect, useRef, useState, type ReactNode } from 'react';
/** Fixed-height rows keep package review bounded even for large firmware workspaces. */
export function PackageList<T>({
  items,
  rowHeight = 36,
  height = 240,
  renderRow,
  label,
  className = '',
}: {
  items: readonly T[];
  rowHeight?: number;
  height?: number;
  renderRow: (item: T, index: number) => ReactNode;
  label: string;
  className?: string;
}) {
  const [offset, setOffset] = useState(0),
    frame = useRef(0),
    latest = useRef(0);
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const first = Math.max(0, Math.floor(offset / rowHeight) - 3),
    visible = Math.ceil(height / rowHeight) + 6;
  const start = Math.min(first, Math.max(0, items.length - visible));
  return (
    <div
      className={`package-virtual-list ${className}`}
      role="list"
      aria-label={label}
      style={{ height: Math.min(height, Math.max(rowHeight, items.length * rowHeight)) }}
      onScroll={(event) => {
        latest.current = event.currentTarget.scrollTop;
        if (!frame.current)
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            setOffset(latest.current);
          });
      }}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            transform: `translateY(${start * rowHeight}px)`,
          }}
        >
          {items.slice(start, start + visible).map((item, index) => (
            <div
              className="package-virtual-row"
              role="listitem"
              aria-posinset={start + index + 1}
              aria-setsize={items.length}
              key={start + index}
              style={{ height: rowHeight }}
            >
              {renderRow(item, start + index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
