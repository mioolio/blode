import type { DebuggerState, ProjectConfig } from '../../shared/contracts';
import { useI18n } from '../i18n';
import type { DebuggerPresentation } from './debuggerProfiles';

type ToolPath = 'gdbPath' | 'serverPath' | 'scriptsPath';

export function DebuggerToolsPanel({
  profile,
  tools,
  checking,
  disabled,
  web,
  paths,
  onChange,
  onCheck,
  onChooseGdb,
  onInstall,
}: {
  profile?: DebuggerPresentation;
  tools?: DebuggerState['tools'];
  checking: boolean;
  disabled: boolean;
  web: boolean;
  paths?: ProjectConfig['debugger'];
  onChange: (key: ToolPath, value: string) => void;
  onCheck: () => void;
  onChooseGdb: () => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const labels = profile?.tools;
  const rows = [
    { name: labels?.gdbName ?? 'GDB', found: tools?.gdb, path: tools?.paths?.gdb },
    ...(labels?.serverRequired !== false
      ? [
          {
            name: labels?.serverName ?? t('debugger.serverPath'),
            found: tools?.paths ? !!tools.paths.server : tools?.server,
            path: tools?.paths?.server,
          },
        ]
      : []),
    ...(labels?.scripts
      ? [
          {
            name: t('debugger.scriptsPath'),
            found: tools?.paths ? !!tools.paths.scripts : tools?.server,
            path: tools?.paths?.scripts,
          },
        ]
      : []),
  ];
  return (
    <>
      <div role="status" aria-live="polite" aria-busy={checking}>
        {rows.map((row) => (
          <div className="debug-tool-row" key={row.name}>
            <span>{row.name}</span>
            <span title={!checking ? (row.path ?? undefined) : undefined}>
              {t(
                checking
                  ? 'debugger.toolChecking'
                  : row.found === undefined
                    ? 'debugger.toolUnchecked'
                    : row.found
                      ? 'debugger.toolReady'
                      : 'debugger.toolMissing',
              )}
            </span>
          </div>
        ))}
      </div>
      {(
        [
          'gdbPath',
          ...(labels?.serverRequired !== false ? (['serverPath'] as const) : []),
          ...(labels?.scripts ? (['scriptsPath'] as const) : []),
        ] as const
      ).map((key) => (
        <label className="debug-dialog-field" key={key}>
          {t(`debugger.${key}`)}
          <input
            value={paths?.[key] ?? ''}
            placeholder={t('debugger.managedPath')}
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => onChange(key, event.target.value)}
          />
        </label>
      ))}
      <div className="debug-dialog-actions">
        <button disabled={disabled} onClick={onCheck}>
          {t('debugger.discoverTools')}
        </button>
        {!web && (
          <button disabled={disabled} onClick={onChooseGdb}>
            {t('debugger.chooseGdb')}
          </button>
        )}
        <button className="primary" disabled={disabled || !profile} onClick={onInstall}>
          {t(labels?.installKey ?? 'debugger.installTools')}
        </button>
      </div>
    </>
  );
}
