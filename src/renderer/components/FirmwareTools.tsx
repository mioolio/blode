import { useEffect, useState } from 'react';
import { Download, Flame, RefreshCw, X } from 'lucide-react';
import { getBoardAdapter } from '../../../extensions/registry';
import type { AppState, FirmwareFormat, PreparedFirmware, ProjectConfig } from '../../shared/contracts';
import { useI18n } from '../i18n';

/** Firmware tools are native operations and remain available on the welcome screen. */
export function FirmwareTools() {
  const { t } = useI18n();
  const [mode, setMode] = useState<'export' | 'flash' | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [image, setImage] = useState<PreparedFirmware | null>(null);
  const [format, setFormat] = useState<FirmwareFormat>('bin');
  const [address, setAddress] = useState('0x08000000');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const explain = (error: unknown) =>
    t(
      (error instanceof Error ? error.message : String(error)).replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        '',
      ),
    );

  useEffect(() => {
    const open = (event: Event) => {
      if (busy) return;
      const requested = (event as CustomEvent<{ mode?: string }>).detail?.mode;
      if (requested !== 'export' && requested !== 'flash') return;
      setMode(requested);
      setNotice('');
      setFailed(false);
      setConfirmed(false);
      setImage(null);
      setBusy(true);
      void window.blode
        .getState()
        .then((next) => {
          setState(next);
          const target =
            next.config.boardId === 'auto'
              ? {
                  ...getBoardAdapter('stm32').createConfig(),
                  toolchain: {
                    ...getBoardAdapter('stm32').createConfig().toolchain,
                    stlinkDirectory: next.config.toolchain.stlinkDirectory,
                    armCompilerDirectory: next.config.toolchain.armCompilerDirectory,
                  },
                }
              : structuredClone(next.config);
          setConfig(target);
          setAddress(target.boardId === 'stm32' ? '0x08000000' : '0x0');
        })
        .catch((error) => {
          setNotice(explain(error));
          setFailed(true);
        })
        .finally(() => setBusy(false));
    };
    window.addEventListener('blode:firmware-tools', open);
    return () => window.removeEventListener('blode:firmware-tools', open);
  }, [t, busy]);

  if (!mode) return null;
  const standalone = mode === 'flash';
  const stlink = config?.boardId === 'stm32';
  const selectedConnected = stlink
    ? !!state?.debugProbes.some(
        (probe) => probe.serialNumber.toLowerCase() === config?.programmer?.serialNumber.toLowerCase(),
      )
    : !!state?.ports.some((port) => port.path === config?.port);
  const value = address.trim();
  const loadAddress = /^(?:0x[\da-f]+|\d+)$/i.test(value) ? Number(value) : NaN;
  const validAddress = Number.isSafeInteger(loadAddress) && loadAddress >= 0 && loadAddress <= 0xffffffff;
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    setFailed(false);
    try {
      await action();
    } catch (error) {
      setNotice(explain(error));
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const refresh = () =>
    perform(async () => {
      const choices = stlink ? await window.blode.listDebugProbes() : await window.blode.listPorts();
      const next = await window.blode.getState();
      if (stlink) next.debugProbes = choices as AppState['debugProbes'];
      else next.ports = choices as AppState['ports'];
      setState(next);
      setConfig((current) =>
        !current
          ? current
          : stlink
            ? {
                ...current,
                programmer: {
                  transport: 'stlink',
                  frequencyKhz: current.programmer?.frequencyKhz ?? 1800,
                  serialNumber: next.debugProbes.some(
                    (p) => p.serialNumber.toLowerCase() === current.programmer?.serialNumber.toLowerCase(),
                  )
                    ? (current.programmer?.serialNumber ?? '')
                    : '',
                },
              }
            : { ...current, port: next.ports.some((p) => p.path === current.port) ? current.port : '' },
      );
      setConfirmed(false);
    });
  const changeBoard = (id: string) => {
    const next = getBoardAdapter(id).createConfig();
    if (config)
      next.toolchain = {
        ...next.toolchain,
        stlinkDirectory: config.toolchain.stlinkDirectory,
        armCompilerDirectory: config.toolchain.armCompilerDirectory,
        arduinoCli: config.toolchain.arduinoCli,
        python: config.toolchain.python,
      };
    setConfig(next);
    setConfirmed(false);
    if (!image || image.format === 'bin') setAddress(id === 'stm32' ? '0x08000000' : '0x0');
  };

  return (
    <div
      className="modal-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) setMode(null);
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t(standalone ? 'firmware.flashStandalone' : 'firmware.export')}
        style={{ width: 'min(640px, 92vw)', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div className="modal-heading">
          <span className="modal-icon warning">
            {standalone ? <Flame size={18} /> : <Download size={18} />}
          </span>
          <h2>{t(standalone ? 'firmware.flashStandalone' : 'firmware.export')}</h2>
          <button
            className="text-button"
            style={{ marginLeft: 'auto' }}
            aria-label={t('action.close')}
            disabled={busy}
            onClick={() => setMode(null)}
          >
            <X size={16} />
          </button>
        </div>
        {!standalone ? (
          <>
            <p>{t('firmware.exportDescription')}</p>
            <label>
              {t('firmware.format')}
              <select
                value={format}
                disabled={busy}
                onChange={(event) => setFormat(event.target.value as FirmwareFormat)}
              >
                <option value="bin">Binary (.bin)</option>
                <option value="hex">Intel HEX (.hex)</option>
                <option value="srec">Motorola S-record (.srec)</option>
                <option value="elf">ARM ELF (.elf)</option>
              </select>
            </label>
            <p className="subtle-note">{t('firmware.exportAddressNote')}</p>
            {(!state?.lastBuild?.success || state.buildStale) && (
              <p className="layout-warning">{t('firmware.buildRequired')}</p>
            )}
          </>
        ) : (
          <>
            <p>{t('firmware.standaloneDescription')}</p>
            <label>
              {t('firmware.platform')}
              <select
                value={config?.boardId ?? 'stm32'}
                disabled={busy}
                onChange={(event) => changeBoard(event.target.value)}
              >
                <option value="stm32">STM32 / ST-Link</option>
                <option value="esp32-s3">ESP32-S3</option>
              </select>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const selected = await window.blode.firmwareChoose();
                    if (selected) {
                      setImage(selected);
                      setConfirmed(false);
                      setAddress(
                        selected.address === null
                          ? stlink
                            ? '0x08000000'
                            : '0x0'
                          : `0x${selected.address.toString(16)}`,
                      );
                    }
                  })
                }
              >
                {t('firmware.choose')}
              </button>
              <span>{image?.name ?? t('firmware.noFile')}</span>
            </div>
            {image && (
              <p className="subtle-note">
                {image.format.toUpperCase()} · {image.size.toLocaleString()} bytes · {image.segments}{' '}
                {t('firmware.segments')}
                <br />
                SHA-256: {image.sha256.slice(0, 24)}…
              </p>
            )}
            <label>
              {t('firmware.loadAddress')}
              <input
                value={address}
                disabled={busy || (!!image && image.format !== 'bin')}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setConfirmed(false);
                }}
                placeholder={stlink ? '0x08000000' : '0x0'}
              />
            </label>
            <p className="subtle-note">
              {t(image?.format === 'bin' ? 'firmware.binaryAddressNote' : 'firmware.addressFileNote')}
            </p>
            {image && image.segments > 1 && <p className="layout-warning">{t('firmware.gapsNote')}</p>}
            <label>
              {t(stlink ? 'device.debugProbe' : 'device.port')}
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value={
                    stlink
                      ? selectedConnected
                        ? (config?.programmer?.serialNumber ?? '')
                        : ''
                      : selectedConnected
                        ? (config?.port ?? '')
                        : ''
                  }
                  disabled={busy}
                  onChange={(event) => {
                    const selected = event.target.value;
                    setConfig((current) =>
                      !current
                        ? current
                        : stlink
                          ? {
                              ...current,
                              programmer: {
                                transport: 'stlink',
                                frequencyKhz: current.programmer?.frequencyKhz ?? 1800,
                                serialNumber: selected,
                              },
                            }
                          : { ...current, port: selected },
                    );
                    setConfirmed(false);
                  }}
                >
                  <option value="">{t('firmware.selectConnection')}</option>
                  {stlink
                    ? state?.debugProbes.map((probe) => (
                        <option key={probe.serialNumber} value={probe.serialNumber}>
                          {probe.description ?? probe.name} · {probe.serialNumber}
                        </option>
                      ))
                    : state?.ports.map((port) => (
                        <option key={port.path} value={port.path}>
                          {port.path} · {port.manufacturer}
                        </option>
                      ))}
                </select>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void refresh()}
                  title={t('action.refresh')}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            </label>
            <p className="subtle-note">{t('firmware.probeBeforeWrite')}</p>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>{t('firmware.confirmWrite')}</span>
            </label>
          </>
        )}
        {notice && (
          <p role="status" className={failed ? 'layout-warning' : 'subtle-note'}>
            {notice}
          </p>
        )}
        <div className="modal-actions">
          <button className="secondary" disabled={busy} onClick={() => setMode(null)}>
            {t('action.close')}
          </button>
          {standalone ? (
            <button
              className="primary danger"
              disabled={busy || !image || !config || !selectedConnected || !confirmed || !validAddress}
              onClick={() =>
                void perform(async () => {
                  await window.blode.firmwareFlash({
                    id: image!.id,
                    config: config!,
                    address: loadAddress,
                    confirm: true,
                  });
                  setConfirmed(false);
                  setNotice(t('firmware.flashComplete'));
                })
              }
            >
              {t(busy ? 'firmware.working' : 'action.flash')}
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || !state?.lastBuild?.success || !!state.buildStale}
              onClick={() =>
                void perform(async () => {
                  const result = await window.blode.firmwareExport(format);
                  if (result.status === 'saved') setNotice(t('firmware.exportComplete'));
                })
              }
            >
              {t(busy ? 'firmware.working' : 'firmware.export')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
