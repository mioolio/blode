import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
// Keep all editor commands, while avoiding the root entry's unused LSP client.
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { useI18n } from '../i18n';
import {
  registerCompletions,
  sourcePathForUri,
  definitionOriginForEditor,
  externalSourceForUri,
} from './completionProvider';
import type { SourceLocation } from '../../shared/language';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { attachInlineCompletions, type PredictionFeedback } from './inlineCompletions';
import { mapTextOffset, textChanges } from './collaborationText';
import { LocalUndoHistory } from '../../shared/selective-undo';
import { UndoCommand, RedoCommand } from 'monaco-editor/esm/vs/editor/browser/editorExtensions.js';
import type { CollaborationPeer } from '../../shared/collaboration';
import type { EditorPresence } from '../workspace/useCollaboration';
import { PeerRangeOverlay } from './PeerRangeOverlay';
import { EditorLoading } from './EditorLoading';
import { attachAiEditorActions } from './aiActions';
import { localizeMonacoContextMenu } from './localizeMonaco';
import { ownsEditorNavigation } from './navigationOwner';
import { externalModelIsRefreshing, refreshExternalModel } from './externalModelUpdates';

// Bundle the editor locally: no CDN dependency, even on a fully offline workstation.
self.MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label === 'json') return new JsonWorker();
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
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
// Split panes can share a Monaco model. Classify and record each model change once.
const remoteModels = new WeakSet<monaco.editor.ITextModel>();
const ownUndoModels = new WeakSet<monaco.editor.ITextModel>();
const modelTexts = new WeakMap<monaco.editor.ITextModel, string>();
const undoHistories = new WeakMap<monaco.editor.ITextModel, LocalUndoHistory>();
let lastFocusedEditor: monaco.editor.IStandaloneCodeEditor | null = null;
const mountedEditors = new WeakSet<monaco.editor.ICodeEditor>();
const ownedModels = new Set<string>();
let retainedModels = new Set<string>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const modelUri = (root: string, path: string) => monaco.Uri.file(`${root}/${path}`).toString();
const releaseModel = (uri: string, attempt = 0) => {
  if (releaseTimers.has(uri)) clearTimeout(releaseTimers.get(uri));
  releaseTimers.delete(uri);
  if (retainedModels.has(uri) || !ownedModels.has(uri)) return;
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model) {
    ownedModels.delete(uri);
    return;
  }
  // React first detaches the pane; another split pane may still own the same model.
  if (monaco.editor.getEditors().some((instance) => instance.getModel() === model)) {
    if (attempt < 120)
      releaseTimers.set(
        uri,
        setTimeout(() => releaseModel(uri, attempt + 1), 16),
      );
    return;
  }
  model.dispose();
  ownedModels.delete(uri);
};
window.addEventListener('blode:editor-tabs', (event) => {
  const detail = (event as CustomEvent<{ root: string; paths: string[] }>).detail;
  if (!detail || !Array.isArray(detail.paths)) return;
  retainedModels = new Set(detail.paths.map((path) => modelUri(detail.root, path)));
  for (const uri of ownedModels) if (!retainedModels.has(uri)) releaseModel(uri);
});
window.addEventListener('blode:file-closed', (event) => {
  const detail = (event as CustomEvent<{ root: string; path: string }>).detail;
  if (!detail) return;
  const uri = modelUri(detail.root, detail.path);
  retainedModels.delete(uri);
  releaseModel(uri);
});
export function CodeEditor({
  projectRoot,
  path,
  language,
  value,
  onChange,
  onCursor,
  peers = [],
  onPresence,
  primary = false,
  onUndo,
  navigation,
  readOnly = false,
}: {
  projectRoot: string;
  path: string;
  language: string;
  value: string;
  onChange: (value: string) => void;
  onCursor?: (position: { line: number; column: number }) => void;
  peers?: CollaborationPeer[];
  onPresence?: (presence: EditorPresence) => void;
  primary?: boolean;
  onUndo?: (direction: 'undo' | 'redo') => Promise<void>;
  navigation?: SourceLocation;
  readOnly?: boolean;
}) {
  const { t, locale } = useI18n();
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const cursorHandler = useRef(onCursor);
  const subscriptions = useRef<monaco.IDisposable[]>([]);
  const aiActions = useRef<monaco.IDisposable | undefined>(undefined);
  const navigationActions = useRef<monaco.IDisposable[]>([]);
  const installNavigationActions = (instance: monaco.editor.IStandaloneCodeEditor) => {
    navigationActions.current.forEach((action) => action.dispose());
    navigationActions.current = [
      instance.addAction({
        id: 'blode.navigationBack',
        label: t('editor.navigationBack'),
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.9,
        run: () => {
          window.dispatchEvent(
            new CustomEvent('blode:navigate-back', {
              detail: { pane: latest.current.primary ? 'primary' : 'secondary' },
            }),
          );
        },
      }),
      instance.addAction({
        id: 'blode.symbolSearch',
        label: t('symbol.search.action'),
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT],
        run: () => {
          window.dispatchEvent(new Event('blode:symbol-search'));
        },
      }),
    ];
  };
  const inlineCompletions = useRef<monaco.IDisposable | undefined>(undefined);
  const [predictionFeedback, setPredictionFeedback] = useState<PredictionFeedback>({ kind: 'idle' });
  const installInlineCompletions = (instance: monaco.editor.IStandaloneCodeEditor) => {
    inlineCompletions.current?.dispose();
    inlineCompletions.current = attachInlineCompletions(monaco, instance, {
      acceptLabel: t('ai.completions.acceptPrediction'),
      completeLabel: t('ai.completions.complete'),
      projectRoot: () => latest.current.projectRoot,
      path: () => latest.current.path,
      onStatus: setPredictionFeedback,
    });
  };
  const installAiActions = (instance: monaco.editor.IStandaloneCodeEditor) => {
    aiActions.current?.dispose();
    aiActions.current = attachAiEditorActions(monaco, instance, {
      t,
      active: () => (lastFocusedEditor ? lastFocusedEditor === instance : latest.current.primary),
      context: () => {
        const model = instance.getModel();
        if (!model || model.isDisposed()) return undefined;
        const selection = instance.getSelection();
        const selected =
          selection && !selection.isEmpty()
            ? {
                start: model.getOffsetAt(selection.getStartPosition()),
                end: model.getOffsetAt(selection.getEndPosition()),
              }
            : undefined;
        return {
          projectRoot: latest.current.projectRoot,
          readonly: instance.getOption(monaco.editor.EditorOption.readOnly),
          source: {
            path: sourcePathForUri(model.uri.path) ?? latest.current.path,
            content: model.getValue(),
            ...(selected ? { selection: selected } : {}),
          },
        };
      },
    });
  };
  useEffect(() => {
    void localizeMonacoContextMenu(locale);
    if (editor.current) {
      installAiActions(editor.current);
      installNavigationActions(editor.current);
      installInlineCompletions(editor.current);
    }
  }, [locale]);
  const latest = useRef({
    projectRoot,
    path,
    value,
    peers,
    onPresence,
    primary,
    onUndo,
    navigation,
    readOnly,
  });
  latest.current = { projectRoot, path, value, peers, onPresence, primary, onUndo, navigation, readOnly };
  const applyingRemote = useRef(false);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | undefined>(undefined);
  const peerRanges = useRef<PeerRangeOverlay | undefined>(undefined);
  const modelPath = monaco.Uri.file(`${projectRoot}/${path}`).toString();
  const appliedNavigation = useRef<SourceLocation | undefined>(undefined);
  const navigationFrame = useRef<number | undefined>(undefined);
  const applyNavigation = () => {
    const target = latest.current.navigation,
      instance = editor.current,
      model = instance?.getModel();
    if (
      !target ||
      target === appliedNavigation.current ||
      !instance ||
      !model ||
      sourcePathForUri(model.uri.path) !== target.path
    )
      return;
    const range = model.validateRange(
      new monaco.Range(target.line, target.column, target.endLine, target.endColumn),
    );
    instance.setSelection(range);
    appliedNavigation.current = target;
    instance.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
    instance.focus();
  };
  const scheduleNavigation = () => {
    if (navigationFrame.current !== undefined) cancelAnimationFrame(navigationFrame.current);
    // The React adapter restores a model's saved view immediately after setModel.
    // Apply explicit navigation after that restore, rather than inside its event.
    navigationFrame.current = requestAnimationFrame(() => {
      navigationFrame.current = undefined;
      applyNavigation();
    });
  };
  useEffect(() => {
    scheduleNavigation();
  }, [navigation, path]);
  const synchronizeValue = () => {
    const instance = editor.current,
      model = instance?.getModel();
    if (
      !instance ||
      !model ||
      model.uri.toString() !==
        monaco.Uri.file(`${latest.current.projectRoot}/${latest.current.path}`).toString()
    )
      return;
    const external = externalSourceForUri(model.uri.path);
    if (external) {
      refreshExternalModel(model, external.content);
      return;
    }
    const changes = textChanges(model.getValue(), latest.current.value);
    if (!changes.length) return;
    const top = instance.getVisibleRanges()[0]?.startLineNumber ?? 1;
    const offset = model.getOffsetAt({ lineNumber: top, column: 1 });
    const withinLine = instance.getScrollTop() - instance.getTopForLineNumber(top);
    const left = instance.getScrollLeft();
    const edits = changes.map((change) => {
      const start = model.getPositionAt(change.start),
        end = model.getPositionAt(change.end);
      return {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        text: change.text,
        forceMoveMarkers: true,
      };
    });
    applyingRemote.current = true;
    remoteModels.add(model);
    try {
      instance.executeEdits('blode:shared-edit', edits);
      const anchor = model.getPositionAt(mapTextOffset(offset, changes));
      const targetScroll = instance.getTopForLineNumber(anchor.lineNumber) + withinLine;
      instance.setScrollPosition(
        { scrollTop: targetScroll, scrollLeft: left },
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
          Math.abs(targetScroll - instance.getScrollTop()) > instance.getLayoutInfo().height
          ? monaco.editor.ScrollType.Immediate
          : monaco.editor.ScrollType.Smooth,
      );
    } finally {
      applyingRemote.current = false;
      remoteModels.delete(model);
    }
  };
  const decoratePeers = (animate = true) => {
    const model = editor.current?.getModel();
    if (!model || !decorations.current) return;
    if (model.uri.toString() !== modelPath) return;
    const ranges = latest.current.peers
      .filter((peer) => peer.attention !== 'inactive' && peer.path === latest.current.path)
      .map((peer) => {
        const first = Math.max(1, Math.min(model.getLineCount(), peer.startLine));
        const last = Math.max(first, Math.min(model.getLineCount(), peer.endLine));
        return {
          range: new monaco.Range(first, 1, last, model.getLineMaxColumn(last)),
          options: {
            isWholeLine: true,
            hoverMessage: {
              value: `${peer.name.replace(/[\\`*_[\]<>]/g, '\\$&')} · ${t(peer.editing ? 'collaboration.editing' : 'collaboration.viewing')} · ${peer.startLine}–${peer.endLine}`,
            },
          },
        };
      });
    decorations.current.set(ranges);
    peerRanges.current?.update(latest.current.peers, latest.current.path, modelPath, animate);
  };
  useEffect(() => {
    cursorHandler.current = onCursor;
  }, [onCursor]);
  useEffect(() => {
    // Switching files reuses the editor instance, so publish the position of the new model.
    const position = editor.current?.getPosition();
    if (position) cursorHandler.current?.({ line: position.lineNumber, column: position.column });
  }, [path]);
  useEffect(() => {
    ownedModels.add(modelPath);
    retainedModels.add(modelPath);
    return () => {
      setTimeout(() => releaseModel(modelPath), 0);
    };
  }, [modelPath]);
  useLayoutEffect(() => {
    // Apply shared values during the React commit, before another keyboard event
    // can make this render's value older than the live Monaco model.
    synchronizeValue();
    decoratePeers(false);
  }, [value, path, projectRoot]);
  useEffect(() => {
    decoratePeers();
  }, [peers]);
  useEffect(
    () => () => {
      subscriptions.current.forEach((item) => item.dispose());
      aiActions.current?.dispose();
      navigationActions.current.forEach((action) => action.dispose());
      inlineCompletions.current?.dispose();
      if (navigationFrame.current !== undefined) cancelAnimationFrame(navigationFrame.current);
      if (lastFocusedEditor === editor.current) lastFocusedEditor = null;
      decorations.current?.clear();
      peerRanges.current?.dispose();
    },
    [],
  );
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
      if (
        !action ||
        !editor.current ||
        (lastFocusedEditor ? lastFocusedEditor !== editor.current : !latest.current.primary)
      )
        return;
      editor.current.focus();
      editor.current.trigger('menu', action, null);
    };
    window.addEventListener('blode:editor-command', handle);
    return () => window.removeEventListener('blode:editor-command', handle);
  }, []);
  return (
    <div style={{ height: '100%', minHeight: 0, position: 'relative' }}>
      <Editor
        path={modelPath}
        language={['arduino', 'c'].includes(language) ? 'cpp' : language}
        defaultValue={value}
        keepCurrentModel
        theme={dark ? 'blode' : 'blode-light'}
        onMount={(instance) => {
          mountedEditors.add(instance);
          installAiActions(instance);
          installNavigationActions(instance);
          void localizeMonacoContextMenu(locale);
          editor.current = instance;
          decorations.current = instance.createDecorationsCollection();
          peerRanges.current = new PeerRangeOverlay(instance);
          const report = (position: monaco.Position) =>
            cursorHandler.current?.({ line: position.lineNumber, column: position.column });
          subscriptions.current.push(
            monaco.editor.registerEditorOpener({
              openCodeEditor(source, resource, selection) {
                if (!ownsEditorNavigation(source, instance, mountedEditors)) return false;
                const path = sourcePathForUri(resource.path),
                  from = source.getModel();
                if (!path || !from) return false;
                const originPath = sourcePathForUri(from.uri.path);
                if (!originPath) return false;
                const position = source.getPosition() ?? new monaco.Position(1, 1);
                const origin = definitionOriginForEditor(source);
                const range = selection && 'startLineNumber' in selection ? selection : undefined;
                const line =
                  range?.startLineNumber ??
                  (selection && 'lineNumber' in selection ? selection.lineNumber : 1);
                const column =
                  range?.startColumn ?? (selection && 'column' in selection ? selection.column : 1);
                window.dispatchEvent(
                  new CustomEvent('blode:navigate-source', {
                    detail: {
                      root: latest.current.projectRoot,
                      pane: latest.current.primary ? 'primary' : 'secondary',
                      target: {
                        path,
                        externalId: externalSourceForUri(resource.path)?.id,
                        line,
                        column,
                        endLine: range?.endLineNumber ?? line,
                        endColumn: range?.endColumn ?? column,
                      },
                      origin: origin ?? {
                        path: originPath,
                        externalId: externalSourceForUri(from.uri.path)?.id,
                        line: position.lineNumber,
                        column: position.column,
                        endLine: position.lineNumber,
                        endColumn: position.column,
                      },
                    },
                  }),
                );
                return true;
              },
            }),
            monaco.editor.registerLinkOpener({
              open(resource) {
                if (lastFocusedEditor && lastFocusedEditor !== instance) return false;
                const path = sourcePathForUri(resource.path);
                if (!path) return false;
                const position = instance.getPosition() ?? new monaco.Position(1, 1);
                window.dispatchEvent(
                  new CustomEvent('blode:navigate-source', {
                    detail: {
                      root: latest.current.projectRoot,
                      pane: latest.current.primary ? 'primary' : 'secondary',
                      target: {
                        path,
                        externalId: externalSourceForUri(resource.path)?.id,
                        line: 1,
                        column: 1,
                        endLine: 1,
                        endColumn: 1,
                      },
                      origin: {
                        path: latest.current.path,
                        externalId: externalSourceForUri(instance.getModel()?.uri.path ?? '')?.id,
                        line: position.lineNumber,
                        column: position.column,
                        endLine: position.lineNumber,
                        endColumn: position.column,
                      },
                    },
                  }),
                );
                return true;
              },
            }),
            instance.onDidChangeCursorPosition((event) => report(event.position)),
          );
          installInlineCompletions(instance);
          const initialModel = instance.getModel();
          if (initialModel && !modelTexts.has(initialModel))
            modelTexts.set(initialModel, initialModel.getValue());
          const runUndo = async (direction: 'undo' | 'redo') => {
            if (
              latest.current.readOnly ||
              instance.getOption(monaco.editor.EditorOption.readOnly) ||
              externalSourceForUri(instance.getModel()?.uri.path ?? '')
            )
              return;
            if (latest.current.onUndo) {
              await latest.current.onUndo(direction);
              return;
            }
            const model = instance.getModel();
            if (!model) return;
            const history = undoHistories.get(model);
            if (!history) return;
            try {
              const changes = history.take(model.getValue(), direction);
              if (!changes?.length) return;
              const edits = changes.map((change) => {
                const start = model.getPositionAt(change.start),
                  end = model.getPositionAt(change.end);
                return {
                  range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                  text: change.text,
                  forceMoveMarkers: true,
                };
              });
              ownUndoModels.add(model);
              try {
                instance.executeEdits('blode:own-undo', edits);
              } finally {
                ownUndoModels.delete(model);
              }
            } catch {
              window.dispatchEvent(new CustomEvent('blode:undo-conflict'));
            }
          };
          // Monaco's global command registry drives keyboard, Edit menu and command palette.
          // Intercept commands, not model.undo(), so internal suggestion rollback keeps working.
          for (const [command, direction] of [
            [UndoCommand, 'undo'],
            [RedoCommand, 'redo'],
          ] as const)
            subscriptions.current.push(
              command.addImplementation(10000, `blode-${direction}-${instance.getId()}`, () => {
                if (!instance.hasTextFocus() && !instance.hasWidgetFocus()) return false;
                if (latest.current.readOnly || externalSourceForUri(instance.getModel()?.uri.path ?? ''))
                  return Promise.resolve();
                if (window.__blodeWeb !== true && !latest.current.onUndo) return false;
                return runUndo(direction);
              }),
            );
          subscriptions.current.push(
            instance.onDidChangeModelContent(() => {
              const model = instance.getModel();
              if (!model) return;
              const after = model.getValue(),
                before = modelTexts.get(model) ?? after;
              modelTexts.set(model, after);
              if (
                externalModelIsRefreshing(model) ||
                latest.current.readOnly ||
                externalSourceForUri(model.uri.path)
              ) {
                undoHistories.delete(model);
                return;
              }
              if (ownUndoModels.has(model) || before === after) return;
              let history = undoHistories.get(model);
              if (!history) {
                history = new LocalUndoHistory();
                undoHistories.set(model, history);
              }
              const changes = textChanges(before, after);
              if (changes.length) history.record(before, changes, !remoteModels.has(model));
            }),
          );
          const reportView = () => {
            if (applyingRemote.current) return;
            if (
              instance.getModel()?.uri.toString() !==
              modelUri(latest.current.projectRoot, latest.current.path)
            )
              return;
            if (!latest.current.primary && !instance.hasTextFocus() && !instance.hasWidgetFocus()) return;
            const ranges = instance.getVisibleRanges(),
              position = instance.getPosition();
            latest.current.onPresence?.({
              path: latest.current.path,
              startLine: ranges[0]?.startLineNumber ?? 1,
              endLine: ranges.at(-1)?.endLineNumber ?? 1,
              cursor: position ? { line: position.lineNumber, column: position.column } : undefined,
            });
          };
          let restoredFrame: number | undefined;
          const attentionRestored = () => {
            if (restoredFrame !== undefined) cancelAnimationFrame(restoredFrame);
            restoredFrame = requestAnimationFrame(() => {
              restoredFrame = undefined;
              if (editor.current === instance) reportView();
            });
          };
          window.addEventListener('blode:attention-restored', attentionRestored);
          subscriptions.current.push({
            dispose() {
              window.removeEventListener('blode:attention-restored', attentionRestored);
              if (restoredFrame !== undefined) cancelAnimationFrame(restoredFrame);
            },
          });
          subscriptions.current.push(
            instance.onDidScrollChange(reportView),
            instance.onDidChangeCursorPosition(reportView),
            instance.onDidFocusEditorText(reportView),
            instance.onDidFocusEditorText(() => {
              lastFocusedEditor = instance;
            }),
            instance.onDidChangeModel(() => {
              const model = instance.getModel();
              if (model) ownedModels.add(model.uri.toString());
              if (model && !modelTexts.has(model)) modelTexts.set(model, model.getValue());
              synchronizeValue();
              scheduleNavigation();
              decoratePeers(false);
              reportView();
            }),
          );
          synchronizeValue();
          scheduleNavigation();
          decoratePeers(false);
          if (latest.current.primary) {
            const visible = instance.getVisibleRanges();
            latest.current.onPresence?.({
              path: latest.current.path,
              startLine: visible[0]?.startLineNumber ?? 1,
              endLine: visible.at(-1)?.endLineNumber ?? 1,
            });
          }
          report(instance.getPosition() ?? new monaco.Position(1, 1));
        }}
        loading={<EditorLoading value={value} />}
        onChange={(value) => {
          const model = editor.current?.getModel();
          if (
            latest.current.readOnly ||
            (model && (externalModelIsRefreshing(model) || externalSourceForUri(model.uri.path)))
          )
            return;
          if (!applyingRemote.current && (!model || !remoteModels.has(model))) onChange(value ?? '');
        }}
        options={{
          readOnly,
          gotoLocation: { multipleDefinitions: 'peek', multipleDeclarations: 'peek' },
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
          inlineSuggest: { enabled: true },
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
      {predictionFeedback.kind !== 'idle' && predictionFeedback.message && (
        <div
          className="ai-prediction-feedback"
          role={predictionFeedback.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          data-state={predictionFeedback.kind}
          style={{
            position: 'absolute',
            right: 18,
            bottom: 7,
            maxWidth: 'calc(100% - 36px)',
            padding: '4px 8px',
            borderRadius: 5,
            fontSize: 12,
            color:
              predictionFeedback.kind === 'error'
                ? 'var(--danger, #dc2626)'
                : 'var(--text-secondary, #64748b)',
            background: 'var(--surface-1, #fff)',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          {t(predictionFeedback.message)}
        </div>
      )}
    </div>
  );
}
