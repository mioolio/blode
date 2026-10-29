import type { ProjectConfig } from '../../shared/contracts';
import type { RuntimePluginManifest } from '../../shared/plugins';
import { useI18n } from '../i18n';
import { ModernSelect } from './ModernSelect';
import './runtime-device-fields.css';

const moduleNames: Record<string, string> = {
  compile: 'action.build',
  flash: 'action.flash',
  probe: 'action.probe',
  serial: 'console.serial',
  layout: 'workspace.layout',
  partitions: 'runtime.partitions',
};

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
  const optional = plugin.capabilities.filter(
    (value) =>
      ['serial', 'layout', 'partitions'].includes(value) && !plugin.ui.hiddenCapabilities?.includes(value),
  );
  return (
    <div className="runtime-device-fields">
      <div className="runtime-support">
        <span>{plugin.transport.toUpperCase()}</span>
        <span>{plugin.support.chips.join(' · ')}</span>
      </div>
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
      {!!optional.length && (
        <fieldset disabled={disabled} className="runtime-modules">
          <legend>{t('runtime.modules')}</legend>
          {optional.map((capability) => (
            <label className="runtime-boolean" key={capability}>
              <input
                type="checkbox"
                checked={!config.runtime?.disabledCapabilities?.includes(capability)}
                onChange={(event) => {
                  const values = new Set(config.runtime?.disabledCapabilities ?? []);
                  if (event.target.checked) values.delete(capability);
                  else values.add(capability);
                  onChange({ ...config, runtime: { ...config.runtime, disabledCapabilities: [...values] } });
                }}
              />
              {t(moduleNames[capability] ?? capability)}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
