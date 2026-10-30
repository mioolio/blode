import type { ProjectConfig } from '../../shared/contracts';
import type { RuntimePluginManifest } from '../../shared/plugins';
import { useI18n } from '../i18n';
import { ModernSelect } from './ModernSelect';
import './runtime-device-fields.css';

export function RuntimeDeviceFields({
  plugin,
  config,
  disabled,
  onChange,
}: {
  plugin: RuntimePluginManifest;
  config: ProjectConfig;
  disabled: boolean;
  onChange: (value: ProjectConfig) => void;
}) {
  const { t } = useI18n();
  const update = (id: string, value: string | number | boolean) =>
    onChange({
      ...config,
      runtime: { ...config.runtime, values: { ...config.runtime?.values, [id]: value } },
    });
  return (
    <div className="runtime-device-fields">
      {['usb', 'physical', 'custom'].includes(plugin.transport) && (
        <label>
          {t('runtime.deviceId')}
          <input
            disabled={disabled}
            value={config.runtime?.deviceId ?? ''}
            onChange={(event) =>
              onChange({ ...config, runtime: { ...config.runtime, deviceId: event.target.value } })
            }
          />
        </label>
      )}
      {plugin.ui.fields.map((field) => {
        const value =
          config.runtime?.values?.[field.id] ?? field.default ?? (field.type === 'boolean' ? false : '');
        return (
          <label key={field.id} className={field.type === 'boolean' ? 'runtime-boolean' : ''}>
            {field.type === 'boolean' ? (
              <>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={value === true}
                  onChange={(event) => update(field.id, event.target.checked)}
                />
                {field.label}
              </>
            ) : (
              <>
                {field.label}
                {field.type === 'select' ? (
                  <ModernSelect
                    aria-label={field.label}
                    disabled={disabled}
                    value={String(value)}
                    onChange={(event) => update(field.id, event.target.value)}
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </ModernSelect>
                ) : (
                  <input
                    aria-label={field.label}
                    disabled={disabled}
                    type={field.type === 'number' ? 'number' : 'text'}
                    min={field.min}
                    max={field.max}
                    value={String(value)}
                    onChange={(event) =>
                      update(
                        field.id,
                        field.type === 'number' ? Number(event.target.value) : event.target.value,
                      )
                    }
                  />
                )}
              </>
            )}
          </label>
        );
      })}
    </div>
  );
}
