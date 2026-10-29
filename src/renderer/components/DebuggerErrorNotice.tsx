import { debuggerErrorSummary } from '../../shared/debugger-errors';
import { useI18n } from '../i18n';

export function DebuggerErrorNotice({
  message,
  transport,
  onViewLog,
}: {
  message: string;
  transport?: 'swd' | 'usb-jtag';
  onViewLog: () => void;
}) {
  const { t } = useI18n();
  if (!message) return null;
  return (
    <div className="debug-error" role="alert">
      <span>{t(debuggerErrorSummary(message, transport))}</span>
      <button type="button" onClick={onViewLog}>
        {t('debugger.viewLog')}
      </button>
    </div>
  );
}
