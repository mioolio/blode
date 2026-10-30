import { ModernSelect } from './ModernSelect';
import { HardDrive, Layers, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { Partition, ProjectConfig } from '../../shared/contracts';
import { useI18n } from '../i18n';
import { bytes, hexAddress } from '../utils';

interface Props {
  config: ProjectConfig;
  baseAddress: number;
  /** Linked or validated firmware size from the last successful build. */
  firmwareUsed: number | null;
  firmwareStale: boolean;
  flashSizes?: number[];
  customFlashSize?: boolean;
  detectedFlashSize?: number;
  busy?: boolean;
  onResize: (flashSize: number) => void;
  onAllocate: (appSize: number) => void;
  onChangePartitions: (partitions: Partition[]) => void;
  onSave: () => void;
  ramUsed?: number | null;
  ramTotal?: number;
}

const regionColors: Record<Partition['type'], string> = {
  app: '#8FB8FF',
  data: '#6FD3C7',
  system: '#E6B86A',
};

/** Unallocated ranges between partitions and the end of Flash. */
function freeRegions(partitions: Partition[], capacity: number): { offset: number; size: number }[] {
  const sorted = [...partitions].sort((left, right) => left.offset - right.offset);
  const regions: { offset: number; size: number }[] = [];
  let cursor = 0;
  for (const partition of sorted) {
    const start = Math.max(0, Math.min(partition.offset, capacity));
    if (start > cursor) regions.push({ offset: cursor, size: start - cursor });
    cursor = Math.max(cursor, Math.min(partition.offset + partition.size, capacity));
  }
  if (cursor < capacity) regions.push({ offset: cursor, size: capacity - cursor });
  return regions;
}

/** First page-aligned gap large enough for another region. */
function nextFreeRegion(partitions: Partition[], capacity: number): { offset: number; size: number } | null {
  for (const region of freeRegions(partitions, capacity)) {
    const offset = Math.ceil(region.offset / 1024) * 1024;
    const size = Math.floor((region.offset + region.size - offset) / 1024) * 1024;
    if (size >= 1024) return { offset, size };
  }
  return null;
}

const colorOf = (partition: Partition) => partition.color ?? regionColors[partition.type];

/**
 * Fixed-layout platforms own no partition table: the single application prefix
 * is the only allocatable region. Capacity and app size remain editable, while
 * platform facts stay in the board definition rather than board-id branches.
 */
export function ResourceLayout({
  config,
  baseAddress,
  firmwareUsed,
  firmwareStale,
  flashSizes,
  customFlashSize,
  detectedFlashSize,
  busy,
  onResize,
  onAllocate,
  onChangePartitions,
  onSave,
  ramUsed,
  ramTotal,
}: Props) {
  const { t } = useI18n();
  const capacity = Math.max(config.flashSize, 1);
  const partitions = [...config.partitions].sort((left, right) => left.offset - right.offset);
  const app = partitions.find((partition) => partition.type === 'app' && partition.offset === 0);
  const appSize = app?.size ?? config.flashSize;
  const [customMode, setCustomMode] = useState(() => !(flashSizes ?? []).includes(config.flashSize));
  const [customKiB, setCustomKiB] = useState(String(Math.round(config.flashSize / 1024)));
  const [appKiB, setAppKiB] = useState(String(Math.round(appSize / 1024)));
  const [selected, select] = useState(app?.id ?? '');
  const [addOpen, setAddOpen] = useState(false);
  const addRoot = useRef<HTMLDivElement>(null);
  const region = partitions.find((partition) => partition.id === selected) ?? app;
  const free = nextFreeRegion(partitions, config.flashSize);
  const nextRegionOffset = region
    ? partitions
        .filter((partition) => partition.offset > region.offset)
        .reduce((next, partition) => Math.min(next, partition.offset), config.flashSize)
    : config.flashSize;
  const appLimit = partitions
    .filter((partition) => partition.type !== 'app' && partition.offset > 0)
    .reduce((next, partition) => Math.min(next, partition.offset), config.flashSize);
  const maxRegionKiB = region ? Math.max(1, Math.floor((nextRegionOffset - region.offset) / 1024)) : 1;
  const gaps = freeRegions(partitions, capacity);
  const used = typeof firmwareUsed === 'number' ? Math.max(firmwareUsed, 0) : null;
  const measuredRam = typeof ramUsed === 'number' ? Math.max(ramUsed, 0) : null;
  const ramCapacity = typeof ramTotal === 'number' && ramTotal > 0 ? ramTotal : 0;
  const appFree = used === null ? null : Math.max(appSize - used, 0);
  const unallocated = Math.max(
    config.flashSize - partitions.reduce((sum, partition) => sum + partition.size, 0),
    0,
  );
  const overAllocated = used !== null && used > appSize;
  const overlappedRegions =
    used === null
      ? []
      : partitions.filter((partition) => partition.type !== 'app' && used > partition.offset);
  const sizeOptions = flashSizes?.length ? flashSizes : [config.flashSize];
  const maxKiB = Math.max(1, Math.round(Math.max(...sizeOptions) / 1024));
  const absolute = (offset: number) => hexAddress(baseAddress + offset);

  useEffect(() => {
    setCustomKiB(String(Math.round(config.flashSize / 1024)));
    setCustomMode(!(flashSizes ?? []).includes(config.flashSize));
  }, [config.flashSize, flashSizes]);

  useEffect(() => {
    setAppKiB(String(Math.round(appSize / 1024)));
  }, [appSize]);

  useEffect(() => {
    if (!selected || partitions.some((partition) => partition.id === selected)) return;
    select(app?.id ?? partitions[0]?.id ?? '');
  }, [app?.id, partitions, selected]);

  useEffect(() => {
    if (!addOpen) return;
    const close = (event: PointerEvent) => {
      if (!addRoot.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setAddOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [addOpen]);

  const updatePartitions = (next: Partition[]) =>
    onChangePartitions([...next].sort((left, right) => left.offset - right.offset));
  const updateRegion = (values: Partial<Partition>) => {
    if (!region) return;
    updatePartitions(
      partitions.map((partition) => (partition.id === region.id ? { ...partition, ...values } : partition)),
    );
  };
  const addRegion = (type: 'data' | 'system') => {
    if (!free) return;
    let suffix = 1;
    while (partitions.some((partition) => partition.name === `${type}${suffix}`)) suffix++;
    const id = `${type}_${Date.now().toString(36)}`;
    updatePartitions([
      ...partitions,
      {
        id,
        name: `${type}${suffix}`,
        type,
        offset: free.offset,
        size: free.size,
        color: regionColors[type],
      },
    ]);
    select(id);
  };
  const removeRegion = () => {
    if (!region || region.type === 'app') return;
    updatePartitions(partitions.filter((partition) => partition.id !== region.id));
    select(app?.id ?? '');
  };

  return (
    <div className="layout-view view-scroll">
      <section className="view-card layout-card">
        <div className="layout-toolbar">
          <div className="layout-identity">
            <span className="summary-icon">
              <HardDrive size={16} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <div>
              <strong>{config.boardId.toUpperCase()}</strong>
              <span>
                {t('layout.capacity')} · {bytes(config.flashSize)}
              </span>
            </div>
          </div>
          {flashSizes && flashSizes.length > 0 && (
            <label className="inline-field">
              <span>{t('device.flash')}</span>
              <ModernSelect
                aria-label={t('device.flash')}
                value={customMode ? 'custom' : String(config.flashSize)}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.value === 'custom') {
                    setCustomMode(true);
                    setCustomKiB(String(Math.round(config.flashSize / 1024)));
                    return;
                  }
                  setCustomMode(false);
                  onResize(Number(event.target.value));
                }}
              >
                {flashSizes.map((size) => (
                  <option key={size} value={size}>
                    {bytes(size)}
                  </option>
                ))}
                {customFlashSize && <option value="custom">{t('layout.customFlashKiB')}</option>}
              </ModernSelect>
            </label>
          )}
          {customMode && (
            <label className="inline-field compact-field">
              <span>{t('layout.customFlashKiB')}</span>
              <input
                type="number"
                min={4}
                max={maxKiB}
                step={4}
                value={customKiB}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value;
                  setCustomKiB(value);
                  const kib = Number(value);
                  if (Number.isInteger(kib) && kib >= 4 && kib <= maxKiB) onResize(kib * 1024);
                }}
                onBlur={() => setCustomKiB(String(Math.round(config.flashSize / 1024)))}
              />
            </label>
          )}
          <label className="inline-field compact-field">
            <span>{t('layout.appSize')}</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, Math.floor(appLimit / 1024))}
              step={1}
              value={appKiB}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                setAppKiB(value);
                const kib = Number(value);
                if (Number.isInteger(kib) && kib >= 1 && kib * 1024 <= appLimit) onAllocate(kib * 1024);
              }}
              onBlur={() => {
                if (!appKiB.trim()) {
                  const fallback = Math.min(detectedFlashSize ?? config.flashSize, appLimit);
                  setAppKiB(String(Math.round(fallback / 1024)));
                  onAllocate(fallback);
                  return;
                }
                setAppKiB(String(Math.round(appSize / 1024)));
              }}
            />
          </label>
          <button className="primary" onClick={onSave} disabled={busy}>
            <Save size={13} strokeWidth={1.9} aria-hidden="true" />
            {t('action.apply')}
          </button>
          <span className="panel-badge">
            <Layers size={11} strokeWidth={1.9} aria-hidden="true" />
            {t('layout.fixedLayout')}
          </span>
        </div>
        {detectedFlashSize !== undefined && (
          <p className="subtle-note">
            {t('layout.detectedCapacity')} {bytes(detectedFlashSize)}
            {config.flashSizeOverride ? ` · ${t('layout.overrideActive')}` : ''}
          </p>
        )}

        <div className="partition-map">
          <div className="map-ruler">
            <span>{absolute(0)}</span>
            <span>{absolute(Math.floor(config.flashSize / 2))}</span>
            <span>{absolute(config.flashSize)}</span>
          </div>
          <div className="map-track">
            {gaps.map((region) => (
              <div
                key={`free-${region.offset}`}
                className="partition-block reserved"
                style={{
                  left: `${(region.offset / capacity) * 100}%`,
                  width: `${(region.size / capacity) * 100}%`,
                }}
                title={`${t('layout.reserved')} · ${absolute(region.offset)} · ${bytes(region.size)}`}
              >
                {region.size / capacity >= 0.06 && (
                  <>
                    <span>{t('layout.reserved')}</span>
                    <small>{bytes(region.size)}</small>
                  </>
                )}
              </div>
            ))}
            {partitions.map((partition) => (
              <div
                key={partition.id}
                className={`partition-block ${partition.type}`}
                style={{
                  left: `${(partition.offset / capacity) * 100}%`,
                  width: `${(partition.size / capacity) * 100}%`,
                  ...(partition.color
                    ? { background: `${partition.color}22`, borderColor: partition.color }
                    : {}),
                }}
                title={`${partition.name} · ${absolute(partition.offset)} · ${bytes(partition.size)}`}
              >
                <span>{partition.name}</span>
                <small>{bytes(partition.size)}</small>
              </div>
            ))}
          </div>
          <div className="map-legend">
            {(['app', 'data', 'system'] as const).map((type) => (
              <span key={type}>
                <i className={type} />
                {t(`layout.${type}`)}
              </span>
            ))}
            <span>
              <i />
              {t('layout.reserved')}
            </span>
          </div>
        </div>

        <div className="layout-grid">
          <div className="partition-list">
            <div className="section-heading">
              <span className="heading-label">{t('layout.regions')}</span>
              <span className="panel-badge">{partitions.length}</span>
            </div>
            {partitions.map((partition) => (
              <button
                type="button"
                className={`partition-row ${region?.id === partition.id ? 'active' : ''}`}
                key={partition.id}
                onClick={() => select(partition.id)}
              >
                <i
                  className={`partition-dot ${partition.type}`}
                  style={
                    partition.color
                      ? { background: partition.color, borderColor: partition.color }
                      : undefined
                  }
                />
                <span>
                  <strong>{partition.name}</strong>
                  <small>{absolute(partition.offset)}</small>
                </span>
                <span className="partition-size">{bytes(partition.size)}</span>
              </button>
            ))}
            <div className="region-add" ref={addRoot}>
              <button
                type="button"
                className="secondary region-add-trigger"
                disabled={!free || !!busy}
                title={t(free ? 'layout.addRegion' : 'layout.noSpace')}
                aria-haspopup="menu"
                aria-expanded={addOpen}
                onClick={() => setAddOpen((current) => !current)}
              >
                <Plus size={13} strokeWidth={2} aria-hidden="true" />
                {t('layout.addRegion')}
              </button>
              {addOpen && (
                <div className="region-add-menu" role="menu" aria-label={t('layout.addRegion')}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      addRegion('data');
                      setAddOpen(false);
                    }}
                  >
                    {t('layout.addData')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      addRegion('system');
                      setAddOpen(false);
                    }}
                  >
                    {t('layout.addSystem')}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="partition-inspector">
            <div className="section-heading">
              <span className="heading-label">{t('layout.allocation')}</span>
            </div>
            <dl className="resource-facts">
              <div>
                <dt>{t('layout.address')}</dt>
                <dd>{absolute(0)}</dd>
              </div>
              <div>
                <dt>{t('layout.endAddress')}</dt>
                <dd>{absolute(config.flashSize)}</dd>
              </div>
              <div>
                <dt>{t('layout.appRegion')}</dt>
                <dd>{bytes(appSize)}</dd>
              </div>
              <div>
                <dt>{t('layout.unallocated')}</dt>
                <dd>{bytes(unallocated)}</dd>
              </div>
              <div>
                <dt>{t('layout.firmwareUsed')}</dt>
                <dd>{used === null ? t('layout.notBuilt') : bytes(used)}</dd>
              </div>
              <div>
                <dt>{t('memory.remaining')}</dt>
                <dd>{appFree === null ? '—' : bytes(appFree)}</dd>
              </div>
              <div>
                <dt>{t('memory.ram')}</dt>
                <dd>
                  {measuredRam === null || ramCapacity === 0
                    ? t('layout.notBuilt')
                    : `${bytes(measuredRam)} / ${bytes(ramCapacity)}`}
                </dd>
              </div>
            </dl>
            {region && (
              <>
                <div className="section-heading">
                  <span className="heading-label">{t('layout.regionSettings')}</span>
                </div>
                <label>
                  {t('layout.name')}
                  <input
                    value={region.name}
                    maxLength={16}
                    disabled={busy}
                    onChange={(event) => updateRegion({ name: event.target.value })}
                  />
                </label>
                <label>
                  {t('layout.sizeKiB')}
                  <input
                    type="number"
                    min={1}
                    max={maxRegionKiB}
                    step={1}
                    value={Math.max(1, Math.round(region.size / 1024))}
                    disabled={busy}
                    onChange={(event) => {
                      const kib = Number(event.target.value);
                      if (!Number.isInteger(kib) || kib < 1 || kib > maxRegionKiB) return;
                      if (region.type === 'app') onAllocate(kib * 1024);
                      else updateRegion({ size: kib * 1024 });
                    }}
                  />
                </label>
                <label className="color-field">
                  {t('layout.color')}
                  <input
                    type="color"
                    value={colorOf(region)}
                    disabled={busy}
                    onChange={(event) => updateRegion({ color: event.target.value.toUpperCase() })}
                  />
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => updateRegion({ color: undefined })}
                  >
                    {t('layout.defaultColor')}
                  </button>
                </label>
                {region.type !== 'app' && (
                  <button type="button" className="text-danger" disabled={busy} onClick={removeRegion}>
                    <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
                    {t('action.delete')}
                  </button>
                )}
              </>
            )}
            {overlappedRegions.length > 0 ? (
              <p className="layout-warning">
                {t('layout.regionOverlap')} {overlappedRegions.map((item) => item.name).join(', ')}
              </p>
            ) : (
              overAllocated && <p className="layout-warning">{t('layout.appOverflow')}</p>
            )}
            {used !== null && !overAllocated && overlappedRegions.length === 0 && !firmwareStale && (
              <p className="subtle-note">{t('layout.compileFits')}</p>
            )}
            {used !== null && firmwareStale && <p className="subtle-note">{t('memory.previous')}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
