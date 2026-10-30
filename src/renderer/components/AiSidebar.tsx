import { Fragment, useEffect, useRef, useState } from 'react';
import { Check, Copy, FileCode2, LoaderCircle, Plus, Send, ShieldAlert, Square, X } from 'lucide-react';
import type { AiChatSession, AiEditScope } from '../../shared/model-service';
import type { Studio } from '../workspace/useStudio';
import { currentAiContext, type AiEditorContext } from '../workspace/aiContext';
import { flushCollaboration } from '../workspace/collaborationFlush';
import type { ApplyLocalAiEdit } from '../editor/aiActions';
import { ModernSelect } from './ModernSelect';
import './ai-sidebar.css';

const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(error);
function AiText({ text }: { text: string }) {
  const parts = text.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('```') ? (
          <pre key={index}>
            <code>{part.replace(/^```[^\n]*\n/, '').replace(/```$/, '')}</code>
          </pre>
        ) : (
          <div className="ai-prose" key={index}>
            {part
              .split(/(`[^`\n]+`)/g)
              .map((piece, key) =>
                piece.startsWith('`') && piece.endsWith('`') ? (
                  <code key={key}>{piece.slice(1, -1)}</code>
                ) : (
                  <Fragment key={key}>{piece}</Fragment>
                ),
              )}
          </div>
        ),
      )}
    </>
  );
}
export function AiSidebar({ studio, onVisibility }: { studio: Studio; onVisibility(open: boolean): void }) {
  const { t } = studio;
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<AiEditScope>('project');
  const [intent, setIntent] = useState<'ask' | 'edit'>('ask');
  const [context, setContext] = useState<AiEditorContext>();
  const [prompt, setPrompt] = useState('');
  const [session, setSession] = useState<AiChatSession>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState(false);
  const [computerAllowed, setComputerAllowed] = useState(false);
  const [copied, setCopied] = useState<number>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const generation = useRef(0),
    pollSequence = useRef(0);
  const sessionRef = useRef(session),
    scopeRef = useRef(scope),
    latest = useRef(studio);
  const submitted = useRef<AiEditorContext | undefined>(undefined);
  const processedEdits = useRef(new Set<string>());
  sessionRef.current = session;
  scopeRef.current = scope;
  latest.current = studio;
  const running = starting || session?.status === 'running';
  const fallbackContext = (): AiEditorContext => {
    const owner = latest.current;
    return {
      projectRoot: owner.state?.projectRoot ?? '',
      ...(owner.source && owner.activePath
        ? {
            source: {
              path: owner.activePath,
              content: owner.drafts[owner.activePath] ?? owner.source.content,
            },
          }
        : {}),
    };
  };
  const stop = async () => {
    const current = sessionRef.current;
    if (!current || current.status !== 'running') return;
    try {
      await window.blode.aiChatCancel({ sessionId: current.id, sessionToken: current.token });
    } catch (error) {
      setError(messageOf(error));
    }
  };
  const clear = () => {
    generation.current++;
    void stop();
    setSession(undefined);
    sessionRef.current = undefined;
    setError('');
    setStarting(false);
    setComputerAllowed(false);
    setCopied(undefined);
  };
  useEffect(() => {
    onVisibility(open);
  }, [open, onVisibility]);
  useEffect(() => {
    const requested = (event: Event) => {
      const detail = (event as CustomEvent<{ intent?: 'ask' | 'edit'; context?: AiEditorContext }>).detail;
      const value = detail?.context ?? currentAiContext(fallbackContext());
      clear();
      setContext(value);
      setIntent(detail?.intent ?? 'ask');
      setScope(value?.source?.selection ? 'selection' : value?.source ? 'file' : 'project');
      setOpen(true);
      setTimeout(() => textarea.current?.focus(), 0);
    };
    window.addEventListener('blode:ai-open', requested);
    return () => window.removeEventListener('blode:ai-open', requested);
  }, []);
  useEffect(() => {
    if (!open) return;
    void window.blode
      .modelServiceState()
      .then((state) =>
        setConfigured(state.hasKey || (state.provider === 'custom' && state.baseUrl.startsWith('http://'))),
      )
      .catch(() => setConfigured(false));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let activePoll = false,
      lastPoll = 0;
    const load = async () => {
      const current = sessionRef.current;
      if (!current || current.status !== 'running' || activePoll || Date.now() - lastPoll < 100) return;
      activePoll = true;
      lastPoll = Date.now();
      const sequence = ++pollSequence.current,
        currentEpoch = generation.current;
      try {
        const next = await window.blode.aiChatState({ sessionId: current.id, sessionToken: current.token });
        if (
          currentEpoch !== generation.current ||
          sequence !== pollSequence.current ||
          sessionRef.current?.id !== next.id
        )
          return;
        if (
          next.status === 'completed' &&
          next.pendingEdit &&
          !processedEdits.current.has(next.pendingEdit.id)
        ) {
          processedEdits.current.add(next.pendingEdit.id);
          let applied = false;
          const original = submitted.current;
          if (original?.source && original.projectRoot === next.projectRoot) {
            const detail: ApplyLocalAiEdit = {
              projectRoot: next.projectRoot,
              edit: next.pendingEdit,
              originalContent: original.source.content,
              reply: (value) => {
                applied = value;
              },
            };
            window.dispatchEvent(new CustomEvent('blode:ai-apply-local', { detail }));
          }
          if (!applied) {
            next.status = 'failed';
            next.error = 'error.aiSourceChanged';
          } else next.changedFiles = [...new Set([...next.changedFiles, next.pendingEdit.path])];
        }
        if (
          next.status === 'completed' &&
          next.pendingEdits?.length &&
          next.pendingEdits.some((edit) => !processedEdits.current.has(edit.id))
        ) {
          const owner = latest.current;
          let valid = owner.state?.projectRoot === next.projectRoot;
          for (const edit of next.pendingEdits) {
            processedEdits.current.add(edit.id);
            const file = owner.state?.files.find((file) => file.path === edit.path);
            if (
              !file ||
              owner.frozenFilePaths.has(edit.path) ||
              (owner.drafts[edit.path] ?? file.content) !== edit.originalContent
            ) {
              valid = false;
              break;
            }
            const detail: ApplyLocalAiEdit = {
              projectRoot: next.projectRoot,
              originalContent: edit.originalContent,
              edit: { ...edit, start: 0, end: edit.originalContent.length },
              validateOnly: true,
              reply: (value) => {
                if (!value) valid = false;
              },
            };
            window.dispatchEvent(new CustomEvent('blode:ai-apply-local', { detail }));
          }
          if (!valid) {
            next.status = 'failed';
            next.error = 'error.aiSourceChanged';
          } else {
            for (const edit of next.pendingEdits) {
              window.dispatchEvent(
                new CustomEvent('blode:ai-apply-local', {
                  detail: {
                    projectRoot: next.projectRoot,
                    originalContent: edit.originalContent,
                    edit: { ...edit, start: 0, end: edit.originalContent.length },
                    reply() {},
                  } satisfies ApplyLocalAiEdit,
                }),
              );
              owner.pinFile(edit.path);
            }
            owner.setDrafts((current) => ({
              ...current,
              ...Object.fromEntries(next.pendingEdits!.map((edit) => [edit.path, edit.text])),
            }));
            owner.setStale(true);
            next.changedFiles = [
              ...new Set([...next.changedFiles, ...next.pendingEdits.map((edit) => edit.path)]),
            ];
          }
        }
        sessionRef.current = next;
        setSession(next);
        if (next.status !== 'running' && next.changedFiles.length) void latest.current.refresh();
      } catch (error) {
        if (currentEpoch === generation.current) setError(messageOf(error));
      } finally {
        activePoll = false;
      }
    };
    const timer = setInterval(() => void load(), 180);
    const unsubscribe = window.blode.onEvent((event) => {
      if (event.message === 'status.aiChatUpdated') void load();
      if (event.message === 'status.modelServiceChanged')
        void window.blode
          .modelServiceState()
          .then((state) =>
            setConfigured(
              state.hasKey || (state.provider === 'custom' && state.baseUrl.startsWith('http://')),
            ),
          )
          .catch(() => setConfigured(false));
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [open]);
  useEffect(() => {
    if (following.current && messages.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [session?.messages, session?.status]);
  useEffect(() => {
    clear();
    setContext(undefined);
  }, [studio.state?.projectRoot]);
  const submit = async () => {
    if (!prompt.trim() || running || !configured || (scope === 'computer' && !computerAllowed)) return;
    const value = currentAiContext(fallbackContext());
    if (value?.readonly && intent === 'edit' && (scope === 'selection' || scope === 'file')) {
      setError('error.aiScope');
      return;
    }
    if (scope !== 'computer' && !value?.projectRoot) {
      setError('error.noWorkspace');
      return;
    }
    if ((scope === 'file' || scope === 'selection') && !value?.source) {
      setError('error.aiScope');
      return;
    }
    if (scope === 'selection' && !value?.source?.selection) {
      setError('error.aiScope');
      return;
    }
    const epoch = ++generation.current,
      text = prompt.trim(),
      previous = sessionRef.current;
    setStarting(true);
    setError('');
    setContext(value);
    submitted.current = value;
    following.current = true;
    try {
      if (latest.current.syncDrafts) await flushCollaboration();
      if (epoch !== generation.current) return;
      const next = await window.blode.aiChatStart({
        projectRoot: value?.projectRoot ?? '',
        scope,
        intent,
        prompt: text,
        ...(value?.source ? { source: value.source } : {}),
        ...(value?.actor ? { actor: value.actor } : {}),
        ...(intent === 'edit' || scope === 'computer' ? { confirm: true } : {}),
        ...(!latest.current.syncDrafts && intent === 'edit' && scope !== 'computer'
          ? { localOnly: true }
          : {}),
        ...(previous && previous.projectRoot === value?.projectRoot && previous.scope === scope
          ? { sessionId: previous.id, sessionToken: previous.token }
          : {}),
      });
      if (epoch !== generation.current) {
        void window.blode.aiChatCancel({ sessionId: next.id, sessionToken: next.token });
        return;
      }
      sessionRef.current = next;
      setSession(next);
      setPrompt('');
    } catch (error) {
      if (epoch === generation.current) setError(messageOf(error));
    } finally {
      if (epoch === generation.current) setStarting(false);
    }
  };
  if (!open) return null;
  return (
    <aside className="ai-sidebar" aria-label={t('ai.chat.title')}>
      <header className="ai-sidebar-header">
        <strong>{t('ai.chat.title')}</strong>
        <button
          className="icon-button"
          aria-label={t('ai.chat.new')}
          title={t('ai.chat.new')}
          onClick={clear}
        >
          <Plus size={15} />
        </button>
        <button
          className="icon-button"
          aria-label={t('action.close')}
          onClick={() => {
            clear();
            setOpen(false);
          }}
        >
          <X size={15} />
        </button>
      </header>
      <div className="ai-scope-row">
        <ModernSelect
          value={scope}
          aria-label={t('ai.chat.scope')}
          onChange={(event) => {
            clear();
            setScope(event.target.value as AiEditScope);
            setContext(currentAiContext(fallbackContext()));
          }}
        >
          {(['selection', 'file', 'project', 'computer'] as const).map((scope) => (
            <option key={scope} value={scope}>
              {t(`ai.chat.${scope}`)}
            </option>
          ))}
        </ModernSelect>
        <ModernSelect
          value={intent}
          aria-label={t('ai.chat.ask')}
          disabled={running || (!!context?.readonly && (scope === 'selection' || scope === 'file'))}
          onChange={(event) => setIntent(event.target.value as 'ask' | 'edit')}
        >
          <option value="ask">{t('ai.chat.ask')}</option>
          <option value="edit">{t('ai.chat.edit')}</option>
        </ModernSelect>
      </div>
      {context?.source && (
        <div className="ai-context-chip" title={context.source.path}>
          <FileCode2 size={12} />
          <span>
            {context.source.path.split(/[\\/]/).at(-1)}
            {scope === 'selection' && context.source.selection
              ? ` · ${context.source.selection.end - context.source.selection.start}`
              : ''}
          </span>
        </div>
      )}
      {scope === 'computer' && !computerAllowed && (
        <div className="ai-computer-grant">
          <ShieldAlert size={18} />
          <p>{t('ai.chat.computerPermission')}</p>
          <button className="secondary" onClick={() => setComputerAllowed(true)}>
            {t('ai.chat.enableComputer')}
          </button>
        </div>
      )}
      <div
        className="ai-message-scroll"
        ref={messages}
        onScroll={(event) => {
          const view = event.currentTarget;
          following.current = view.scrollHeight - view.clientHeight - view.scrollTop < 28;
        }}
      >
        {!session?.messages.length && <div className="ai-chat-empty">{t('ai.chat.empty')}</div>}
        {session?.messages.map((message, index) =>
          message.role === 'tool' ? (
            <details className="ai-tool-message" key={index}>
              <summary>{message.content.split('\n')[0]}</summary>
              <pre>{message.content.split('\n').slice(1).join('\n')}</pre>
            </details>
          ) : (
            <article className={`ai-message ai-message-${message.role}`} key={index}>
              <AiText
                text={
                  message.role === 'assistant' && message.content.startsWith('status.aiFileUpdated: ')
                    ? `${t('status.aiFileUpdated')} · ${message.content.slice('status.aiFileUpdated: '.length)}`
                    : message.content
                }
              />
              {message.role === 'assistant' && message.content && (
                <button
                  className="ai-copy"
                  aria-label={t('action.copy')}
                  title={t('action.copy')}
                  onClick={() => void studio.copy(message.content).then(() => setCopied(index))}
                >
                  {copied === index ? <Check size={12} /> : <Copy size={12} />}
                </button>
              )}
            </article>
          ),
        )}
        {running && (
          <div className="ai-chat-running" role="status">
            <LoaderCircle size={13} className="spin" />
            {t('ai.chat.running')}
          </div>
        )}
        {session?.changedFiles.length ? (
          <details className="ai-changed-files">
            <summary>
              {t('ai.chat.changedFiles')} ({session.changedFiles.length})
            </summary>
            {session.changedFiles.map((file) => (
              <button key={file} onClick={() => studio.openFile(file)}>
                {file}
              </button>
            ))}
          </details>
        ) : null}
      </div>
      {(error || session?.error) && (
        <div role="alert" className="ai-chat-error">
          {t(error || session!.error!)}
        </div>
      )}
      {!configured && (
        <button
          className="ai-configure-button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('blode:preferences', { detail: { section: 'ai' } }))
          }
        >
          {t('ai.chat.configure')}
        </button>
      )}
      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={textarea}
          value={prompt}
          placeholder={t('ai.chat.prompt')}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="primary"
          type={running ? 'button' : 'submit'}
          disabled={
            starting ||
            (!running && (!configured || !prompt.trim() || (scope === 'computer' && !computerAllowed)))
          }
          onClick={running ? () => void stop() : undefined}
          aria-label={t(running ? 'ai.chat.stop' : 'ai.chat.send')}
          title={t(running ? 'ai.chat.stop' : 'ai.chat.send')}
        >
          {running ? <Square size={14} /> : <Send size={15} />}
        </button>
      </form>
    </aside>
  );
}
