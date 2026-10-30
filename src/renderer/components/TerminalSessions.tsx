import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Plus, Square, X } from 'lucide-react';
import type { TerminalSessionInfo, TerminalState } from '../../shared/terminal';
import { useI18n } from '../i18n';
import { TerminalSessionScreen } from './TerminalSessionScreen';
import './terminal-panel.css';

/** Session selection is local to this page; each PTY and its replay belong to the host. */
export function TerminalPanel({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [active, setActive] = useState('');
  const [requested, setRequested] = useState(visible);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const activeRef = useRef(active);
  activeRef.current = active;
  const initialized = useRef(false);
  const mounted = useRef(true);
  const readRevision = useRef(0);
  const selection = useRef(0);
  const tabs = useRef<HTMLDivElement>(null);
  const select = useCallback((id: string) => {
    selection.current++;
    activeRef.current = id;
    setActive(id);
    setError('');
    try {
      sessionStorage.setItem('blode.terminal.active', id);
    } catch {}
  }, []);
  const list = useCallback(async () => {
    const revision = ++readRevision.current;
    const next = await window.blode.terminalSessions();
    if (mounted.current && revision === readRevision.current) setSessions(next);
    return next;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readRevision.current++;
    };
  }, []);
  useEffect(() => {
    if (visible) setRequested(true);
    else window.blode.setTerminalFocus?.(false);
  }, [visible]);
  useEffect(() => () => window.blode.setTerminalFocus?.(false), []);
  useEffect(() => {
    if (!requested) return;
    let disposed = false;
    const initialize = async () => {
      let next = await list();
      if (disposed) return;
      if (!next.length && !initialized.current) {
        const opened = await window.blode.terminalOpen({ name: t('terminal.session') });
        next = await list();
        if (!disposed) select(opened.terminalId ?? 'default');
      } else if (!activeRef.current || !next.some((item) => item.terminalId === activeRef.current)) {
        let saved = '';
        try {
          saved = sessionStorage.getItem('blode.terminal.active') ?? '';
        } catch {}
        if (!disposed)
          select(next.find((item) => item.terminalId === saved)?.terminalId ?? next[0]?.terminalId ?? '');
      }
      initialized.current = true;
    };
    void initialize().catch((value) => {
      if (!disposed) setError(t(value instanceof Error ? value.message : String(value)));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void list()
          .then((next) => {
            if (!disposed && activeRef.current && !next.some((item) => item.terminalId === activeRef.current))
              select(next[0]?.terminalId ?? '');
          })
          .catch((value) => {
            if (!disposed) setError(t(String(value)));
          });
      }, 24);
    };
    const unsubscribe = window.blode.onEvent((event) => {
      if (event.kind === 'terminal') refresh();
    });
    window.addEventListener('blode:collaboration-reconnect', refresh);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('blode:collaboration-reconnect', refresh);
    };
  }, [requested]);
  const changed = useCallback((state: TerminalState) => {
    const id = state.terminalId ?? 'default';
    setSessions((current) =>
      current.map((item) =>
        item.terminalId !== id
          ? item
          : {
              ...item,
              active: !!state.active,
              running: state.running,
              sessionId: state.sessionId,
              cwd: state.cwd,
              shell: state.shell,
              exitCode: state.exitCode,
            },
      ),
    );
  }, []);
  useEffect(() => {
    const strip = tabs.current,
      chosen = strip?.querySelector('[aria-selected="true"]');
    if (!strip || !chosen || !visible) return;
    const bounds = strip.getBoundingClientRect(),
      current = chosen.getBoundingClientRect();
    const delta =
      current.left < bounds.left
        ? current.left - bounds.left
        : current.right > bounds.right
          ? current.right - bounds.right
          : 0;
    if (delta) strip.scrollBy({ left: delta, behavior: 'smooth' });
  }, [active, sessions.length, visible]);
  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError('');
    const intent = ++selection.current;
    try {
      const opened = await window.blode.terminalOpen({
        create: true,
      });
      await list();
      if (mounted.current && intent === selection.current) select(opened.terminalId!);
    } catch (value) {
      if (mounted.current) setError(t(value instanceof Error ? value.message : String(value)));
    } finally {
      if (mounted.current) setCreating(false);
    }
  };
  const close = async (session: TerminalSessionInfo) => {
    if (closing.has(session.terminalId)) return;
    setClosing((current) => new Set([...current, session.terminalId]));
    try {
      await window.blode.terminalClose({ terminalId: session.terminalId, sessionId: session.sessionId });
      const next = await list();
      if (mounted.current && activeRef.current === session.terminalId) {
        const index = sessions.findIndex((item) => item.terminalId === session.terminalId);
        select(next[index]?.terminalId ?? next[index - 1]?.terminalId ?? next[0]?.terminalId ?? '');
      }
    } catch (value) {
      if (mounted.current) setError(t(value instanceof Error ? value.message : String(value)));
    } finally {
      if (mounted.current)
        setClosing((current) => new Set([...current].filter((id) => id !== session.terminalId)));
    }
  };
  const current = sessions.find((item) => item.terminalId === active);
  return (
    <section
      className="host-terminal"
      hidden={!visible}
      aria-label={t('console.terminal')}
      onFocusCapture={() => window.blode.setTerminalFocus?.(true)}
      onBlurCapture={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
          window.blode.setTerminalFocus?.(false);
      }}
    >
      <div className="terminal-toolbar">
        <div className="terminal-tabs" ref={tabs} role="tablist" aria-label={t('terminal.select')}>
          {sessions.map((session, index) => (
            <div
              className={`terminal-tab${active === session.terminalId ? ' active' : ''}`}
              key={session.terminalId}
            >
              <button
                role="tab"
                aria-selected={active === session.terminalId}
                tabIndex={active === session.terminalId ? 0 : -1}
                title={[session.name, session.shell, session.cwd].filter(Boolean).join('\n')}
                onClick={() => select(session.terminalId)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? sessions.length - 1
                        : (index + (event.key === 'ArrowLeft' ? -1 : 1) + sessions.length) % sessions.length;
                  select(sessions[next].terminalId);
                  requestAnimationFrame(() =>
                    tabs.current
                      ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
                      ?.focus({ preventScroll: true }),
                  );
                }}
              >
                <span>{session.name}</span>
                {session.running && <i className="terminal-running" aria-label={t('terminal.running')} />}
              </button>
              <button
                className="terminal-tab-close"
                aria-label={`${t('terminal.closeSession')} ${session.name}`}
                disabled={closing.has(session.terminalId)}
                onClick={() => void close(session)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-actions">
          <button
            className="icon-button"
            disabled={!current?.running || closing.has(active)}
            title={t('terminal.interrupt')}
            aria-label={t('terminal.interrupt')}
            onClick={() => {
              if (current)
                void window.blode
                  .terminalStop({ terminalId: current.terminalId, sessionId: current.sessionId })
                  .catch((value) => setError(t(String(value))));
            }}
          >
            <Square size={12} />
          </button>
          <button
            className="icon-button"
            disabled={creating}
            title={t('terminal.newSession')}
            aria-label={t('terminal.newSession')}
            onClick={() => void create()}
          >
            {creating ? <LoaderCircle className="spin" size={13} /> : <Plus size={14} />}
          </button>
        </div>
      </div>
      {requested && active ? (
        <TerminalSessionScreen key={active} terminalId={active} visible={visible} onState={changed} />
      ) : (
        <div className="terminal-empty">{t('terminal.noSessions')}</div>
      )}
      {error && (
        <p className="terminal-error error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
