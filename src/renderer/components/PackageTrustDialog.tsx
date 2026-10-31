import { createRoot } from 'react-dom/client';
import { ShieldAlert } from 'lucide-react';
import type { PackageApproval, PackageKind, PackageVerification } from '../../shared/package-signing';
import './package-trust.css';

type Translate = (key: string) => string;
let showing = false;
export function approvePackageVerification(
  review: PackageVerification,
  t: Translate,
): Promise<PackageApproval | undefined> {
  if (review.status === 'verified') return Promise.resolve({ fingerprint: review.fingerprint });
  if (showing) return Promise.reject(new Error('error.busy'));
  showing = true;
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    let closed = false;
    const close = (accepted: boolean) => {
      if (closed) return;
      closed = true;
      window.removeEventListener('keydown', key, true);
      root.unmount();
      node.remove();
      showing = false;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      resolve(
        accepted
          ? {
              fingerprint: review.fingerprint,
              allowUntrusted: true,
              ...(['invalid', 'tampered'].includes(review.status) ? { allowModified: true as const } : {}),
            }
          : undefined,
      );
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(false);
      }
      if (event.key === 'Tab') {
        const buttons = [...node.querySelectorAll<HTMLButtonElement>('button')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        event.stopImmediatePropagation();
        buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
      }
    };
    window.addEventListener('keydown', key, true);
    root.render(
      <div className="package-trust-backdrop">
        <section
          className="modal package-trust-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="package-trust-title"
          aria-describedby="package-trust-message"
        >
          <h2 id="package-trust-title">
            <ShieldAlert size={20} />
            {t(`packageTrust.${review.status}`)}
          </h2>
          <p id="package-trust-message">
            {t(
              review.status === 'tampered'
                ? 'packageTrust.modifiedWarning'
                : review.status === 'invalid'
                  ? 'packageTrust.invalidWarning'
                  : 'packageTrust.untrustedWarning',
            )}
          </p>
          {review.publisher && (
            <dl>
              <dt>{t('packageTrust.publisher')}</dt>
              <dd>
                {review.publisher}
                {review.trusted ? ' · Blode Studio' : ''}
              </dd>
              <dt>{t('packageTrust.key')}</dt>
              <dd className="package-trust-key">{review.keyId}</dd>
            </dl>
          )}
          {!!review.changed.length && (
            <details>
              <summary>{t('packageTrust.changed')}</summary>
              <ul>
                {review.changed.slice(0, 10).map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="modal-actions">
            <button ref={(button) => button?.focus()} onClick={() => close(false)}>
              {t('action.cancel')}
            </button>
            <button className="primary" onClick={() => close(true)}>
              {t('packageTrust.installAnyway')}
            </button>
          </div>
        </section>
      </div>,
    );
  });
}
export async function approvePackageSource(source: string, kind: PackageKind, t: Translate) {
  return approvePackageVerification(await window.blode.packageInspect({ path: source, kind }), t);
}
export async function approveCatalogComponent(t: Translate) {
  return !!(await approvePackageVerification(
    {
      status: 'unsigned',
      fingerprint: '0'.repeat(64),
      signatureValid: false,
      trusted: false,
      integrityValid: true,
      changed: [],
    },
    t,
  ));
}
