import { useRef, type KeyboardEvent } from 'react';
import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  PlugZap,
  Send,
  SquareTerminal,
  Trash2,
  Unplug,
  Usb,
} from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { iconButton } from './IconButton';

/** ConsolePanel renders one workspace surface; application actions stay in useStudio. */
export function ConsolePanel({ studio }: { studio: Studio }) {
  const {
    t,
    locale,
    tab,
    setTab,
    logs,
    setLogs,
    busy,
    errors,
    serialBaud,
    setSerialBaud,
    serialConnected,
    serialToggle,
    logEnd,
    perform,
    serialInput,
    setSerialInput,
  } = studio;
  const logRef = useRef<HTMLDivElement>(null);
  // Ctrl+A inside the console selects the visible log text, never the whole window.
  const selectLogText = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
    const log = logRef.current;
    if (!log) return;
    event.preventDefault();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(log);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const tabs = [
    { id: 'output' as const, icon: SquareTerminal },
    { id: 'serial' as const, icon: Usb },
    { id: 'problems' as const, icon: CircleAlert },
  ];
  const emptyIcon =
    tab === 'serial' ? (
      <Usb size={26} strokeWidth={1.3} />
    ) : tab === 'problems' ? (
      <CircleCheck size={26} strokeWidth={1.3} />
    ) : (
      <SquareTerminal size={26} strokeWidth={1.3} />
    );
  return (
    <section className="console-panel" onKeyDown={selectLogText}>
      <div className="console-header">
        <div className="console-tabs">
          {tabs.map(({ id, icon: Icon }) => (
            <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)} key={id}>
              <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
              {t(`console.${id}`)}
              {id === 'problems' && <span className="count-badge">{errors.length}</span>}
            </button>
          ))}
        </div>
        <div className="console-tools">
          {busy && (
            <span className="busy-label">
              <LoaderCircle className="spin" size={12} aria-hidden="true" />
              {t(busy)}
            </span>
          )}
          {iconButton(
            'action.clear',
            () =>
              setLogs((current) =>
                current.filter((log) => (tab === 'serial' ? log.kind !== 'serial' : log.kind === 'serial')),
              ),
            <Trash2 size={13} strokeWidth={1.8} />,
          )}
        </div>
      </div>
      {tab === 'serial' && (
        <div className="serial-toolbar">
          <Usb size={13} strokeWidth={1.8} aria-hidden="true" />
          <select
            aria-label={t('console.baud')}
            value={serialBaud}
            disabled={serialConnected}
            onChange={(e) => setSerialBaud(Number(e.target.value))}
          >
            {[9600, 57600, 115200, 230400, 460800, 921600].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <button className="text-button serial-toggle" onClick={serialToggle} disabled={!!busy}>
            {serialConnected ? (
              <Unplug size={13} strokeWidth={1.8} />
            ) : (
              <PlugZap size={13} strokeWidth={1.8} />
            )}
            {t(serialConnected ? 'action.disconnect' : 'action.connect')}
          </button>
          <span className={`status-dot ${serialConnected ? '' : 'inactive'}`} />
        </div>
      )}
      <div
        className="log-scroll"
        ref={logRef}
        tabIndex={0}
        role="log"
        aria-label={t(`console.${tab}`)}
        onMouseDown={() => logRef.current?.focus()}
      >
        {(tab === 'serial'
          ? logs.filter((log) => log.kind === 'serial')
          : tab === 'problems'
            ? errors
            : logs.filter((log) => log.kind !== 'serial')
        ).map((log, index) => (
          <div className={`log-line ${log.level}`} key={`${log.time}-${index}`}>
            <time>{new Date(log.time).toLocaleTimeString(locale, { hour12: false })}</time>
            <span className="log-marker">
              {log.level === 'error' ? '×' : log.level === 'success' ? '✓' : '›'}
            </span>
            <pre>{t(log.message)}</pre>
          </div>
        ))}
        {!(tab === 'serial'
          ? logs.some((log) => log.kind === 'serial')
          : tab === 'problems'
            ? errors.length
            : logs.some((log) => log.kind !== 'serial')) && (
          <div className="console-empty">
            <span className="console-empty-icon">{emptyIcon}</span>
            <span>
              {t(
                tab === 'serial'
                  ? 'console.serialEmpty'
                  : tab === 'problems'
                    ? 'console.noProblems'
                    : 'console.empty',
              )}
            </span>
          </div>
        )}
        <div ref={logEnd} />
      </div>
      {tab === 'serial' && (
        <form
          className="serial-input"
          onSubmit={(event) => {
            event.preventDefault();
            void perform('action.send', async () => {
              await window.blode.serialWrite(serialInput + '\n');
              setSerialInput('');
            });
          }}
        >
          <Send size={13} strokeWidth={1.8} className="serial-input-icon" aria-hidden="true" />
          <input
            placeholder={t('console.serialInput')}
            value={serialInput}
            onChange={(e) => setSerialInput(e.target.value)}
            disabled={!serialConnected}
          />
          <button type="submit" disabled={!serialConnected || !!busy}>
            {t('action.send')}
            <Send size={12} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </form>
      )}
    </section>
  );
}
