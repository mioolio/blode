import { useEffect, useRef, useState } from 'react';
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
export function TerminalSessionScreen({
  visible,
  terminalId,
  onState,
}: {
  visible: boolean;
  terminalId: string;
  onState(state: TerminalState): void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState('');
  const changed = useRef(onState);
  changed.current = onState;
  const element = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const snapshot = useRef<TerminalState>(initial);
  const cursor = useRef({ sessionId: '', sequence: 0 });
  const retired = useRef(new Set<string>());
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
            .then(() => window.blode.terminalWrite({ data, sessionId, terminalId }))
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
              .terminalResize({ cols, rows, sessionId: snapshot.current.sessionId, terminalId })
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
          if (next.terminalId && next.terminalId !== terminalId) return;
          if (next.sessionId && retired.current.has(next.sessionId)) return;
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
            if (previous.sessionId && previous.sessionId !== next.sessionId)
              retired.current.add(previous.sessionId);
            native.write('\x1bc');
            cursor.current = { sessionId: next.sessionId ?? '', sequence: 0 };
          }
          for (const chunk of next.chunks ?? [])
            if (chunk.sequence > cursor.current.sequence) {
              native.write(chunk.data);
              cursor.current.sequence = chunk.sequence;
            }
          snapshot.current = next;
          changed.current(next);
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
            terminalId,
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
      .terminalState({ terminalId })
      .then((next) => {
        if (!disposed) update.current(next);
      })
      .catch((value) => {
        if (!disposed) setError(String(value));
      });
    const unsubscribe = window.blode.onEvent((event) => {
      if (['status.projectOpened', 'status.projectClosed'].includes(event.message) && display.current) {
        void window.blode
          .terminalState({ terminalId })
          .then((next) => {
            if (!disposed) update.current(next);
          })
          .catch((value) => {
            if (!disposed) setError(String(value));
          });
        return;
      }
      if (
        event.kind !== 'terminal' ||
        (event.terminalId && event.terminalId !== terminalId) ||
        !display.current ||
        timer
      )
        return;
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
          .terminalState({ terminalId })
          .then((next) => update.current(next))
          .catch((value) => setError(String(value)));
      });
  }, [visible, loaded]);
  return (
    <div className="terminal-session-body">
      <div className="terminal-screen" ref={element} />
      {error && (
        <p className="terminal-error error-text" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
