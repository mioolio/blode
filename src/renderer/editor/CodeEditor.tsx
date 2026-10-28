import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import { useI18n } from '../i18n';
import { registerCompletions } from './completionProvider';
import { useEffect, useRef, useState } from 'react';

// Bundle the editor locally: no CDN dependency, even on a fully offline workstation.
self.MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label === 'json') return new JsonWorker();
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
monaco.editor.defineTheme('blode', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '626F7F', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'C497E8' },
    { token: 'string', foreground: 'A8C98C' },
    { token: 'number', foreground: 'E1B583' },
    { token: 'type', foreground: '6DC8BC' },
  ],
  colors: {
    'editor.background': '#10141C',
    'editor.foreground': '#D6DEEB',
    'editorLineNumber.foreground': '#4F5A6E',
    'editorLineNumber.activeForeground': '#A9B6CA',
    'editor.lineHighlightBackground': '#161C26',
    'editor.selectionBackground': '#2B4A78',
    'editor.inactiveSelectionBackground': '#22344F',
    'editorCursor.foreground': '#7FB2FF',
    'editorIndentGuide.background1': '#232C3A',
    'editorGutter.background': '#10141C',
    'editorWidget.background': '#171C26',
    'editorWidget.foreground': '#D6DEEB',
    'editorWidget.border': '#2A3342',
    'editorSuggestWidget.background': '#171C26',
    'editorSuggestWidget.border': '#2A3342',
    'editorSuggestWidget.foreground': '#D6DEEB',
    'editorSuggestWidget.selectedBackground': '#263246',
    'editorSuggestWidget.selectedForeground': '#FFFFFF',
    'editorSuggestWidget.selectedIconForeground': '#C9D8F2',
    'editorSuggestWidget.highlightForeground': '#7FB2FF',
    'editorSuggestWidget.focusHighlightForeground': '#9CC4FF',
    'editorHoverWidget.background': '#171C26',
    'editorHoverWidget.foreground': '#D6DEEB',
    'editorHoverWidget.border': '#2A3342',
    'list.hoverBackground': '#1E2733',
    'list.hoverForeground': '#D6DEEB',
    'list.activeSelectionBackground': '#263246',
    'list.activeSelectionForeground': '#FFFFFF',
    'list.inactiveSelectionBackground': '#1E2733',
    'list.inactiveSelectionForeground': '#D6DEEB',
    'list.focusBackground': '#263246',
    'list.focusForeground': '#FFFFFF',
    'list.highlightForeground': '#7FB2FF',
    'scrollbarSlider.background': '#2B344280',
    'scrollbarSlider.hoverBackground': '#3C485980',
  },
});
monaco.editor.defineTheme('blode-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8A94A6', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7C3AED' },
    { token: 'string', foreground: '15803D' },
    { token: 'number', foreground: 'B45309' },
    { token: 'type', foreground: '0F766E' },
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#1F2937',
    'editorLineNumber.foreground': '#A6B0BF',
    'editorLineNumber.activeForeground': '#475569',
    'editor.lineHighlightBackground': '#F3F6FB',
    'editor.selectionBackground': '#CFE3FF',
    'editor.inactiveSelectionBackground': '#E4EEFB',
    'editorCursor.foreground': '#2563EB',
    'editorIndentGuide.background1': '#E5EAF2',
    'editorGutter.background': '#FFFFFF',
    'editorWidget.background': '#FFFFFF',
    'editorWidget.foreground': '#1F2937',
    'editorWidget.border': '#D9E0EA',
    'editorSuggestWidget.background': '#FFFFFF',
    'editorSuggestWidget.border': '#D9E0EA',
    'editorSuggestWidget.foreground': '#1F2937',
    'editorSuggestWidget.selectedBackground': '#E8F0FE',
    'editorSuggestWidget.selectedForeground': '#0F172A',
    'editorSuggestWidget.selectedIconForeground': '#1D4ED8',
    'editorSuggestWidget.highlightForeground': '#2563EB',
    'editorSuggestWidget.focusHighlightForeground': '#1D4ED8',
    'editorHoverWidget.background': '#FFFFFF',
    'editorHoverWidget.foreground': '#1F2937',
    'editorHoverWidget.border': '#D9E0EA',
    'list.hoverBackground': '#F1F5FB',
    'list.hoverForeground': '#1F2937',
    'list.activeSelectionBackground': '#E8F0FE',
    'list.activeSelectionForeground': '#0F172A',
    'list.inactiveSelectionBackground': '#F1F5FB',
    'list.inactiveSelectionForeground': '#1F2937',
    'list.focusBackground': '#E8F0FE',
    'list.focusForeground': '#0F172A',
    'list.highlightForeground': '#2563EB',
    'scrollbarSlider.background': '#C2CBD880',
    'scrollbarSlider.hoverBackground': '#A7B3C480',
  },
});
registerCompletions(monaco);
export function CodeEditor({
  path,
  language,
  value,
  onChange,
  onCursor,
}: {
  path: string;
  language: string;
  value: string;
  onChange: (value: string) => void;
  onCursor?: (position: { line: number; column: number }) => void;
}) {
  const { t } = useI18n();
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const cursorHandler = useRef(onCursor);
  const subscriptions = useRef<monaco.IDisposable[]>([]);
  useEffect(() => {
    cursorHandler.current = onCursor;
  }, [onCursor]);
  useEffect(() => {
    // Switching files reuses the editor instance, so publish the position of the new model.
    const position = editor.current?.getPosition();
    if (position) cursorHandler.current?.({ line: position.lineNumber, column: position.column });
  }, [path]);
  useEffect(() => () => subscriptions.current.forEach((item) => item.dispose()), []);
  const [dark, setDark] = useState(() => !window.matchMedia('(prefers-color-scheme: light)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const sync = () => setDark(!media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  useEffect(() => {
    const handle = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      const actions: Record<string, string> = {
        undo: 'undo',
        redo: 'redo',
        find: 'actions.find',
        format: 'editor.action.formatDocument',
        gotoLine: 'editor.action.gotoLine',
        selectAll: 'editor.action.selectAll',
      };
      const action = actions[command];
      if (!action || !editor.current) return;
      editor.current.focus();
      editor.current.trigger('menu', action, null);
    };
    window.addEventListener('blode:editor-command', handle);
    return () => window.removeEventListener('blode:editor-command', handle);
  }, []);
  return (
    <Editor
      path={path}
      language={['arduino', 'c'].includes(language) ? 'cpp' : language}
      value={value}
      theme={dark ? 'blode' : 'blode-light'}
      onMount={(instance) => {
        editor.current = instance;
        const report = (position: monaco.Position) =>
          cursorHandler.current?.({ line: position.lineNumber, column: position.column });
        subscriptions.current.push(
          instance.onDidChangeCursorPosition((event) => report(event.position)),
        );
        report(instance.getPosition() ?? new monaco.Position(1, 1));
      }}
      loading={<span className="muted">{t('editor.loading')}</span>}
      onChange={(value) => onChange(value ?? '')}
      options={{
        fontFamily: 'Cascadia Code, Consolas, monospace',
        fontSize: 13,
        lineHeight: 23,
        minimap: { enabled: true, maxColumn: 80, scale: 1 },
        padding: { top: 20, bottom: 20 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true },
        automaticLayout: true,
        tabSize: 2,
        wordWrap: 'off',
        renderLineHighlight: 'line',
        overviewRulerBorder: false,
        fixedOverflowWidgets: true,
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnEnter: 'on',
        tabCompletion: 'on',
        wordBasedSuggestions: 'currentDocument',
        snippetSuggestions: 'top',
        parameterHints: { enabled: true },
        suggest: {
          showMethods: true,
          showFunctions: true,
          showVariables: true,
          showConstants: true,
          showSnippets: true,
          preview: true,
        },
      }}
    />
  );
}
