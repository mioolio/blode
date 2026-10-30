import type { PortInfo, ProjectConfig } from '../../shared/contracts';
import { useI18n } from '../i18n';
import { ModernSelect } from './ModernSelect';
import { RefreshCw } from 'lucide-react';

export function DebuggerUartSettings({
  options,
  ports,
  disabled,
  onChange,
  onRefresh,
}: {
  options: ProjectConfig['debugger'];
  ports: PortInfo[];
  disabled: boolean;
  onChange: (options: Partial<NonNullable<ProjectConfig['debugger']>>) => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const port = ports.some((item) => item.path === options?.port) ? (options?.port ?? '') : '';
  return (
    <>
      <label>
        <span>{t('debugger.uart.port')}</span>
        <ModernSelect
          value={port}
          disabled={disabled}
          onChange={(event) => onChange({ port: event.target.value })}
        >
          <option value="">{t('debugger.uart.selectPort')}</option>
          {ports.map((item) => (
            <option value={item.path} key={item.path}>
              {item.path}
              {item.manufacturer ? ` · ${item.manufacturer}` : ''}
            </option>
          ))}
        </ModernSelect>
      </label>
      <button disabled={disabled} onClick={onRefresh}>
        <RefreshCw size={13} />
        {t('action.refresh')}
      </button>
      <label className="debug-frequency">
        <span>{t('debugger.uart.baudRate')}</span>
        <input
          type="number"
          min={1200}
          max={3000000}
          value={options?.baudRate ?? 115200}
          disabled={disabled}
          onChange={(event) => onChange({ baudRate: Number(event.target.value) })}
        />
      </label>
      <label>
        <span>{t('debugger.uart.stubMode')}</span>
        <ModernSelect
          value={options?.stubMode ?? 'runtime'}
          disabled={disabled}
          onChange={(event) => onChange({ stubMode: event.target.value as 'runtime' | 'panic' })}
        >
          <option value="runtime">{t('debugger.uart.runtime')}</option>
          <option value="panic">{t('debugger.uart.panic')}</option>
        </ModernSelect>
      </label>
    </>
  );
}
