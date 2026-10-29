import { useEffect, useRef, useState } from 'react';
import { Plus, Square, Trash2 } from 'lucide-react';
import type { Terminal as Xterm } from '@xterm/xterm';
import type { TerminalState } from '../../shared/terminal';
import { useI18n } from '../i18n';
import { copyTerminalSelection } from '../workspace/terminalClipboard';
import './terminal-panel.css';

const initial: TerminalState = {
  running: false,
  active: false,
  command: '',
  cwd: '',
  lines: [],
  exitCode: null,
};

/** The terminal renderer is disposable; its interactive process belongs to the host. */
export function TerminalPanel({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<TerminalState>(initial);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const snapshot = useRef<TerminalState>(initial);
  const cursor = useRef({ sessionId: '', sequence: 0 });
  const display = useRef(visible);
  display.current = visible;
  const update = useRef<(value: TerminalState) => void>(() => {});
  const fit = useRef<() => void>(() => {});
  const writeQueue = useRef(Promise.resolve());
  const [loaded, setLoaded] = useState(false);
  const [requested, setRequested] = useState(visible);
  useEffect(() => {
    if (visible) setRequested(true);
  }, [visible]);
  useEffect(() => {
    if (!visible) window.blode.setTerminalFocus?.(false);
  }, [visible]);
  useEffect(() => () => window.blode.setTerminalFocus?.(false), []);

  useEffect(() => {
    if (!requested) return;
    let disposed = false;
    let terminal: Xterm | undefined;
    let resize: ResizeObserver | undefined;
    let theme: MutationObserver | undefined;
    void Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !element.current) return;
        const colors = () => {
          const css = getComputedStyle(document.documentElement);
          return {
            background: css.getPropertyValue('--surface-1').trim() || '#12161e',
            foreground: css.getPropertyValue('--text').trim() || '#d8dee9',
            cursor: css.getPropertyValue('--text').trim() || '#d8dee9',
            selectionBackground: '#5680a64d',
          };
        };
        terminal = new Terminal({
          fontFamily: '"Cascadia Code", Consolas, "Microsoft YaHei", monospace',
          fontSize: 13,
          lineHeight: 1.2,
          cursorBlink: true,
          scrollback: 2000,
          theme: colors(),
          allowProposedApi: false,
        });
        const addon = new FitAddon();
        terminal.loadAddon(addon);
        terminal.open(element.current);
        term.current = terminal;
        const native = terminal;
        native.attachCustomKeyEventHandler((event) => {
          event.stopPropagation();
          if (
            event.type === 'keydown' &&
            event.ctrlKey &&
            event.key.toLowerCase() === 'c' &&
            native.hasSelection()
          ) {
            event.preventDefault();
            void copyTerminalSelection(native.getSelection());
            return false;
          }
          if (event.ctrlKey && ['r', 'w', 's'].includes(event.key.toLowerCase())) event.preventDefault();
          return true;
        });
        native.onData((data) => {
          if (!snapshot.current.active) return;
          const sessionId = snapshot.current.sessionId;
          writeQueue.current = writeQueue.current
            .then(() => window.blode.terminalWrite({ data, sessionId }))
            .catch((value) => {
              if (!disposed) setError(String(value));
            });
        });
        let lastSize = '';
        fit.current = () => {
          if (!display.current || !element.current?.clientWidth || !element.current.clientHeight) return;
          addon.fit();
          const cols = Math.min(500, Math.max(20, native.cols)),
            rows = Math.min(300, Math.max(5, native.rows));
          const size = `${snapshot.current.sessionId}:${cols}:${rows}`;
          if (snapshot.current.active && lastSize !== size) {
            lastSize = size;
            void window.blode
              .terminalResize({ cols, rows, sessionId: snapshot.current.sessionId })
              .catch((value) => {
                if (!disposed) setError(String(value));
              });
          }
        };
        resize = new ResizeObserver(() => requestAnimationFrame(() => fit.current()));
        resize.observe(element.current);
        theme = new MutationObserver(() => {
          native.options.theme = colors();
        });
        theme.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme'],
        });
        update.current = (next) => {
          if (disposed) return;
          if (
            next.sessionId === snapshot.current.sessionId &&
            (next.sequence ?? 0) < (snapshot.current.sequence ?? 0)
          )
            return;
          if (next.shell && next.shell !== snapshot.current.shell)
            native.options.windowsPty = /^[a-z]:[\\/]/i.test(next.shell) ? { backend: 'conpty' } : {};
          const previous = cursor.current;
          const first = next.chunks?.[0]?.sequence;
          const reset =
            next.sessionId !== previous.sessionId ||
            (next.reset && first !== undefined && first > previous.sequence + 1);
          if (reset) {
            native.write('\x1bc');
            cursor.current = { sessionId: next.sessionId ?? '', sequence: 0 };
          }
          for (const chunk of next.chunks ?? [])
            if (chunk.sequence > cursor.current.sequence) {
              native.write(chunk.data);
              cursor.current.sequence = chunk.sequence;
            }
          snapshot.current = next;
          setState(next);
          setError('');
          fit.current();
        };
        setLoaded(true);
      })
      .catch((value) => {
        if (!disposed) setError(String(value));
      });
    return () => {
      disposed = true;
      resize?.disconnect();
      theme?.disconnect();
      terminal?.dispose();
      term.current = null;
    };
  }, [requested]);

  useEffect(() => {
    if (!loaded) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let syncing = false,
      again = false;
    const sync = async () => {
      if (syncing) {
        again = true;
        return;
      }
      syncing = true;
      try {
        do {
          again = false;
          const current = cursor.current;
          const next = await window.blode.terminalState({
            sessionId: current.sessionId || undefined,
            after: current.sequence,
          });
          if (!disposed) update.current(next);
        } while (again && !disposed);
      } catch (value) {
        if (!disposed) setError(String(value));
      } finally {
        syncing = false;
      }
    };
    void window.blode
      .terminalOpen()
      .then((next) => {
        if (!disposed) update.current(next);
      })
      .catch((value) => {
        if (!disposed) setError(String(value));
      });
    const unsubscribe = window.blode.onEvent((event) => {
      if (['status.projectOpened', 'status.projectClosed'].includes(event.message) && display.current) {
        void window.blode
          .terminalOpen()
          .then((next) => {
            if (!disposed) update.current(next);
          })
          .catch((value) => {
            if (!disposed) setError(String(value));
          });
        return;
      }
      if (event.kind !== 'terminal' || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void sync();
      }, 16);
    });
    const reconnect = () => void sync();
    window.addEventListener('blode:collaboration-reconnect', reconnect);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('blode:collaboration-reconnect', reconnect);
    };
  }, [loaded]);
  useEffect(() => {
    if (visible && loaded)
      requestAnimationFrame(() => {
        fit.current();
        term.current?.focus();
        void window.blode
          .terminalOpen()
          .then((next) => update.current(next))
          .catch((value) => setError(String(value)));
      });
  }, [visible, loaded]);
  const action = async (kind: 'open' | 'close' | 'stop') => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      if (kind === 'open') update.current(await window.blode.terminalOpen());
      else if (kind === 'close') {
        await window.blode.terminalClose();
        update.current(
          await window.blode.terminalState({
            sessionId: cursor.current.sessionId,
            after: cursor.current.sequence,
          }),
        );
      } else await window.blode.terminalStop();
    } catch (value) {
      setError(String(value));
    } finally {
      setPending(false);
    }
  };
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
      <div className="terminal-location">
        <span title={state.shell}>
          {state.shell
            ?.split(/[\\/]/)
            .at(-1)
            ?.replace(/\.exe$/i, '') ?? t('console.terminal')}
        </span>
        <span className="terminal-cwd" title={state.cwd}>
          {state.cwd}
        </span>
        <div className="terminal-actions">
          {state.active ? (
            <>
              <button
                className="icon-button"
                disabled={pending || !state.running}
                title={t('terminal.interrupt')}
                aria-label={t('terminal.interrupt')}
                onClick={() => void action('stop')}
              >
                <Square size={12} />
              </button>
              <button
                className="icon-button"
                disabled={pending}
                title={t('terminal.closeSession')}
                aria-label={t('terminal.closeSession')}
                onClick={() => void action('close')}
              >
                <Trash2 size={13} />
              </button>
            </>
          ) : (
            <button
              className="icon-button"
              disabled={pending || !loaded}
              title={t('terminal.newSession')}
              aria-label={t('terminal.newSession')}
              onClick={() => void action('open')}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="terminal-screen" ref={element} />
      {error && (
        <p className="terminal-error error-text" role="alert">
          {t(error)}
        </p>
      )}
    </section>
  );
}
