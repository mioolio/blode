import type { ReactNode } from 'react';
import { useI18n } from '../i18n';

/** Common accessible icon action; labels are always locale keys. */
export function IconButton({
  labelKey,
  onClick,
  disabled = false,
  children,
}: {
  labelKey: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <button
      className="icon-button"
      title={t(labelKey)}
      aria-label={t(labelKey)}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** Concise action builder shared by panel headings and toolbars. */
export function iconButton(labelKey: string, onClick: () => void, children: ReactNode, disabled = false) {
  return (
    <IconButton labelKey={labelKey} onClick={onClick} disabled={disabled}>
      {children}
    </IconButton>
  );
}
