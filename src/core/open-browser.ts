import { spawn } from 'node:child_process';

/** The command used to hand a private launch link to the user's default browser. */
export function browserLaunch(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Open the launch link without blocking the host. A missing browser must never
 * stop the service: the printed link remains the supported fallback.
 */
export function openBrowser(url: string): void {
  const { command, args } = browserLaunch(process.platform, url);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* The terminal link is still valid when no default browser is registered. */
  }
}
