import { useEffect, useRef } from 'react';
import type { Studio } from './useStudio';
import type { UiRequest } from '../../shared/workbench';
import { useI18n } from '../i18n';
import { workspaceCloseGate } from './workspaceCloseGate';
import { workspaceFileView } from '../../shared/file-views';

/** One renderer acknowledges each explicitly targeted, named AI UI command. */
export function useAutomationCommands(studio: Studio) {
  const { setLocale } = useI18n();
  const current = useRef(studio);
  current.current = studio;
  const clientId = useRef(
    studio.isWeb
      ? `web:${globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`}`
      : 'desktop',
  );
  useEffect(() => {
    if (!window.blode.onUiCommand) return;
    return window.blode.onUiCommand((request: UiRequest) => {
      if (request.target !== clientId.current) return;
      const apply = async () => {
        if (workspaceCloseGate.isFrozen()) throw new Error('error.shutdownInProgress');
        const view = current.current;
        if (view.busy && !['console', 'consolePanel', 'devicePanel', 'runtimeView'].includes(request.action))
          throw new Error('error.busy');
        const path = () => {
          if (!request.path || !workspaceFileView(view.state, request.path))
            throw new Error('rpc.fileNotFound');
          return request.path;
        };
        switch (request.action) {
          case 'runtimeView':
            if (!request.pluginId || !request.viewId) throw new Error('rpc.invalidParams');
            window.dispatchEvent(
              new CustomEvent('blode:runtime-view-request', {
                detail: { pluginId: request.pluginId, viewId: request.viewId },
              }),
            );
            break;
          case 'home':
            view.goHome();
            break;
          case 'project':
            view.returnToProject();
            break;
          case 'view':
            if (!request.view) throw new Error('rpc.invalidParams');
            view.setView(request.view);
            break;
          case 'openFile':
            view.openFile(path());
            break;
          case 'pinFile':
            view.pinFile(path());
            break;
          case 'closeFile':
            if (!(await view.closeTab('file', path()))) throw new Error('error.uiActionFailed');
            break;
          case 'preferences':
            window.dispatchEvent(new CustomEvent('blode:preferences'));
            break;
          case 'save':
            if (!(await view.save())) throw new Error('error.uiActionFailed');
            break;
          case 'console':
            if (!request.tab) throw new Error('rpc.invalidParams');
            view.setTab(request.tab);
            break;
          case 'consolePanel':
            if (request.visible === undefined) throw new Error('rpc.invalidParams');
            view.setConsolePanelVisible(request.visible);
            break;
          case 'devicePanel':
            if (request.visible === undefined) throw new Error('rpc.invalidParams');
            view.setDevicePanelVisible(request.visible);
            break;
          case 'editor':
            if (!request.command) throw new Error('rpc.invalidParams');
            view.editorCommand(request.command);
            break;
          case 'splitEditor':
            window.dispatchEvent(new CustomEvent('blode:split-editor'));
            break;
          case 'language':
            if (!request.language) throw new Error('rpc.invalidParams');
            setLocale(request.language);
            break;
          case 'syncDrafts':
            if (request.visible === undefined) throw new Error('rpc.invalidParams');
            view.setSyncDrafts(request.visible);
            break;
          case 'clearLogs':
            view.setLogs([]);
            break;
        }
      };
      void apply()
        .then(
          () => window.blode.uiCommandReply({ id: request.id, clientId: clientId.current }),
          (error) =>
            window.blode.uiCommandReply({
              id: request.id,
              clientId: clientId.current,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
        .catch(() => {});
    });
  }, [setLocale]);
  useEffect(() => {
    if (!window.blode.uiPublishState) return;
    const publish = () => {
      const view = current.current;
      return window.blode
        .uiPublishState({
          clientId: clientId.current,
          browser: view.isWeb,
          projectRoot: view.state?.projectRoot ?? '',
          activePath: view.activePath,
          openFiles: view.openFiles,
          view: view.view,
          home: view.showHome,
          dirtyFiles: Object.keys(view.drafts),
          busy: view.busy,
          consolePanelVisible: view.consolePanelVisible,
          devicePanelVisible: view.devicePanelVisible,
        })
        .catch(() => {});
    };
    void publish();
    const timer = setInterval(() => void publish(), 20_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!window.blode.uiPublishState) return;
    const timer = setTimeout(() => {
      const view = current.current;
      void window.blode
        .uiPublishState({
          clientId: clientId.current,
          browser: view.isWeb,
          projectRoot: view.state?.projectRoot ?? '',
          activePath: view.activePath,
          openFiles: view.openFiles,
          view: view.view,
          home: view.showHome,
          dirtyFiles: Object.keys(view.drafts),
          busy: view.busy,
          consolePanelVisible: view.consolePanelVisible,
          devicePanelVisible: view.devicePanelVisible,
        })
        .catch(() => {});
    }, 100);
    return () => clearTimeout(timer);
  }, [
    studio.activePath,
    studio.openFiles,
    studio.view,
    studio.showHome,
    Object.keys(studio.drafts).join('\0'),
    studio.busy,
    studio.consolePanelVisible,
    studio.devicePanelVisible,
    studio.state?.projectRoot,
  ]);
}
