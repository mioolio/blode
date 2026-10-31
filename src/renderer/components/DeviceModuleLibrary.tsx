import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Cpu,
  FileArchive,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { DevicePackageReview, DevicePackagesState } from '../../shared/device-packages';
import type { Studio } from '../workspace/useStudio';
import { pickHostPath } from '../workspace/hostPicker';
import { deviceModulePage } from './deviceModuleModel';

export function DeviceModuleLibrary({
  studio,
  onBusyChange,
}: {
  studio: Studio;
  onBusyChange?(busy: boolean): void;
}) {
  const { t } = studio;
  const [state, setState] = useState<DevicePackagesState>();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState<DevicePackageReview>();
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const locked = useRef(false);
  const current = useRef(studio);
  current.current = studio;
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    void window.blode
      .devicePackagesState()
      .then((next) => {
        if (alive.current) setState(next);
      })
      .catch((error) => {
        if (alive.current) {
          setFailed(true);
          setNotice(String(error));
        }
      });
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange?.(pending);
  }, [pending, onBusyChange]);
  useEffect(() => {
    if (!review) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!locked.current) setReview(undefined);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [review]);
  const perform = async (action: () => Promise<void>) => {
    if (current.current.busy || locked.current) return;
    locked.current = true;
    setPending(true);
    setNotice('');
    setFailed(false);
    try {
      await action();
    } catch (error) {
      if (alive.current) {
        setFailed(true);
        setNotice(
          t(
            (error instanceof Error ? error.message : String(error)).replace(
              /^Error invoking remote method '[^']+': (?:Error: )?/,
              '',
            ),
          ),
        );
      }
    } finally {
      locked.current = false;
      if (alive.current) setPending(false);
    }
  };
  const load = (kind: 'file' | 'directory') =>
    void perform(async () => {
      const path = await pickHostPath({ kind, ...(kind === 'file' ? { extensions: ['zip'] } : {}) });
      if (path) setReview(await window.blode.devicePackageReview({ path }));
    });
  const result = useMemo(() => deviceModulePage(state?.packages ?? [], query, page), [state, query, page]);
  const unavailable = pending || !!studio.busy;
  return (
    <div className="device-module-library">
      <div className="component-toolbar">
        <div className="component-filter">
          <Search size={14} />
          <input
            type="search"
            value={query}
            placeholder={t('devices.search')}
            aria-label={t('devices.search')}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <button disabled={unavailable} onClick={() => load('file')}>
          <Plus size={14} />
          {t('devices.loadZip')}
        </button>
        <button disabled={unavailable} onClick={() => load('directory')}>
          <FolderOpen size={14} />
          {t('devices.loadFolder')}
        </button>
        <button
          disabled={unavailable}
          title={t('action.refresh')}
          aria-label={t('action.refresh')}
          onClick={() => void perform(async () => setState(await window.blode.devicePackagesState()))}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {notice && (
        <p className={`component-notice${failed ? ' error-text' : ''}`} role={failed ? 'alert' : 'status'}>
          {notice}
        </p>
      )}
      {!state && !failed ? (
        <p role="status">{t('device.connectionChecking')}</p>
      ) : (
        <div className="device-module-scroll">
          <ul className="device-modules-list">
            {result.entries.map((entry) => (
              <li className="device-module-row" key={entry.id}>
                <Cpu size={18} />
                <div className="device-module-info">
                  <strong>{entry.name}</strong>
                  <span>
                    {entry.id} · {entry.version}
                  </span>
                  <small>{entry.support.join(' · ')}</small>
                </div>
                <span className="device-module-origin">
                  {t(entry.source === 'builtin' ? 'settings.devices.builtin' : 'settings.devices.plugin')}
                </span>
                <div className="device-module-actions">
                  <button
                    disabled={
                      unavailable || !studio.state?.workspaceOpen || studio.config?.boardId === entry.id
                    }
                    onClick={() => {
                      const config = current.current.config;
                      const selected = current.current.state?.boards.find((board) => board.id === entry.id);
                      if (!config || !selected) return;
                      current.current.setConfig({
                        ...config,
                        ...structuredClone(selected.defaultConfig),
                        name: config.name,
                        port: config.port,
                        toolchain: {
                          ...config.toolchain,
                          fqbn: selected.defaultConfig.toolchain?.fqbn ?? config.toolchain.fqbn,
                        },
                      });
                      current.current.setStale(true);
                    }}
                  >
                    {t(studio.config?.boardId === entry.id ? 'devices.current' : 'devices.use')}
                  </button>
                  <button
                    disabled={unavailable}
                    onClick={() =>
                      void perform(async () => {
                        const archive = await window.blode.devicePackageExport({
                          id: entry.id,
                          confirm: true,
                        });
                        if (!alive.current) return;
                        const saved = await window.blode.devicePackageSave(archive.id);
                        if (alive.current)
                          setNotice(t(saved ? 'settings.devices.exported' : 'action.cancelled'));
                      })
                    }
                  >
                    <FileArchive size={13} />
                    {t('settings.versions.exportZip')}
                  </button>
                </div>
              </li>
            ))}
            {state && !result.entries.length && <li className="component-empty">{t('devices.noMatches')}</li>}
          </ul>
        </div>
      )}
      <footer className="device-module-pagination">
        <span>
          {result.total} {t('devices.items')}
        </span>
        <div>
          <button
            aria-label={t('devices.previous')}
            disabled={result.page === 0}
            onClick={() => setPage(result.page - 1)}
          >
            <ChevronLeft size={15} />
          </button>
          <span>
            {result.page + 1} / {result.pages}
          </span>
          <button
            aria-label={t('devices.next')}
            disabled={result.page + 1 >= result.pages}
            onClick={() => setPage(result.page + 1)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </footer>
      {review && (
        <div className="device-module-review-backdrop">
          <section
            className="device-module-review"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="device-review-title"
          >
            <h3 id="device-review-title">
              {t('devices.load')} · {review.name}
            </h3>
            <p>
              {review.id} · {review.version}
            </p>
            <p>
              {review.support.join(' · ')} · {review.fileCount} {t('devices.files')}
            </p>
            <p>{t('devices.nativeNotice')}</p>
            <div className="modal-actions">
              <button disabled={unavailable} onClick={() => setReview(undefined)}>
                {t('action.cancel')}
              </button>
              <button
                autoFocus
                className="primary"
                disabled={unavailable}
                onClick={() =>
                  void perform(async () => {
                    const next = await window.blode.devicePackageInstall({
                      ticket: review.ticket,
                      fingerprint: review.fingerprint,
                      confirm: true,
                    });
                    if (alive.current) {
                      setState(next);
                      setReview(undefined);
                      setQuery(review.id);
                      setPage(0);
                      setNotice(t('devices.loaded'));
                    }
                    await current.current.refresh();
                  })
                }
              >
                {t('devices.load')}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
