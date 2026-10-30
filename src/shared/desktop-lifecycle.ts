export type AppCloseDecision = 'clean' | 'saved' | 'discard' | 'cancel';
export interface AppCloseRequest {
  id: string;
  sharedDirty: boolean;
  lifecycleId?: string;
  phase?: 'commit';
  decision?: Exclude<AppCloseDecision, 'cancel'>;
  cancelled?: boolean;
  error?: string;
}
export interface DesktopLifecycleState {
  closeToTray: boolean;
  locale: 'zh-CN' | 'en';
  available: boolean;
  quitting: boolean;
  lifecycleId?: string;
  pendingClose?: AppCloseRequest;
  error?: string;
}
export interface DesktopLifecycleApi {
  desktopLifecycleState(): Promise<DesktopLifecycleState>;
  desktopLifecycleConfigure(request: {
    closeToTray: boolean;
    locale?: 'zh-CN' | 'en';
  }): Promise<DesktopLifecycleState>;
  desktopCloseReply(request: {
    id: string;
    decision: AppCloseDecision | 'committed' | 'commitFailed';
    error?: string;
  }): Promise<void>;
  onAppCloseRequest(callback: (request: AppCloseRequest) => void): () => void;
}
export const APP_CLOSE_REQUEST_CHANNEL = 'blode:app-close-request';
