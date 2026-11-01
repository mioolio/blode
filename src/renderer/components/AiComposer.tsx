import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowUp, FileCode2, Plus, Search, Square, X } from 'lucide-react';
import type { AiEditScope, AiSourceContext } from '../../shared/model-service';
import type { AiEditorContext } from '../workspace/aiContext';
import { aiSourceLabel } from '../../shared/ai-context';
import { ModernSelect } from './ModernSelect';

interface Props {
  t(key: string): string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  onPrompt(value: string): void;
  context?: AiEditorContext;
  references: AiSourceContext[];
  files: { path: string; content: string }[];
  onReferences(value: AiSourceContext[]): void;
  onDetachSource(): void;
  scope: AiEditScope;
  intent: 'ask' | 'edit';
  onScope(value: AiEditScope): void;
  onIntent(value: 'ask' | 'edit'): void;
  model: string;
  configured: boolean;
  running: boolean;
  starting: boolean;
  computerAllowed: boolean;
  onSubmit(): void;
  onStop(): void;
  onConfigure(): void;
}

export function AiComposer(props: Props) {
  const { t, inputRef, context, references, running, scope } = props;
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<AiSourceContext>();
  const root = useRef<HTMLFormElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const pickerId = useId();
  const primary = context?.source;
  const occupied = new Set([primary?.path, ...references.map((file) => file.path)]);
  const matches = useMemo(() => {
    if (!picker) return [];
    const result: Props['files'] = [];
    for (const file of props.files) {
      if (occupied.has(file.path) || !file.path.toLowerCase().includes(query.toLowerCase())) continue;
      result.push(file);
      if (result.length === 40) break;
    }
    return result;
  }, [picker, props.files, primary?.path, references, query]);
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    const resize = () => {
      element.style.height = '0px';
      const maximum = Math.min(192, window.innerHeight * 0.3);
      element.style.height = `${Math.max(52, Math.min(maximum, element.scrollHeight))}px`;
      element.style.overflowY = element.scrollHeight > maximum ? 'auto' : 'hidden';
    };
    resize();
    let width = element.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [props.prompt, inputRef]);
  useEffect(() => {
    if (!picker) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setPicker(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [picker]);
  useEffect(() => {
    setPreview(undefined);
    setPicker(false);
  }, [context, scope]);
  useEffect(() => {
    if (picker) document.getElementById(`${pickerId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [picker, pickerId, active]);
  const attach = (file: { path: string; content: string }) => {
    if (references.length >= 8 || running) return;
    // Give each reference an equal share of the bounded request budget.
    props.onReferences([...references, { path: file.path, content: file.content.slice(0, 8000) }]);
    setPicker(false);
    setQuery('');
    inputRef.current?.focus();
  };
  const chip = (file: AiSourceContext, primarySource = false) => (
    <span className="ai-reference" key={file.path}>
      <button
        type="button"
        className="ai-reference-label"
        title={file.path}
        aria-expanded={preview?.path === file.path}
        onClick={() => setPreview(preview?.path === file.path ? undefined : file)}
      >
        <FileCode2 size={13} />
        <span>{aiSourceLabel(file)}</span>
      </button>
      <button
        type="button"
        className="ai-reference-remove"
        disabled={running}
        aria-label={`${t('ai.chat.removeReference')} ${aiSourceLabel(file)}`}
        onClick={() => {
          setPreview(undefined);
          if (primarySource) props.onDetachSource();
          else props.onReferences(references.filter((item) => item.path !== file.path));
        }}
      >
        <X size={11} />
      </button>
    </span>
  );
  return (
    <form
      className="ai-composer"
      ref={root}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="ai-composer-box">
        {(primary || references.length > 0) && (
          <div className="ai-references" aria-label={t('ai.chat.context')}>
            {primary && chip(scope === 'selection' ? primary : { ...primary, selection: undefined }, true)}
            {references.map((file) => chip(file))}
          </div>
        )}
        {preview && (
          <div className="ai-reference-preview">
            <div>
              <span title={preview.path}>{preview.path}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={t('action.close')}
                onClick={() => setPreview(undefined)}
              >
                <X size={12} />
              </button>
            </div>
            <pre>
              {(preview.selection
                ? preview.content.slice(preview.selection.start, preview.selection.end)
                : preview.content
              ).slice(0, 1800)}
            </pre>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={props.prompt}
          rows={2}
          aria-label={t('ai.chat.prompt')}
          placeholder={t('ai.chat.prompt')}
          onChange={(event) => props.onPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <div className="ai-composer-toolbar">
          <button
            type="button"
            className="icon-button ai-attach"
            ref={add}
            disabled={running || references.length >= 8 || !props.files.length}
            title={t('ai.chat.addReference')}
            aria-label={t('ai.chat.addReference')}
            aria-expanded={picker}
            aria-controls={pickerId}
            onClick={() => {
              setPicker(!picker);
              setQuery('');
              setActive(0);
            }}
          >
            <Plus size={16} />
          </button>
          <ModernSelect
            value={scope}
            aria-label={t('ai.chat.scope')}
            disabled={running}
            onChange={(event) => props.onScope(event.target.value as AiEditScope)}
          >
            {(['selection', 'file', 'project', 'computer'] as const).map((value) => (
              <option value={value} key={value}>
                {t(`ai.chat.${value}`)}
              </option>
            ))}
          </ModernSelect>
          <ModernSelect
            value={props.intent}
            aria-label={t('ai.chat.mode')}
            disabled={running}
            onChange={(event) => props.onIntent(event.target.value as 'ask' | 'edit')}
          >
            <option value="ask">{t('ai.chat.ask')}</option>
            <option
              value="edit"
              disabled={!!context?.readonly && (scope === 'selection' || scope === 'file')}
            >
              {t('ai.chat.edit')}
            </option>
          </ModernSelect>
          <div className="ai-composer-spacer" />
          <button
            type="button"
            className="ai-composer-model"
            title={props.model || t('ai.chat.configure')}
            onClick={props.onConfigure}
          >
            {props.model || t('ai.chat.configure')}
          </button>
          <button
            className="primary ai-composer-send"
            type={running ? 'button' : 'submit'}
            disabled={
              props.starting ||
              (!running &&
                (!props.configured ||
                  !props.prompt.trim() ||
                  (scope === 'computer' && !props.computerAllowed)))
            }
            onClick={running ? props.onStop : undefined}
            aria-label={t(running ? 'ai.chat.stop' : 'ai.chat.send')}
            title={t(running ? 'ai.chat.stop' : 'ai.chat.send')}
          >
            {running ? <Square size={13} /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
      {picker && (
        <div
          className="ai-reference-picker"
          id={pickerId}
          role="dialog"
          aria-label={t('ai.chat.addReference')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setPicker(false);
              add.current?.focus();
            }
          }}
        >
          <label className="ai-reference-search">
            <Search size={14} />
            <input
              ref={search}
              value={query}
              placeholder={t('ai.chat.findReference')}
              aria-label={t('ai.chat.findReference')}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActive((value) =>
                    Math.max(0, Math.min(matches.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))),
                  );
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (matches[active]) attach(matches[active]);
                }
              }}
            />
          </label>
          <div className="ai-reference-results">
            {matches.map((file, index) => (
              <button
                type="button"
                key={file.path}
                id={`${pickerId}-${index}`}
                className={index === active ? 'active' : ''}
                onClick={() => attach(file)}
                title={file.path}
              >
                <FileCode2 size={13} />
                <span>{file.path}</span>
                <Plus size={12} />
              </button>
            ))}
            {!matches.length && <span className="ai-reference-empty">{t('ai.chat.noReference')}</span>}
          </div>
        </div>
      )}
    </form>
  );
}
