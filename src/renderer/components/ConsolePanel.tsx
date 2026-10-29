import { ModernSelect } from './ModernSelect';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
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
  TriangleAlert,
  X,
} from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import type { SerialOptions } from '../../shared/contracts';
import { iconButton } from './IconButton';
import { TerminalPanel } from './TerminalPanel';

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
    warnings,
    config,
    setConfig,
    state,
    serialBaud,
    setSerialBaud,
    serialOptions,
    setSerialOptions,
    serialConnected,
    serialToggle,
    logEnd,
    perform,
    serialInput,
    setSerialInput,
  } = studio;
  const logRef = useRef<HTMLDivElement>(null);
  const baudRatesId = useId();
  const [encoding, setEncoding] = useState<'utf8' | 'hex'>('utf8');
  const [lineEnding, setLineEnding] = useState<'none' | 'lf' | 'cr' | 'crlf'>('lf');
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
    { id: 'warnings' as const, icon: TriangleAlert },
    { id: 'terminal' as const, icon: SquareTerminal },
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
    <section className="console-panel" hidden={!studio.consolePanelVisible} onKeyDown={selectLogText}>
      <div className="console-header">
        <div className="console-tabs">
          {tabs.map(({ id, icon: Icon }) => (
            <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)} key={id}>
              <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
              {t(`console.${id}`)}
              {id === 'problems' && <span className="count-badge">{errors.length}</span>}
              {id === 'warnings' && <span className="count-badge">{warnings.length}</span>}
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
          {tab !== 'terminal' &&
            iconButton(
              'action.clear',
              () =>
                setLogs((current) =>
                  current.filter((log) => (tab === 'serial' ? log.kind !== 'serial' : log.kind === 'serial')),
                ),
              <Trash2 size={13} strokeWidth={1.8} />,
            )}
          {iconButton(
            'view.hideConsolePanel',
            () => studio.setConsolePanelVisible(false),
            <X size={14} strokeWidth={1.9} aria-hidden="true" />,
          )}
        </div>
      </div>
      <TerminalPanel visible={tab === 'terminal'} />
      {tab === 'serial' && (
        <>
          <div className="serial-toolbar" style={{ flexWrap: 'wrap' }}>
            <Usb size={13} strokeWidth={1.8} aria-hidden="true" />
            <ModernSelect
              aria-label={t('console.serialDevice')}
              title={t('console.serialDevice')}
              value={
                state?.ports.some((port) => port.path === config?.port) ||
                (state?.connections?.serial.open && state.connections.serial.port === config?.port)
                  ? (config?.port ?? '')
                  : ''
              }
              disabled={serialConnected || !!busy || !config}
              onChange={(event) => {
                if (config) setConfig({ ...config, port: event.target.value });
              }}
            >
              <option value="">{t('device.selectPort')}</option>
              {state?.connections?.serial.open &&
                !state.ports.some((port) => port.path === state.connections!.serial.port) && (
                  <option value={state.connections.serial.port}>
                    {state.connections.serial.port} · {t('status.serialConnected')}
                  </option>
                )}
              {(state?.ports ?? []).map((port) => (
                <option key={port.path} value={port.path}>
                  {port.path}
                  {port.manufacturer ? ` — ${port.manufacturer}` : ''}
                </option>
              ))}
            </ModernSelect>
            <input
              type="number"
              min={110}
              max={4000000}
              step={1}
              list={baudRatesId}
              style={{ width: 114 }}
              aria-label={t('console.baud')}
              title={t('console.customBaud')}
              value={serialBaud}
              disabled={serialConnected}
              onChange={(e) => setSerialBaud(Number(e.target.value))}
            />
            <datalist id={baudRatesId}>
              {[
                110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800,
                921600, 1000000, 2000000, 3000000, 4000000,
              ].map((rate) => (
                <option key={rate} value={rate} />
              ))}
            </datalist>
            <button className="text-button serial-toggle" onClick={serialToggle} disabled={!!busy}>
              {serialConnected ? (
                <Unplug size={13} strokeWidth={1.8} />
              ) : (
                <PlugZap size={13} strokeWidth={1.8} />
              )}
              {t(serialConnected ? 'action.disconnect' : 'action.connect')}
            </button>
            <span className={`status-dot ${serialConnected ? '' : 'inactive'}`} />
            <ModernSelect
              aria-label={t('console.encoding')}
              value={encoding}
              onChange={(event) => setEncoding(event.target.value as 'utf8' | 'hex')}
            >
              <option value="utf8">UTF-8</option>
              <option value="hex">HEX</option>
            </ModernSelect>
            <ModernSelect
              aria-label={t('console.lineEnding')}
              value={lineEnding}
              disabled={encoding === 'hex'}
              onChange={(event) => setLineEnding(event.target.value as 'none' | 'lf' | 'cr' | 'crlf')}
            >
              <option value="none">{t('console.noLineEnding')}</option>
              <option value="lf">LF</option>
              <option value="cr">CR</option>
              <option value="crlf">CRLF</option>
            </ModernSelect>
          </div>
          <details
            className="serial-options"
            style={{ borderBottom: '1px solid var(--border)', padding: '6px 12px' }}
          >
            <summary>{t('console.serialOptions')}</summary>
            <div className="serial-toolbar" style={{ flexWrap: 'wrap', paddingLeft: 0 }}>
              <label>
                {t('console.dataBits')}{' '}
                <ModernSelect
                  value={serialOptions?.dataBits ?? 8}
                  disabled={serialConnected || !!busy}
                  onChange={(event) =>
                    setSerialOptions((current) => ({
                      ...current,
                      dataBits: Number(event.target.value) as SerialOptions['dataBits'],
                    }))
                  }
                >
                  {[5, 6, 7, 8].map((bits) => (
                    <option key={bits} value={bits}>
                      {bits}
                    </option>
                  ))}
                </ModernSelect>
              </label>
              <label>
                {t('console.parity')}{' '}
                <ModernSelect
                  value={serialOptions?.parity ?? 'none'}
                  disabled={serialConnected || !!busy}
                  onChange={(event) =>
                    setSerialOptions((current) => ({
                      ...current,
                      parity: event.target.value as SerialOptions['parity'],
                    }))
                  }
                >
                  {(['none', 'even', 'odd', 'mark', 'space'] as const).map((parity) => (
                    <option key={parity} value={parity}>
                      {t(`console.parity.${parity}`)}
                    </option>
                  ))}
                </ModernSelect>
              </label>
              <label>
                {t('console.stopBits')}{' '}
                <ModernSelect
                  value={serialOptions?.stopBits ?? 1}
                  disabled={serialConnected || !!busy}
                  onChange={(event) =>
                    setSerialOptions((current) => ({
                      ...current,
                      stopBits: Number(event.target.value) as SerialOptions['stopBits'],
                    }))
                  }
                >
                  {[1, 1.5, 2].map((bits) => (
                    <option key={bits} value={bits}>
                      {bits}
                    </option>
                  ))}
                </ModernSelect>
              </label>
              <label>
                {t('console.flowControl')}{' '}
                <ModernSelect
                  value={serialOptions?.flowControl ?? 'none'}
                  disabled={serialConnected || !!busy}
                  onChange={(event) =>
                    setSerialOptions((current) => ({
                      ...current,
                      flowControl: event.target.value as SerialOptions['flowControl'],
                    }))
                  }
                >
                  <option value="none">{t('console.flow.none')}</option>
                  <option value="rtscts">RTS/CTS</option>
                  <option value="xonxoff">XON/XOFF</option>
                </ModernSelect>
              </label>
            </div>
            <p className="subtle-note">{t('console.serialDeviceHint')}</p>
          </details>
        </>
      )}
      {tab !== 'terminal' && (
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
              : tab === 'warnings'
                ? warnings
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
              : tab === 'warnings'
                ? warnings.length
                : logs.some((log) => log.kind !== 'serial')) && (
            <div className="console-empty">
              <span className="console-empty-icon">{emptyIcon}</span>
              <span>
                {t(
                  tab === 'serial'
                    ? 'console.serialEmpty'
                    : tab === 'problems'
                      ? 'console.noProblems'
                      : tab === 'warnings'
                        ? 'console.noWarnings'
                        : 'console.empty',
                )}
              </span>
            </div>
          )}
          <div ref={logEnd} />
        </div>
      )}
      {tab === 'serial' && (
        <form
          className="serial-input"
          onSubmit={(event) => {
            event.preventDefault();
            void perform('action.send', async () => {
              const suffix =
                lineEnding === 'crlf' ? '\r\n' : lineEnding === 'lf' ? '\n' : lineEnding === 'cr' ? '\r' : '';
              await window.blode.serialWrite(
                encoding === 'hex' ? serialInput : serialInput + suffix,
                encoding,
              );
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
