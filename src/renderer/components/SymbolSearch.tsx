import { useEffect, useRef, useState } from 'react';
import type { LspWorkspaceSymbol } from '../../shared/lsp';
import { useI18n } from '../i18n';
import { searchWorkspaceSymbols } from '../workspace/symbolSearch';
import './symbol-search.css';

/** Workspace symbol picker opened by the editor's Go to Symbol action. */
export function SymbolSearch({ root, onClose }: { root: string; onClose: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<LspWorkspaceSymbol[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    const value = query.trim();
    if (!root || !value) {
      setItems([]);
      setActive(0);
      return;
    }
    const current = ++sequence.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void searchWorkspaceSymbols(root, value)
        .then((result) => {
          if (current !== sequence.current) return;
          setItems(result);
          setActive(0);
        })
        .finally(() => {
          if (current === sequence.current) setLoading(false);
        });
    }, 160);
    return () => clearTimeout(timer);
  }, [query, root]);

  const select = (item: LspWorkspaceSymbol | undefined) => {
    if (!item) return;
    window.dispatchEvent(
      new CustomEvent('blode:navigate-source', {
        detail: {
          root,
          target: {
            path: item.path,
            line: item.line,
            column: item.column,
            endLine: item.endLine,
            endColumn: item.endColumn,
          },
        },
      }),
    );
    onClose();
  };

  return (
    <div
      className="symbol-search-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="symbol-search" role="dialog" aria-modal="true" aria-label={t('symbol.search.title')}>
        <input
          ref={input}
          className="symbol-search-input"
          value={query}
          placeholder={t('symbol.search.placeholder')}
          aria-label={t('symbol.search.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((value) => Math.min(items.length - 1, value + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((value) => Math.max(0, value - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              select(items[active]);
            }
          }}
        />
        {!query.trim() ? (
          <p className="symbol-search-note">{t('symbol.search.hint')}</p>
        ) : loading && !items.length ? (
          <p className="symbol-search-note">{t('device.connectionChecking')}</p>
        ) : !items.length ? (
          <p className="symbol-search-note">{t('symbol.search.empty')}</p>
        ) : (
          <ul className="symbol-search-list" role="listbox" aria-label={t('symbol.search.title')}>
            {items.map((item, index) => (
              <li
                key={`${item.path}:${item.line}:${item.name}:${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'active' : ''}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(item)}
              >
                <span className="symbol-search-name">{item.name}</span>
                {item.containerName && <span className="symbol-search-container">{item.containerName}</span>}
                <span className="symbol-search-path">
                  {item.path}:{item.line}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
