import type { DesktopApi } from '../shared/contracts';
declare global {
  interface Window {
    blode: DesktopApi;
    /** Set by the browser bridge; absent in the Electron renderer. */
    __blodeWeb?: boolean;
  }
}
export {};
