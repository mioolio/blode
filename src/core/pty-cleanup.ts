import type { IPty } from 'node-pty';

const released = new WeakSet<IPty>();

/** node-pty may close ConPTY before its asynchronous console-list helper attaches.
 * The host has already terminated its owned process tree (or received onExit), so
 * skip that redundant enumeration and use the package's public resource cleanup.
 * Keep this compatibility shim local to closed PTYs; never patch child_process.
 */
export function releasePty(pty: IPty) {
  if (released.has(pty)) return;
  released.add(pty);
  if (process.platform === 'win32') {
    const agent = (pty as IPty & { _agent?: { _getConsoleProcessList?: () => Promise<number[]> } })._agent;
    if (typeof agent?._getConsoleProcessList === 'function') agent._getConsoleProcessList = async () => [];
  }
  try {
    pty.kill();
  } catch {
    /* The process/console may already be closed. */
  }
}
