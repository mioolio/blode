import { ModernSelect } from './ModernSelect';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  CircleAlert,
  CircleCheck,
  Gauge,
  LoaderCircle,
  PlugZap,
  Send,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  Unplug,
  Usb,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import type { SerialOptions } from '../../shared/contracts';
import { iconButton } from './IconButton';
import { TerminalPanel } from './TerminalPanel';
import { RuntimePluginView } from './RuntimePluginView';
const GeneralExtensionView = lazy(() =>
  import('../extensions/GeneralExtensionView').then((module) => ({ default: module.GeneralExtensionView })),
);
import { extensionLabel, useGeneralExtensions } from '../extensions/ShellAppearance';
import { generalExtensionPanelKey } from '../../shared/general-extensions';
import { registeredRuntimeViews } from '../../shared/runtime-views';
import { workspaceConsoleTabs } from '../../shared/workspace-surfaces';
import { MemoryUsage } from './MemoryUsage';
import { ContextHelp } from './ContextHelp';
import { LogScrollController } from '../workspace/logScroll';
import './runtime-surfaces.css';
import './resource-panel.css';

/** ConsolePanel renders one workspace surface; application actions stay in useStudio. */
export function ConsolePanel({ studio }: { studio: Studio }) {
  const {
    t,
    locale,
    tab,
    setTab,
    logs: allLogs,
    setLogs,
    busy,
    errors,
    warnings,
    config,
    setConfig,
    state,
    serialBaud,
    setSerialBaud,
    serialOptions,
    setSerialOptions,
    serialConnected,
    serialToggle,
    logEnd,
    perform,
    serialInput,
    setSerialInput,
  } = studio;
  const logs = allLogs.filter((log) => log.kind !== 'terminal' && !!log.message);
  const logRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const logScroll = useRef(new LogScrollController());
  const baudRatesId = useId();
  const [encoding, setEncoding] = useState<'utf8' | 'hex'>('utf8');
  const [lineEnding, setLineEnding] = useState<'none' | 'lf' | 'cr' | 'crlf'>('lf');
  const pluginViews = registeredRuntimeViews(state?.runtimePlugins?.plugins ?? []).filter(
    (view) => view.location === 'panel',
  );
  const pluginView = pluginViews.find((view) => view.key === tab);
  const extensions = useGeneralExtensions();
  const extensionPanels = (extensions.data?.plugins ?? [])
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) =>
      (plugin.manifest.ui.views ?? [])
        .filter((view) => view.location === 'panel')
        .map((view) => ({ key: generalExtensionPanelKey(plugin.id, view.id), plugin, view })),
    );
  const extensionPanel = extensionPanels.find((panel) => panel.key === tab);
  const memoryVisible = ![
    ...(studio.board?.runtimePlugin?.ui.hiddenCapabilities ?? []),
    ...(config?.runtime?.disabledCapabilities ?? []),
  ].includes('layout');
  const resourceTab = tab === 'resources';
  useEffect(() => {
    const open = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      if (pluginViews.some((view) => view.key === key)) setTab(key as `plugin:${string}`);
    };
    window.addEventListener('blode:runtime-panel', open);
    return () => window.removeEventListener('blode:runtime-panel', open);
  }, [pluginViews.map((view) => view.key).join('|')]);
  useEffect(() => {
    const open = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      if (extensionPanels.some((panel) => panel.key === key)) {
        studio.setConsolePanelVisible(true);
        setTab(key as `plugin:${string}`);
      }
    };
    window.addEventListener('blode:extension-panel', open);
    return () => window.removeEventListener('blode:extension-panel', open);
  }, [extensionPanels.map((panel) => panel.key).join('|')]);
  useEffect(() => {
    if (tab.startsWith('plugin:') && !pluginView && !extensionPanel) setTab('output');
  }, [tab, !!pluginView, !!extensionPanel]);
  useEffect(() => {
    if (resourceTab && !state?.workspaceOpen) setTab('output');
  }, [resourceTab, state?.workspaceOpen, memoryVisible, tab]);
  useEffect(() => {
    const strip = tabsRef.current;
    const selected = strip?.querySelector('.active');
    if (!strip || !selected || !studio.consolePanelVisible) return;
    const bounds = strip.getBoundingClientRect();
    const active = selected.getBoundingClientRect();
    const delta =
      active.left < bounds.left
        ? active.left - bounds.left
        : active.right > bounds.right
          ? active.right - bounds.right
          : 0;
    if (delta)
      strip.scrollBy({
        left: delta,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
  }, [tab, studio.consolePanelVisible]);
  const visibleLogs =
    tab === 'serial'
      ? logs.filter((log) => log.kind === 'serial')
      : tab === 'problems'
        ? errors
        : tab === 'warnings'
          ? warnings
          : logs.filter((log) => log.kind !== 'serial');
  useLayoutEffect(() => {
    logScroll.current.update(tab, logRef.current, studio.consolePanelVisible);
  }, [visibleLogs, tab, studio.consolePanelVisible]);
  useLayoutEffect(() => {
    const element = logRef.current;
    if (!element || !studio.consolePanelVisible) return;
    const resize = new ResizeObserver(() => logScroll.current.update(tab, element, true));
    resize.observe(element);
    return () => resize.disconnect();
  }, [tab, studio.consolePanelVisible]);
  // Ctrl+A inside the console selects the visible log text, never the whole window.
  const selectLogText = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
    const log = logRef.current;
    if (!log) return;
    event.preventDefault();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(log);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const tabIcons = {
    output: SquareTerminal,
    serial: Usb,
    problems: CircleAlert,
    warnings: TriangleAlert,
    terminal: SquareTerminal,
    resources: Gauge,
  };
  const tabs = workspaceConsoleTabs
    .filter((id) => state?.workspaceOpen || id !== 'resources')
    .map((id) => ({ id, icon: tabIcons[id] }));
  const emptyIcon =
    tab === 'serial' ? (
      <Usb size={26} strokeWidth={1.3} />
    ) : tab === 'problems' ? (
      <CircleCheck size={26} strokeWidth={1.3} />
    ) : (
      <SquareTerminal size={26} strokeWidth={1.3} />
    );
  return (
    <section className="console-panel" hidden={!studio.consolePanelVisible} onKeyDown={selectLogText}>
      <div className="console-header">
        <div className="console-tabs" ref={tabsRef}>
          {tabs.map(({ id, icon: Icon }) => (
            <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)} key={id}>
              <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
              {t(`console.${id}`)}
              {id === 'problems' && <span className="count-badge">{errors.length}</span>}
              {id === 'warnings' && <span className="count-badge">{warnings.length}</span>}
            </button>
          ))}
          {pluginViews.map((view) => (
            <button
              key={view.key}
              className={tab === view.key ? 'active' : ''}
              onClick={() => setTab(view.key as `plugin:${string}`)}
            >
              {view.label}
            </button>
          ))}
          {extensionPanels.map((panel) => (
            <button
              key={panel.key}
              className={tab === panel.key ? 'active' : ''}
              onClick={() => setTab(panel.key)}
            >
              {extensionLabel(panel.plugin, panel.view.label, panel.view.label, locale)}
            </button>
          ))}
        </div>
        <div className="console-tools">
          {busy && (
            <span className="busy-label">
              <LoaderCircle className="spin" size={12} aria-hidden="true" />
              {t(busy)}
            </span>
          )}
          {tab !== 'terminal' &&
            !resourceTab &&
            !pluginView &&
            !extensionPanel &&
            iconButton(
              'action.clear',
              () =>
                setLogs((current) =>
                  current.filter((log) => (tab === 'serial' ? log.kind !== 'serial' : log.kind === 'serial')),
                ),
              <Trash2 size={13} strokeWidth={1.8} />,
            )}
          {iconButton(
            'view.hideConsolePanel',
            () => studio.setConsolePanelVisible(false),
            <X size={14} strokeWidth={1.9} aria-hidden="true" />,
          )}
        </div>
      </div>
      <TerminalPanel visible={tab === 'terminal' && studio.consolePanelVisible} />
      {resourceTab && state?.workspaceOpen && (
        <div className={`console-resource-view resource-view-${tab}`} tabIndex={0}>
          <MemoryUsage
            state={state}
            config={config}
            drafts={studio.drafts}
            stale={studio.stale || studio.dirty || studio.configDirty}
            section={memoryVisible ? 'all' : 'project'}
          />
        </div>
      )}
      {pluginView && (
        <div className="console-plugin-view">
          <RuntimePluginView key={pluginView.key} id={pluginView.pluginId} kind={`view:${pluginView.id}`} />
        </div>
      )}
      {extensionPanel && (
        <div className="console-plugin-view">
          <Suspense fallback={null}>
            <GeneralExtensionView id={extensionPanel.plugin.id} view={extensionPanel.view.id} />
          </Suspense>
        </div>
      )}
      {tab === 'serial' && (
        <>
          <div className="serial-toolbar">
            <div className="serial-port">
              <Usb size={13} strokeWidth={1.8} aria-hidden="true" />
              <ModernSelect
                aria-label={t('console.serialDevice')}
                title={t('console.serialDevice')}
                value={
                  state?.ports.some((port) => port.path === config?.port) ||
                  (state?.connections?.serial.open && state.connections.serial.port === config?.port)
                    ? (config?.port ?? '')
                    : ''
                }
                disabled={serialConnected || !!busy || !config}
                onChange={(event) => {
                  if (config) setConfig({ ...config, port: event.target.value });
                }}
              >
                <option value="">{t('device.selectPort')}</option>
                {state?.connections?.serial.open &&
                  !state.ports.some((port) => port.path === state.connections!.serial.port) && (
                    <option value={state.connections.serial.port}>
                      {state.connections.serial.port} · {t('status.serialConnected')}
                    </option>
                  )}
                {(state?.ports ?? []).map((port) => (
                  <option key={port.path} value={port.path}>
                    {port.path}
                    {port.manufacturer ? ` — ${port.manufacturer}` : ''}
                  </option>
                ))}
              </ModernSelect>
            </div>
            <input
              className="serial-baud"
              type="number"
              min={110}
              max={4000000}
              step={1}
              list={baudRatesId}
              aria-label={t('console.baud')}
              title={t('console.customBaud')}
              value={serialBaud}
              disabled={serialConnected}
              onChange={(e) => setSerialBaud(Number(e.target.value))}
            />
            <datalist id={baudRatesId}>
              {[
                110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800,
                921600, 1000000, 2000000, 3000000, 4000000,
              ].map((rate) => (
                <option key={rate} value={rate} />
              ))}
            </datalist>
            <button className="text-button serial-toggle" onClick={serialToggle} disabled={!!busy}>
              {serialConnected ? (
                <Unplug size={13} strokeWidth={1.8} />
              ) : (
                <PlugZap size={13} strokeWidth={1.8} />
              )}
              {t(serialConnected ? 'action.disconnect' : 'action.connect')}
            </button>
            <ContextHelp
              title={t('console.serialOptions')}
              icon={<SlidersHorizontal size={14} aria-hidden="true" />}
            >
              <div className="serial-settings-grid">
                <label>
                  {t('console.dataBits')}{' '}
                  <ModernSelect
                    value={serialOptions?.dataBits ?? 8}
                    disabled={serialConnected || !!busy}
                    onChange={(event) =>
                      setSerialOptions((current) => ({
                        ...current,
                        dataBits: Number(event.target.value) as SerialOptions['dataBits'],
                      }))
                    }
                  >
                    {[5, 6, 7, 8].map((bits) => (
                      <option key={bits} value={bits}>
                        {bits}
                      </option>
                    ))}
                  </ModernSelect>
                </label>
                <label>
                  {t('console.parity')}{' '}
                  <ModernSelect
                    value={serialOptions?.parity ?? 'none'}
                    disabled={serialConnected || !!busy}
                    onChange={(event) =>
                      setSerialOptions((current) => ({
                        ...current,
                        parity: event.target.value as SerialOptions['parity'],
                      }))
                    }
                  >
                    {(['none', 'even', 'odd', 'mark', 'space'] as const).map((parity) => (
                      <option key={parity} value={parity}>
                        {t(`console.parity.${parity}`)}
                      </option>
                    ))}
                  </ModernSelect>
                </label>
                <label>
                  {t('console.stopBits')}{' '}
                  <ModernSelect
                    value={serialOptions?.stopBits ?? 1}
                    disabled={serialConnected || !!busy}
                    onChange={(event) =>
                      setSerialOptions((current) => ({
                        ...current,
                        stopBits: Number(event.target.value) as SerialOptions['stopBits'],
                      }))
                    }
                  >
                    {[1, 1.5, 2].map((bits) => (
                      <option key={bits} value={bits}>
                        {bits}
                      </option>
                    ))}
                  </ModernSelect>
                </label>
                <label>
                  {t('console.flowControl')}{' '}
                  <ModernSelect
                    value={serialOptions?.flowControl ?? 'none'}
                    disabled={serialConnected || !!busy}
                    onChange={(event) =>
                      setSerialOptions((current) => ({
                        ...current,
                        flowControl: event.target.value as SerialOptions['flowControl'],
                      }))
                    }
                  >
                    <option value="none">{t('console.flow.none')}</option>
                    <option value="rtscts">RTS/CTS</option>
                    <option value="xonxoff">XON/XOFF</option>
                  </ModernSelect>
                </label>
              </div>
            </ContextHelp>
          </div>
        </>
      )}
      {tab !== 'terminal' && !resourceTab && !pluginView && !extensionPanel && (
        <div
          className="log-scroll"
          ref={logRef}
          tabIndex={0}
          role="log"
          aria-label={t(`console.${tab}`)}
          onMouseDown={() => logRef.current?.focus({ preventScroll: true })}
          onScroll={(event) => logScroll.current.remember(tab, event.currentTarget)}
        >
          <div className="log-content">
            {visibleLogs.map((log, index) => (
              <div className={`log-line ${log.level}`} key={`${log.time}-${index}`}>
                <time>{new Date(log.time).toLocaleTimeString(locale, { hour12: false })}</time>
                <span className="log-marker">
                  {log.level === 'error' ? '×' : log.level === 'success' ? '✓' : '›'}
                </span>
                <pre>{t(log.message)}</pre>
              </div>
            ))}
            {!visibleLogs.length && (
              <div className="console-empty">
                <span className="console-empty-icon">{emptyIcon}</span>
                <span>
                  {t(
                    tab === 'serial'
                      ? 'console.serialEmpty'
                      : tab === 'problems'
                        ? 'console.noProblems'
                        : tab === 'warnings'
                          ? 'console.noWarnings'
                          : 'console.empty',
                  )}
                </span>
              </div>
            )}
            <div ref={logEnd} />
          </div>
        </div>
      )}
      {tab === 'serial' && (
        <form
          className="serial-input"
          onSubmit={(event) => {
            event.preventDefault();
            void perform('action.send', async () => {
              const suffix =
                lineEnding === 'crlf' ? '\r\n' : lineEnding === 'lf' ? '\n' : lineEnding === 'cr' ? '\r' : '';
              await window.blode.serialWrite(
                encoding === 'hex' ? serialInput : serialInput + suffix,
                encoding,
              );
              setSerialInput('');
            });
          }}
        >
          <div className="serial-send-options">
            <ModernSelect
              aria-label={t('console.encoding')}
              value={encoding}
              onChange={(event) => setEncoding(event.target.value as 'utf8' | 'hex')}
            >
              <option value="utf8">UTF-8</option>
              <option value="hex">HEX</option>
            </ModernSelect>
            <ModernSelect
              aria-label={t('console.lineEnding')}
              value={lineEnding}
              disabled={encoding === 'hex'}
              onChange={(event) => setLineEnding(event.target.value as 'none' | 'lf' | 'cr' | 'crlf')}
            >
              <option value="none">{t('console.noLineEnding')}</option>
              <option value="lf">LF</option>
              <option value="cr">CR</option>
              <option value="crlf">CRLF</option>
            </ModernSelect>
          </div>
          <input
            aria-label={t('console.serialInput')}
            placeholder={t('console.serialInput')}
            value={serialInput}
            onChange={(e) => setSerialInput(e.target.value)}
            disabled={!serialConnected}
          />
          <button type="submit" disabled={!serialConnected || !!busy}>
            {t('action.send')}
            <Send size={12} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </form>
      )}
    </section>
  );
}
