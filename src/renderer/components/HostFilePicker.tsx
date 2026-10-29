import { useEffect, useState } from 'react';
import { ArrowUp, File, Folder, RefreshCw, X } from 'lucide-react';
import type { HostListing } from '../../shared/host-workspace';
import type { HostPickerRequest } from '../workspace/hostPicker';
import { useI18n } from '../i18n';
import './host-file-picker.css';

export function HostFilePicker() {
  const { t } = useI18n();
  const [request, setRequest] = useState<HostPickerRequest | null>(null);
  const [listing, setListing] = useState<HostListing>();
  const [location, setLocation] = useState('');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (path?: string) => {
    setBusy(true);
    setError('');
    try {
      const next = await window.blode.hostBrowse(path);
      setListing(next);
      setLocation(next.path);
      setSelected('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const open = (event: Event) => {
      const next = (event as CustomEvent<HostPickerRequest>).detail;
      setRequest((current) => {
        current?.resolve(null);
        return next;
      });
      setName(next.defaultName ?? '');
      void load();
    };
    window.addEventListener('blode:host-picker', open);
    return () => window.removeEventListener('blode:host-picker', open);
  }, []);
  const close = (path: string | null) => {
    request?.resolve(path);
    setRequest(null);
  };
  useEffect(() => {
    if (!request) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [request]);
  if (!request) return null;
  const joined = listing
    ? listing.path.replace(/[\\/]$/, '') + (listing.path.includes('\\') ? '\\' : '/') + name
    : '';
  const windowsPath = !!listing && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(listing.path);
  const invalidName =
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/\0\r\n]/.test(name) ||
    (windowsPath && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)));
  const supported = (filename: string) =>
    !request.extensions ||
    request.extensions.some((extension) => filename.toLowerCase().endsWith('.' + extension.toLowerCase()));
  const chooseFile = (path: string, filename: string) => {
    if (supported(filename)) close(path);
    else setError('host.unsupportedFile');
  };
  const save = () => {
    if (!listing || invalidName) return;
    const existing = listing.entries.find((entry) =>
      windowsPath ? entry.name.toLowerCase() === name.toLowerCase() : entry.name === name,
    );
    if (existing?.directory) {
      setError('host.unsupportedFile');
      return;
    }
    if ((existing || listing.truncated) && !window.confirm(t('host.confirmOverwrite') + '\n' + joined))
      return;
    close(joined);
  };
  return (
    <div className="modal-backdrop host-picker-backdrop">
      <section
        className="modal host-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-picker-title"
      >
        <header className="host-picker-heading">
          <div>
            <h2 id="host-picker-title">{request.title ?? t('host.pickTitle')}</h2>
            <p>{t('host.targetMachineNote')}</p>
          </div>
          <button className="icon-button" aria-label={t('action.cancel')} onClick={() => close(null)}>
            <X size={16} />
          </button>
        </header>
        <form
          className="host-picker-location"
          onSubmit={(event) => {
            event.preventDefault();
            void load(location);
          }}
        >
          <button
            type="button"
            className="icon-button"
            disabled={busy || !listing?.parent}
            onClick={() => void load(listing?.parent ?? undefined)}
            title={t('host.parent')}
          >
            <ArrowUp size={16} />
          </button>
          <input
            aria-label={t('host.path')}
            value={location}
            onChange={(event) => setLocation(event.target.value)}
          />
          <button type="submit" disabled={busy}>
            <RefreshCw size={14} />
            {t('action.open')}
          </button>
        </form>
        <div className="host-picker-body">
          <nav aria-label={t('host.roots')}>
            {listing?.roots.map((root) => (
              <button key={root} onClick={() => void load(root)}>
                {root}
              </button>
            ))}
          </nav>
          <div className="host-picker-files" role="listbox" aria-label={t('host.entries')}>
            {listing?.entries
              .filter((entry) => entry.directory || request.kind !== 'directory')
              .map((entry) => (
                <button
                  role="option"
                  aria-selected={selected === entry.path}
                  className={selected === entry.path ? 'active' : ''}
                  key={entry.path}
                  title={entry.path}
                  onClick={() => {
                    setSelected(entry.path);
                    if (request.kind === 'save' && !entry.directory) setName(entry.name);
                  }}
                  onDoubleClick={() => {
                    if (entry.directory) void load(entry.path);
                    else if (request.kind === 'file') chooseFile(entry.path, entry.name);
                  }}
                >
                  {entry.directory ? <Folder size={15} /> : <File size={15} />}
                  <span>{entry.name}</span>
                </button>
              ))}
            {listing?.truncated && <p>{t('host.truncated')}</p>}
          </div>
        </div>
        {request.kind === 'save' && (
          <label>
            {t('host.filename')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={request.defaultName}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="error-text">
            {t(error)}
          </p>
        )}
        <footer>
          <button onClick={() => close(null)}>{t('action.cancel')}</button>
          <button
            className="primary"
            disabled={
              busy ||
              !listing ||
              (request.kind === 'file' && !selected) ||
              (request.kind === 'save' && invalidName)
            }
            onClick={() => {
              const entry = listing?.entries.find((item) => item.path === selected);
              if (request.kind === 'directory') close(entry?.directory ? entry.path : listing!.path);
              else if (request.kind === 'save') save();
              else if (entry?.directory) void load(entry.path);
              else if (entry) chooseFile(entry.path, entry.name);
              else setError('host.unsupportedFile');
            }}
          >
            {request.kind === 'save' ? t('action.save') : t('action.open')}
          </button>
        </footer>
      </section>
    </div>
  );
}
