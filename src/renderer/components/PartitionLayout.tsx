import { ModernSelect } from './ModernSelect';
import { HardDrive, Info, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { Partition, ProjectConfig } from '../../shared/contracts';
import { useI18n } from '../i18n';
import { bytes, hex } from '../utils';

const sectorSize = 0x1000;
const MiB = 1024 * 1024;
const preferredPartitionSize = 0x100000;
const defaultFlashSizes = [4, 8, 16].map((size) => size * MiB);
const maxFlashSize = 128 * MiB;
const minZoom = 1;
const maxZoom = 64;
const unstyledFieldset = { border: 0, margin: 0, padding: 0, minWidth: 0 };

/** Allocate only unoccupied, aligned bytes; never create a zero-sized partition. */
function findFreeRegion(config: ProjectConfig): { offset: number; size: number } | null {
  let cursor = config.boardId === 'Esp32_S3_CAM' ? 0x9000 : 0;
  const sorted = [...config.partitions].sort((left, right) => left.offset - right.offset);
  for (const partition of [...sorted, { offset: config.flashSize, size: 0 }]) {
    const offset = Math.ceil(cursor / sectorSize) * sectorSize;
    const available =
      Math.floor((Math.min(partition.offset, config.flashSize) - offset) / sectorSize) * sectorSize;
    if (available >= sectorSize) return { offset, size: Math.min(preferredPartitionSize, available) };
    cursor = Math.max(cursor, partition.offset + partition.size);
  }
  return null;
}

interface Props {
  config: ProjectConfig;
  onChange: (config: ProjectConfig) => void;
  onSave: () => void;
  busy: boolean;
  flashSizes?: number[];
  customFlashSize?: boolean;
}

interface DragState {
  pointerId: number;
  startX: number;
  width: number;
  boundary: number;
  partitions: Partition[];
}

export function PartitionLayout({
  config,
  onChange,
  onSave,
  busy,
  flashSizes = defaultFlashSizes,
  customFlashSize = false,
}: Props) {
  const { t } = useI18n();
  const [selected, select] = useState(
    config.partitions.find((partition) => partition.type === 'app')?.id ?? '',
  );
  const [focusName, setFocusName] = useState(false);
  const [zoom, setZoom] = useState(minZoom);
  const [customMib, setCustomMib] = useState(String(config.flashSize / MiB));
  const [customMode, setCustomMode] = useState(() => !flashSizes.includes(config.flashSize));
  const nameInput = useRef<HTMLInputElement>(null);
  const map = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const scrollTarget = useRef<{ ratio: number; offset: number } | null>(null);
  const drag = useRef<DragState | null>(null);

  const partition = config.partitions.find((item) => item.id === selected);
  const sorted = [...config.partitions].sort((left, right) => left.offset - right.offset);
  const isEsp32S3 = config.boardId === 'Esp32_S3_CAM';
  const locked = isEsp32S3 && partition?.type === 'system';
  const freeRegion = findFreeRegion(config);
  const appOffset = sorted.find((item) => item.type === 'app')?.offset ?? Number.MAX_SAFE_INTEGER;
  const minFlashMib = Math.max(1, Math.round(flashSizes[0]! / MiB));
  // Overlapping ranges make the map unreadable and cannot be flashed; mark both sides.
  const overlaps = new Set<string>();
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.offset < previous.offset + previous.size) {
      overlaps.add(previous.id);
      overlaps.add(current.id);
    }
  }
  // Add from the free gap first; otherwise take a slice from the last data partition
  // so a full layout can still accept a new partition without manual shrinking.
  const tail = sorted.at(-1);
  const tailCandidate = tail && tail.type === 'data' && tail.offset >= appOffset ? tail : undefined;
  const canAdd = Boolean(freeRegion || (tailCandidate && tailCandidate.size >= sectorSize * 2));

  const boundaries = sorted.flatMap((left, index) => {
    const right = sorted[index + 1];
    if (!right) return [];
    if (left.type === 'system' || right.type === 'system') return [];
    if (left.offset < appOffset) return [];
    if (left.offset + left.size !== right.offset) return [];
    return [{ index, right }];
  });

  useEffect(() => {
    if (!focusName) return;
    nameInput.current?.focus();
    nameInput.current?.select();
    setFocusName(false);
  }, [focusName, partition]);

  useEffect(() => {
    setCustomMib(String(config.flashSize / MiB));
    setCustomMode(!flashSizes.includes(config.flashSize));
  }, [config.flashSize, flashSizes]);

  // Wheel over the map zooms around the pointer; shift+wheel keeps native horizontal panning.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.shiftKey) return;
      const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
      const next = Math.max(minZoom, Math.min(maxZoom, Math.round(zoom * factor * 100) / 100));
      if (next === zoom) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const offset = event.clientX - bounds.left;
      scrollTarget.current = {
        ratio: (element.scrollLeft + offset) / element.scrollWidth,
        offset,
      };
      setZoom(next);
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [zoom]);

  useEffect(() => {
    const element = viewport.current;
    const target = scrollTarget.current;
    if (!element || !target) return;
    element.scrollLeft = Math.max(0, target.ratio * element.scrollWidth - target.offset);
    scrollTarget.current = null;
  }, [zoom]);

  const update = (values: Partial<Partition>) => {
    if (busy || locked) return;
    onChange({
      ...config,
      partitions: config.partitions.map((item) => (item.id === selected ? { ...item, ...values } : item)),
    });
  };

  const add = () => {
    if (busy) return;
    let region = freeRegion ? { ...freeRegion } : null;
    let shrinkId: string | undefined;
    if (!region && tailCandidate) {
      const available = Math.floor((tailCandidate.size - sectorSize) / sectorSize) * sectorSize;
      if (available >= sectorSize) {
        const size = Math.min(preferredPartitionSize, available);
        region = { offset: tailCandidate.offset + tailCandidate.size - size, size };
        shrinkId = tailCandidate.id;
      }
    }
    if (!region) return;
    const id = `data_${Date.now().toString(36)}`;
    let suffix = 1;
    while (config.partitions.some((item) => item.name === `storage${suffix}`)) suffix++;
    const partitions = config.partitions.map((item) =>
      item.id === shrinkId ? { ...item, size: item.size - region.size } : item,
    );
    onChange({
      ...config,
      partitions: [...partitions, { id, name: `storage${suffix}`, type: 'data', ...region }],
    });
    select(id);
    setFocusName(true);
  };

  const resizeFlash = (flashSize: number) => {
    // A filesystem extending to the physical end follows capacity changes. Other
    // addresses remain deliberate user choices and are validated before save.
    const partitions = config.partitions.map((item) =>
      item.type === 'data' &&
      item.name === 'spiffs' &&
      item.offset + item.size === config.flashSize &&
      flashSize - item.offset >= sectorSize
        ? { ...item, size: flashSize - item.offset }
        : item,
    );
    onChange({ ...config, flashSize, partitions });
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>, boundary: number) => {
    if (busy || !map.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      width: map.current.getBoundingClientRect().width,
      boundary,
      partitions: config.partitions.map((item) => ({ ...item })),
    };
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId || state.width <= 0) return;
    const items = [...state.partitions].sort((left, right) => left.offset - right.offset);
    const left = items[state.boundary];
    const right = items[state.boundary + 1];
    const last = items.at(-1);
    if (!left || !right || !last) return;

    const lastEnd = last.offset + last.size;
    const fillsEnd = lastEnd === config.flashSize;
    const raw = ((event.clientX - state.startX) / state.width) * config.flashSize;
    let delta = Math.round(raw / sectorSize) * sectorSize;
    // Keep the left partition usable; when the layout already fills Flash, transfer
    // space to or from the final partition so the map never leaves a trailing gap.
    const minDelta = -(left.size - sectorSize);
    const maxDelta = fillsEnd ? last.size - sectorSize : config.flashSize - lastEnd;
    delta = Math.max(minDelta, Math.min(maxDelta, delta));
    if (delta === 0) return;

    const partitions = state.partitions.map((item) => {
      if (item.id === left.id) return { ...item, size: item.size + delta };
      if (item.offset >= right.offset)
        return {
          ...item,
          offset: item.offset + delta,
          ...(fillsEnd && item.id === last.id ? { size: item.size - delta } : {}),
        };
      return item;
    });
    onChange({ ...config, partitions });
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  const types: Partition['type'][] = isEsp32S3 && partition ? [partition.type] : ['app', 'data', 'system'];

  return (
    <div className="layout-view view-scroll">
      <fieldset disabled={busy} style={{ display: 'contents' }}>
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
            <label className="inline-field">
              <span>{t('device.flash')}</span>
              <ModernSelect
                aria-label={t('device.flash')}
                value={customMode ? 'custom' : String(config.flashSize)}
                onChange={(event) => {
                  if (event.target.value === 'custom') {
                    setCustomMode(true);
                    setCustomMib(String(config.flashSize / MiB));
                    return;
                  }
                  setCustomMode(false);
                  resizeFlash(Number(event.target.value));
                }}
              >
                {flashSizes.map((size) => (
                  <option key={size} value={size}>
                    {bytes(size)}
                  </option>
                ))}
                {customFlashSize && <option value="custom">{t('layout.customFlash')}</option>}
              </ModernSelect>
            </label>
            {customFlashSize && customMode && (
              <label className="inline-field compact-field">
                <span>{t('layout.customFlash')}</span>
                <input
                  type="number"
                  min={minFlashMib}
                  max={maxFlashSize / MiB}
                  step={1}
                  value={customMib}
                  onChange={(event) => {
                    const next = event.target.value;
                    setCustomMib(next);
                    const size = Number(next);
                    if (Number.isFinite(size) && size >= minFlashMib && size <= maxFlashSize / MiB)
                      resizeFlash(size * MiB);
                  }}
                  onBlur={() => setCustomMib(String(config.flashSize / MiB))}
                />
              </label>
            )}
            <button
              className="secondary"
              onClick={add}
              disabled={busy || !canAdd}
              title={t(canAdd ? 'action.add' : 'layout.noSpace')}
            >
              <Plus size={13} strokeWidth={1.9} aria-hidden="true" />
              {t('action.add')}
            </button>
            <button className="primary" onClick={onSave}>
              <Save size={13} strokeWidth={1.9} aria-hidden="true" />
              {t('action.apply')}
            </button>
          </div>
          <p className="workspace-note">{t('layout.subtitle')}</p>

          <div className="partition-map">
            <div className="map-viewport" ref={viewport}>
              <div className="map-canvas" style={{ width: `${zoom * 100}%` }}>
                <div className="map-ruler">
                  <span>{hex(0)}</span>
                  <span>{hex(config.flashSize / 2)}</span>
                  <span>{hex(config.flashSize)}</span>
                </div>
                <div className="map-track" ref={map}>
                  {sorted.map((item) => {
                    const compact = (item.size / config.flashSize) * zoom * 100 < 1.4;
                    const overlap = overlaps.has(item.id);
                    return (
                      <button
                        title={`${item.name} · ${hex(item.offset)} · ${bytes(item.size)}${
                          overlap ? ` · ${t('layout.overlapShort')}` : ''
                        }`}
                        key={item.id}
                        className={`partition-block ${item.type} ${selected === item.id ? 'selected' : ''} ${
                          overlap ? 'overlap' : ''
                        } ${compact ? 'compact' : ''}`}
                        style={{
                          left: `${(item.offset / config.flashSize) * 100}%`,
                          width: `${(item.size / config.flashSize) * 100}%`,
                        }}
                        onClick={() => select(item.id)}
                      >
                        {!compact && (
                          <>
                            <span>{item.name}</span>
                            <small>{bytes(item.size)}</small>
                          </>
                        )}
                      </button>
                    );
                  })}
                  {boundaries.map(({ index, right }) => (
                    <div
                      key={`handle-${right.id}`}
                      className="partition-handle"
                      style={{ left: `${(right.offset / config.flashSize) * 100}%` }}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={t('layout.dragHandle')}
                      title={t('layout.dragHandle')}
                      onPointerDown={(event) => beginResize(event, index)}
                      onPointerMove={moveResize}
                      onPointerUp={endResize}
                      onPointerCancel={endResize}
                    />
                  ))}
                </div>
              </div>
            </div>
            {overlaps.size > 0 && <p className="layout-warning">{t('layout.overlapWarning')}</p>}
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
                <span className="heading-label">{t('layout.map')}</span>
                <span className="panel-badge">{config.partitions.length}</span>
              </div>
              {sorted.map((item) => (
                <button
                  key={item.id}
                  className={`partition-row ${selected === item.id ? 'active' : ''}`}
                  onClick={() => select(item.id)}
                >
                  <i className={`partition-dot ${item.type}`} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{hex(item.offset)}</small>
                  </span>
                  <span className="partition-size">{bytes(item.size)}</span>
                </button>
              ))}
              {!canAdd && <p className="subtle-note">{t('layout.noSpace')}</p>}
            </div>

            <div className="partition-inspector">
              <div className="section-heading">
                <span className="heading-label">{t('layout.inspector')}</span>
                {locked && <Lock size={12} strokeWidth={1.9} aria-hidden="true" />}
              </div>
              {partition ? (
                <>
                  {locked && <p className="subtle-note">{t('layout.systemLocked')}</p>}
                  <fieldset disabled={locked} style={unstyledFieldset}>
                    <label>
                      {t('layout.name')}
                      <input
                        ref={nameInput}
                        value={partition.name}
                        onChange={(event) => update({ name: event.target.value })}
                      />
                    </label>
                    <label>
                      {t('layout.type')}
                      <ModernSelect
                        value={partition.type}
                        onChange={(event) => update({ type: event.target.value as Partition['type'] })}
                      >
                        {types.map((type) => (
                          <option key={type} value={type}>
                            {t(`layout.${type}`)}
                          </option>
                        ))}
                      </ModernSelect>
                    </label>
                    <label>
                      {t('layout.address')} <small>{t('layout.hex')}</small>
                      <input
                        key={`${partition.id}-${partition.offset}`}
                        defaultValue={hex(partition.offset)}
                        onBlur={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value)) update({ offset: value });
                        }}
                      />
                    </label>
                    <label>
                      {t('layout.size')} <small>{t('layout.bytes')}</small>
                      <input
                        type="number"
                        step={sectorSize}
                        min={sectorSize}
                        value={partition.size}
                        onChange={(event) => update({ size: Number(event.target.value) })}
                      />
                    </label>
                    <button
                      className="text-danger"
                      disabled={isEsp32S3 && partition.type === 'app'}
                      onClick={() => {
                        onChange({
                          ...config,
                          partitions: config.partitions.filter((item) => item.id !== selected),
                        });
                        select('');
                      }}
                    >
                      <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
                      {t('action.delete')}
                    </button>
                  </fieldset>
                </>
              ) : (
                <p className="subtle-note">{t('layout.hint')}</p>
              )}
            </div>
          </div>
        </section>

        <div className="info-callout">
          <Info size={14} strokeWidth={1.8} aria-hidden="true" />
          <p>
            {t('layout.validation')}
            <br />
            {t('layout.unsaved')}
          </p>
        </div>
      </fieldset>
    </div>
  );
}
