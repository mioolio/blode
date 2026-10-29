import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Play, Square } from 'lucide-react';
import type { TerminalState } from '../../shared/terminal';
import { useI18n } from '../i18n';
import './terminal-panel.css';

/** Commands run on the workspace host; output survives changing console tabs. */
export function TerminalPanel({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<TerminalState>({
    running: false,
    command: '',
    cwd: '',
    lines: [],
    exitCode: null,
  });
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(0);
  const output = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const revision = useRef(0);
  const pendingRef = useRef(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = async () => {
      const current = ++revision.current;
      try {
        const next = await window.blode.terminalState();
        if (active && current === revision.current) {
          setState(next);
          setError('');
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : String(error));
      }
    };
    void sync();
    const unsubscribe = window.blode.onEvent((event) => {
      if (event.kind !== 'terminal' || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void sync();
      }, 80);
    });
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!visible || !follow.current) return;
    output.current?.scrollTo({ top: output.current.scrollHeight, behavior: 'smooth' });
  }, [state.lines, visible]);
  const run = async () => {
    if (pendingRef.current || state.running || !command.trim()) return;
    pendingRef.current = true;
    setPending(true);
    setError('');
    const text = command.trim();
    try {
      revision.current++;
      const next = await window.blode.terminalRun({ command: text });
      setState(next);
      setCommand('');
      history.current = [...history.current.filter((line) => line !== text), text].slice(-40);
      historyIndex.current = history.current.length;
      follow.current = true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const stop = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await window.blode.terminalStop();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const selectOutput = (event: KeyboardEvent<HTMLPreElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
    event.preventDefault();
    event.stopPropagation();
    const selection = window.getSelection();
    if (!selection || !output.current) return;
    const range = document.createRange();
    range.selectNodeContents(output.current);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  return (
    <section className="host-terminal" hidden={!visible}>
      <div className="terminal-location">
        <span title={state.cwd}>{state.cwd || t('terminal.targetHost')}</span>
        <span role="status">
          {state.running
            ? t('terminal.running')
            : state.exitCode !== null
              ? `${t('terminal.exitCode')} ${state.exitCode}`
              : t('terminal.ready')}
        </span>
      </div>
      <pre
        className="terminal-output"
        ref={output}
        tabIndex={0}
        role="log"
        aria-label={t('console.terminal')}
        onKeyDown={selectOutput}
        onScroll={() => {
          const view = output.current;
          if (view) follow.current = view.scrollHeight - view.scrollTop - view.clientHeight < 70;
        }}
      >
        {state.lines.length ? state.lines.map((line) => t(line)).join('\n') : t('terminal.empty')}
      </pre>
      {error && (
        <p className="terminal-error error-text" role="alert">
          {t(error)}
        </p>
      )}
      <form
        className="terminal-command"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <span aria-hidden="true">›</span>
        <input
          aria-label={t('terminal.command')}
          placeholder={t('terminal.commandHint')}
          value={command}
          disabled={pending || state.running}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !history.current.length) return;
            event.preventDefault();
            historyIndex.current = Math.max(
              0,
              Math.min(history.current.length, historyIndex.current + (event.key === 'ArrowUp' ? -1 : 1)),
            );
            setCommand(history.current[historyIndex.current] ?? '');
          }}
        />
        {state.running ? (
          <button type="button" disabled={pending} onClick={() => void stop()}>
            <Square size={12} />
            {t('terminal.stop')}
          </button>
        ) : (
          <button type="submit" disabled={pending || !command.trim()}>
            <Play size={12} />
            {t('terminal.run')}
          </button>
        )}
      </form>
    </section>
  );
}
