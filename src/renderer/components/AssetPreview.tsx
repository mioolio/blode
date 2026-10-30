import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileAudio, FileVideo, Image, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import type { WorkspaceAssetPreview } from '../../shared/assets';
import { useI18n } from '../i18n';
import { bytes } from '../utils';
import { assetDuration, assetHexRows, stopAssetMedia } from './assetPreviewModel';
import { anchoredImageZoom, fittedImageScale } from './imageViewport';
import './asset-preview.css';

export function AssetPreview({
  projectRoot,
  path,
  revision,
}: {
  projectRoot: string;
  path: string;
  revision?: string;
}) {
  const { t } = useI18n();
  const identity = `${projectRoot}\0${path}\0${revision ?? ''}`;
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{
    identity: string;
    asset?: WorkspaceAssetPreview;
    error?: string;
  }>();
  const current = response?.identity === identity ? response : undefined;
  useEffect(() => {
    let cancelled = false;
    setResponse({ identity });
    void window.blode
      .workspaceAsset({ expectedProjectRoot: projectRoot, path })
      .then((asset) => {
        if (!cancelled) setResponse({ identity, asset });
      })
      .catch((error) => {
        if (!cancelled)
          setResponse({ identity, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [identity, attempt]);
  const reload = () => {
    setResponse({ identity });
    setAttempt((value) => value + 1);
  };
  if (current?.asset)
    return <AssetPreviewSurface key={current.asset.url} asset={current.asset} onReload={reload} />;
  return (
    <section className="asset-preview asset-preview-placeholder" aria-label={t('asset.preview')}>
      {current?.error ? (
        <div className="asset-preview-notice" role="alert">
          <p>{t(current.error)}</p>
          <button onClick={reload}>
            <RefreshCw size={14} />
            {t('asset.reload')}
          </button>
        </div>
      ) : (
        <span role="status">{t('asset.loading')}</span>
      )}
    </section>
  );
}

/** Media rendering is shared by the workspace and standalone preview surfaces. */
export function AssetPreviewSurface({
  asset,
  onReload,
}: {
  asset: WorkspaceAssetPreview;
  onReload: () => void;
}) {
  const { t, locale } = useI18n();
  const [scale, setScale] = useState<number | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number }>();
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [duration, setDuration] = useState('');
  const [failed, setFailed] = useState(false);
  const media = useRef<HTMLMediaElement | null>(null);
  const picture = useRef<HTMLImageElement | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const mediaRef = useCallback(
    (element: HTMLMediaElement | null) => {
      if (media.current && media.current !== element) stopAssetMedia(media.current);
      media.current = element;
      if (element && element.getAttribute('src') !== asset.url) {
        element.setAttribute('src', asset.url);
        element.load();
      }
    },
    [asset.url],
  );
  const name = asset.path.replaceAll('\\', '/').split('/').at(-1) ?? asset.path;
  const format = name.includes('.') ? name.split('.').at(-1)!.toUpperCase() : asset.mime;
  const modified = Number.isNaN(Date.parse(asset.modifiedAt))
    ? ''
    : new Date(asset.modifiedAt).toLocaleString(locale);
  const image = asset.kind === 'image';
  const Icon = image ? Image : asset.kind === 'video' ? FileVideo : FileAudio;
  const actualScale = scale ?? (imageSize ? fittedImageScale(imageSize, viewportSize) : 1);
  const view = useRef({ scale: actualScale, pan });
  view.current = { scale: actualScale, pan };
  const zoom = (next: number, anchor = { x: 0, y: 0 }) => {
    const result = anchoredImageZoom(view.current.scale, next, view.current.pan, anchor);
    view.current = result;
    setScale(result.scale);
    setPan(result.pan);
  };
  const reset = (next: number | null) => {
    setScale(next);
    setPan({ x: 0, y: 0 });
  };
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !image) return;
    const measure = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [image, failed]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || !image || !imageSize) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const factor = Math.exp(-Math.max(-350, Math.min(350, event.deltaY * units)) * 0.002);
      const current = view.current;
      const next = anchoredImageZoom(current.scale, current.scale * factor, current.pan, {
        x: event.clientX - bounds.left - bounds.width / 2,
        y: event.clientY - bounds.top - bounds.height / 2,
      });
      view.current = next;
      setScale(next.scale);
      setPan(next.pan);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [image, imageSize, failed]);
  const hexRows = useMemo(() => assetHexRows(asset.hex ?? ''), [asset.hex]);
  return (
    <section className="asset-preview" aria-label={t('asset.preview')}>
      <header className="asset-preview-toolbar">
        <div className="asset-preview-format">
          <span>{format}</span>
          <span>{bytes(asset.size)}</span>
        </div>
        <div className="asset-preview-actions">
          {image && (
            <>
              <button
                disabled={!imageSize}
                title={t('asset.zoomOut')}
                aria-label={t('asset.zoomOut')}
                onClick={() => zoom(actualScale * 0.8)}
              >
                <ZoomOut size={14} />
              </button>
              <button
                disabled={!imageSize}
                title={t('asset.actualSize')}
                aria-label={t('asset.actualSize')}
                aria-pressed={scale === 1}
                onClick={() => reset(1)}
              >
                {`${Math.round(actualScale * 100)}%`}
              </button>
              <button
                disabled={!imageSize}
                title={t('asset.zoomIn')}
                aria-label={t('asset.zoomIn')}
                onClick={() => zoom(actualScale * 1.25)}
              >
                <ZoomIn size={14} />
              </button>
              <button aria-pressed={scale === null} onClick={() => reset(null)}>
                {t('asset.fit')}
              </button>
            </>
          )}
          <button onClick={onReload} title={t('asset.reload')} aria-label={t('asset.reload')}>
            <RefreshCw size={14} />
          </button>
        </div>
      </header>
      {failed ? (
        <div className="asset-preview-placeholder" role="alert">
          <div className="asset-preview-notice">
            <p>{t(image ? 'asset.imageError' : 'asset.mediaError')}</p>
            <button onClick={onReload}>{t('asset.reload')}</button>
          </div>
        </div>
      ) : image ? (
        <div
          className={`asset-image-scroll${scale === null ? ' is-fit' : ''}${dragging ? ' is-dragging' : ''}`}
          ref={viewport}
          tabIndex={0}
          onDoubleClick={() => reset(null)}
          onKeyDown={(event) => {
            if (event.key === '+' || event.key === '=') {
              event.preventDefault();
              zoom(actualScale * 1.25);
            }
            if (event.key === '-') {
              event.preventDefault();
              zoom(actualScale * 0.8);
            }
            if (event.key === '0') {
              event.preventDefault();
              reset(null);
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !imageSize) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: view.current.pan };
            setScale(view.current.scale);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) return;
            setPan({
              x: current.pan.x + event.clientX - current.x,
              y: current.pan.y + event.clientY - current.y,
            });
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return;
            drag.current = null;
            setDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
        >
          <img
            ref={picture}
            className="asset-image"
            src={asset.url}
            alt={name}
            draggable={false}
            style={
              imageSize
                ? {
                    width: imageSize.width * actualScale,
                    height: imageSize.height * actualScale,
                    transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`,
                  }
                : undefined
            }
            onLoad={(event) =>
              setImageSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
          />
        </div>
      ) : asset.kind === 'audio' || asset.kind === 'video' ? (
        <div className={`asset-media-stage is-${asset.kind}`}>
          {asset.kind === 'audio' && (
            <div className="asset-audio-name">
              <Icon size={36} strokeWidth={1.4} />
              <span>{name}</span>
            </div>
          )}
          {asset.kind === 'audio' ? (
            <audio
              ref={mediaRef}
              src={asset.url}
              controls
              preload="metadata"
              aria-label={name}
              onLoadedMetadata={(event) => setDuration(assetDuration(event.currentTarget.duration))}
              onError={() => setFailed(true)}
            />
          ) : (
            <video
              ref={mediaRef}
              src={asset.url}
              controls
              playsInline
              preload="metadata"
              aria-label={name}
              onLoadedMetadata={(event) => setDuration(assetDuration(event.currentTarget.duration))}
              onError={() => setFailed(true)}
            />
          )}
        </div>
      ) : (
        <div className="asset-hex-scroll">
          {hexRows.length ? (
            <table className="asset-hex-table">
              <thead>
                <tr>
                  <th>{t('asset.offset')}</th>
                  <th>{t('asset.hex')}</th>
                  <th>{t('asset.text')}</th>
                </tr>
              </thead>
              <tbody>
                {hexRows.map((row) => (
                  <tr key={row.offset}>
                    <td>{row.offset}</td>
                    <td>{row.hex}</td>
                    <td>{row.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="asset-preview-placeholder">{t('asset.empty')}</div>
          )}
        </div>
      )}
      <footer className="asset-preview-footer">
        <span>{asset.mime}</span>
        {imageSize && (
          <span>
            {imageSize.width} × {imageSize.height}
          </span>
        )}
        {duration && <span>{duration}</span>}
        {asset.truncated && (
          <span>
            {t('asset.prefix')} {bytes((asset.hex?.length ?? 0) / 2)}
          </span>
        )}
        {modified && <time dateTime={asset.modifiedAt}>{modified}</time>}
      </footer>
    </section>
  );
}
