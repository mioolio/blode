import type { Studio } from '../workspace/useStudio';
import { ModernSelect } from './ModernSelect';
import { RuntimeDeviceFields } from './RuntimeDeviceFields';
import { RuntimePluginView } from './RuntimePluginView';
import './runtime-selector.css';

/** Runtime selection and plugin fields share the target-device dock. */
export function RuntimeSelector({ studio }: { studio: Studio }) {
  const { t, state, config, board, setConfig, setStale, busy } = studio;
  const plugin = board?.runtimePlugin;
  const initializing = !state || state.initializing === true;
  return (
    <div className="runtime-selector-body">
      <ModernSelect
        aria-label={t('runtime.selector')}
        value={config?.boardId ?? ''}
        disabled={!config || !!busy}
        onChange={(event) => {
          const selected = state?.boards.find((item) => item.id === event.target.value);
          if (!config || !selected) return;
          setConfig({
            ...config,
            ...selected.defaultConfig,
            name: config.name,
            port: config.port,
            baudRate: selected.recommendedBaudRate ?? selected.defaultConfig.baudRate ?? config.baudRate,
            boardId: selected.id,
            runtime: selected.defaultConfig.runtime
              ? structuredClone(selected.defaultConfig.runtime)
              : undefined,
            programmer: selected.defaultConfig.programmer
              ? { ...selected.defaultConfig.programmer }
              : undefined,
            toolchain: {
              ...config.toolchain,
              fqbn: selected.defaultConfig.toolchain?.fqbn ?? config.toolchain.fqbn,
            },
          });
          setStale(true);
        }}
      >
        {state?.boards
          .filter((item) => ['auto', 'Esp32_S3_CAM', 'STM32F103C8T6', config?.boardId].includes(item.id))
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
      </ModernSelect>
      <button
        className="text-button"
        onClick={() => window.dispatchEvent(new CustomEvent('blode:component-libraries'))}
      >
        {t('components.title')}
      </button>
      {!!state?.runtimePlugins?.errors.length && (
        <details className="runtime-load-errors">
          <summary>
            {t('runtime.loadErrors')} ({state.runtimePlugins.errors.length})
          </summary>
          {state.runtimePlugins.errors.map((error, index) => (
            <p key={index}>
              {error.directory}
              <br />
              {t(error.message)}
            </p>
          ))}
        </details>
      )}
      {state?.runtimePlugins?.plugins.some(
        (item) => item.id === config?.boardId && item.trust === 'required',
      ) && (
        <button
          className="text-button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('blode:runtime-plugin-review', { detail: config?.boardId }))
          }
        >
          {t('runtime.review')}
        </button>
      )}
      {plugin && config && (
        <RuntimeDeviceFields
          plugin={plugin}
          config={config}
          disabled={!!busy || initializing}
          onChange={(value) => {
            setConfig(value);
            setStale(true);
          }}
        />
      )}
      {plugin?.ui.view && <RuntimePluginView id={plugin.id} kind="device" />}
    </div>
  );
}
