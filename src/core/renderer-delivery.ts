import type { BrowserWindow, WebContents, WebFrameMain } from 'electron';

export function currentRendererFrame(contents: WebContents): WebFrameMain | undefined {
  try {
    if (contents.isDestroyed()) return;
    const frame = contents.mainFrame;
    if (!frame || frame.detached || frame.isDestroyed()) return;
    return frame;
  } catch {
    // Electron can dispose the native frame before destroying WebContents.
    return;
  }
}

/** Avoid WebContents.send's warning when a live contents has lost its native frame. */
export function sendToRenderer(
  window: Pick<BrowserWindow, 'isDestroyed' | 'webContents'> | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!window || window.isDestroyed()) return false;
  const frame = currentRendererFrame(window.webContents);
  if (!frame) return false;
  try {
    frame.send(channel, ...args);
    return true;
  } catch (error) {
    if (currentRendererFrame(window.webContents) !== frame) return false;
    throw error;
  }
}
