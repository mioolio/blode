import { promises as fs } from 'node:fs';
import * as z from 'zod';
import type { BrowserWindow, Event, Input } from 'electron';

const debugSchema = z
  .object({
    enabled: z.boolean().default(true),
    openDevToolsOnStart: z.boolean().default(false),
  })
  .strict();

const webSchema = z
  .object({
    enabled: z.boolean().default(true),
    allowExternal: z.boolean().default(false),
  })
  .strict();

const applicationSchema = z
  .object({
    debug: debugSchema.default(() => ({ enabled: true, openDevToolsOnStart: false })),
    web: webSchema.default(() => ({ enabled: true, allowExternal: false })),
  })
  .strict();

export type ApplicationConfig = z.infer<typeof applicationSchema>;
export type DebugConfig = ApplicationConfig['debug'];
export type DebugShortcut = 'toggleDevTools' | 'reload' | 'reloadIgnoringCache';
export type DebugShortcutInput = Pick<Input, 'type' | 'key'> &
  Partial<Pick<Input, 'control' | 'shift' | 'alt' | 'meta' | 'isAutoRepeat'>>;

/** Missing config uses documented defaults; malformed config must never be silently ignored. */
export async function loadAppConfig(configPath: string): Promise<ApplicationConfig> {
  let source: string;
  try {
    source = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return applicationSchema.parse({});
    throw error;
  }
  try {
    return applicationSchema.parse(JSON.parse(source));
  } catch (cause) {
    throw new Error('error.invalidApplicationConfig', { cause });
  }
}

/** Pure mapping, shared with tests; unrelated editor shortcuts remain untouched. */
export function classifyDebugShortcut(config: DebugConfig, input: DebugShortcutInput): DebugShortcut | null {
  if (!config.enabled || input.type !== 'keyDown' || input.isAutoRepeat || input.alt || input.meta)
    return null;
  const key = input.key.toLowerCase();
  if (key === 'f12' && !input.control && !input.shift) return 'toggleDevTools';
  if (key === 'f5' && !input.shift) return input.control ? 'reloadIgnoringCache' : 'reload';
  if (key === 'r' && input.control) return input.shift ? 'reloadIgnoringCache' : 'reload';
  return null;
}

/** Main must gate enabled with !app.isPackaged before installing these controls. */
export function installDebugControls(window: BrowserWindow, config: DebugConfig): () => void {
  if (!config.enabled) return () => {};
  const contents = window.webContents;
  let disposed = false;
  const onInput = (event: Event, input: Input) => {
    if (disposed || window.isDestroyed() || contents.isDestroyed()) return;
    const shortcut = classifyDebugShortcut(config, input);
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === 'toggleDevTools') contents.toggleDevTools();
    else if (shortcut === 'reloadIgnoringCache') contents.reloadIgnoringCache();
    else contents.reload();
  };
  const openDevTools = () => {
    if (!disposed && !window.isDestroyed() && !contents.isDestroyed())
      contents.openDevTools({ mode: 'detach' });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    contents.removeListener('before-input-event', onInput);
    contents.removeListener('did-finish-load', openDevTools);
    window.removeListener('closed', dispose);
  };
  contents.on('before-input-event', onInput);
  if (config.openDevToolsOnStart) contents.once('did-finish-load', openDevTools);
  window.once('closed', dispose);
  return dispose;
}
