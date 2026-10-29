import { useEffect, useRef, useState } from 'react';
import { Download, Package, RefreshCw, TriangleAlert, X } from 'lucide-react';
import type { ProjectPackagePlan, ProjectPackageResult } from '../../shared/project-package';
import type { Studio } from '../workspace/useStudio';
import { bytes } from '../utils';
import './project-package-dialog.css';

const fingerprint = (plan: ProjectPackagePlan) =>
  JSON.stringify({
    root: plan.projectRoot,
    files: plan.files,
    warnings: plan.warnings,
    tools: plan.toolRequirements,
  });

/** Dependency relocation is reviewed before producing a portable standard ZIP. */
export function ProjectPackageDialog({ studio }: { studio: Studio }) {
  const { t } = studio;
  const latest = useRef(studio);
  latest.current = studio;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [plan, setPlan] = useState<ProjectPackagePlan>();
  const [result, setResult] = useState<ProjectPackageResult>();
  const [external, setExternal] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const explain = (error: unknown) =>
    t(
      (error instanceof Error ? error.message : String(error)).replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        '',
      ),
    );
  const load = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice('');
    setFailed(false);
    setPlan(undefined);
    setResult(undefined);
    setExternal(false);
    setIncomplete(false);
    try {
      if (!latest.current.state?.workspaceOpen) throw new Error('error.noWorkspace');
      if (!(await latest.current.save())) throw new Error('toast.saveFirst');
      setPlan(await window.blode.projectPackagePreview());
    } catch (error) {
      setNotice(explain(error));
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    const show = () => {
      if (pending.current) return;
      setOpen(true);
      void load();
    };
    window.addEventListener('blode:project-package', show);
    return () => window.removeEventListener('blode:project-package', show);
  }, [t]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending.current) setOpen(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open]);
  const saveResult = async (archive: ProjectPackageResult) => {
    if (await window.blode.projectPackageSave(archive.id)) setNotice(t('package.saved'));
    else setNotice(t('package.saveCancelled'));
  };
  const exportZip = async () => {
    if (pending.current || !plan) return;
    pending.current = true;
    setBusy(true);
    setNotice('');
    setFailed(false);
    try {
      if (result) {
        await saveResult(result);
        return;
      }
      if (!(await latest.current.save())) throw new Error('toast.saveFirst');
      const current = await window.blode.projectPackagePreview();
      if (fingerprint(current) !== fingerprint(plan)) {
        setPlan(current);
        setExternal(false);
        setIncomplete(false);
        setNotice(t('package.changedReview'));
        return;
      }
      const archive = await window.blode.projectPackageExport({
        ...(external ? { confirmExternal: true as const } : {}),
        ...(incomplete ? { allowIncomplete: true as const } : {}),
      });
      setResult(archive);
      await saveResult(archive);
    } catch (error) {
      setNotice(explain(error));
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  if (!open) return null;
  const externalFiles = plan?.files.filter((file) => file.external) ?? [];
  const ready = !!plan && (!plan.externalCount || external) && (!plan.warnings.length || incomplete);
  return (
    <div className="modal-backdrop">
      <section
        className="modal project-package-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-package-title"
      >
        <header className="package-heading">
          <h2 id="project-package-title">
            <Package size={18} />
            {t('package.title')}
          </h2>
          <button
            className="icon-button"
            disabled={busy}
            title={t('action.refresh')}
            aria-label={t('action.refresh')}
            onClick={() => void load()}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="icon-button"
            disabled={busy}
            title={t('window.close')}
            aria-label={t('window.close')}
            onClick={() => setOpen(false)}
          >
            <X size={17} />
          </button>
        </header>
        <div className="package-content">
          <p className="package-intro">{t('package.portableNote')}</p>
          {plan && (
            <>
              <div className="package-stats">
                <div>
                  <span>{t('package.project')}</span>
                  <strong title={plan.projectRoot}>{plan.name}</strong>
                </div>
                <div>
                  <span>{t('package.files')}</span>
                  <strong>{plan.files.length}</strong>
                </div>
                <div>
                  <span>{t('package.external')}</span>
                  <strong>{plan.externalCount}</strong>
                </div>
                <div>
                  <span>{t('package.sourceSize')}</span>
                  <strong>{bytes(plan.bytes)}</strong>
                </div>
              </div>
              {externalFiles.length > 0 && (
                <section className="package-section">
                  <h3>{t('package.externalFiles')}</h3>
                  <div className="package-dependencies">
                    {externalFiles.map((file) => (
                      <div key={file.source}>
                        <code title={file.source}>{file.source}</code>
                        <span aria-hidden="true">→</span>
                        <code>{file.destination}</code>
                        <small>{bytes(file.size)}</small>
                      </div>
                    ))}
                  </div>
                  <label className="package-consent">
                    <input
                      type="checkbox"
                      checked={external}
                      disabled={busy || !!result}
                      onChange={(event) => setExternal(event.target.checked)}
                    />
                    <span>{t('package.confirmExternal')}</span>
                  </label>
                </section>
              )}
              {plan.warnings.length > 0 && (
                <section className="package-section package-warnings">
                  <h3>
                    <TriangleAlert size={15} />
                    {t('package.unresolved')}
                  </h3>
                  <p>{t('package.unresolvedNote')}</p>
                  <ul>
                    {plan.warnings.map((warning, index) => (
                      <li key={`${warning.file}:${warning.reference}:${index}`}>
                        <strong>{t(`package.reason.${warning.reason}`)}</strong>
                        <code>{warning.reference}</code>
                        {warning.file && <small>{warning.file}</small>}
                      </li>
                    ))}
                  </ul>
                  <label className="package-consent">
                    <input
                      type="checkbox"
                      checked={incomplete}
                      disabled={busy || !!result}
                      onChange={(event) => setIncomplete(event.target.checked)}
                    />
                    <span>{t('package.confirmIncomplete')}</span>
                  </label>
                </section>
              )}
              {plan.toolRequirements.length > 0 && (
                <p className="package-tool-note">
                  {t('package.toolRequirements')} {plan.toolRequirements.join(' · ')}
                </p>
              )}
            </>
          )}
          {busy && (
            <p role="status" className="subtle-note">
              {t('package.working')}
            </p>
          )}
          {notice && (
            <p
              className={failed ? 'error-text package-notice' : 'package-notice'}
              role={failed ? 'alert' : 'status'}
            >
              {notice}
            </p>
          )}
          {result && (
            <p className="package-result">
              <Package size={15} />
              <strong>{result.name}</strong>
              <span>{bytes(result.size)}</span>
            </p>
          )}
        </div>
        <footer className="package-footer">
          <button disabled={busy} onClick={() => setOpen(false)}>
            {t('window.close')}
          </button>
          <button className="primary" disabled={busy || !ready} onClick={() => void exportZip()}>
            <Download size={14} />
            {t(result ? 'package.saveAgain' : 'package.export')}
          </button>
        </footer>
      </section>
    </div>
  );
}
