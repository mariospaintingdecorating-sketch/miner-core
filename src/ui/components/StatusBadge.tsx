export type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export interface StatusBadgeProps {
  readonly label: string;
  readonly tone?: StatusTone;
}

export function statusTone(status: string): StatusTone {
  if (
    status === 'running' ||
    status === 'completed' ||
    status === 'healthy' ||
    status === 'ready' ||
    status === 'live' ||
    status === 'connected'
  ) {
    return 'success';
  }

  if (
    status === 'warning' ||
    status === 'pending' ||
    status === 'stopping' ||
    status === 'waiting' ||
    status === 'awaiting-approval' ||
    status === 'awaiting-connection' ||
    status === 'awaiting-mining-key-approval'
  ) {
    return 'warning';
  }

  if (status === 'error' || status === 'failed' || status === 'offline') {
    return 'error';
  }

  if (
    status === 'info' ||
    status === 'starting' ||
    status === 'synchronizing' ||
    status === 'transitioning' ||
    status === 'recovery' ||
    status === 'propagating-mining-key'
  ) {
    return 'info';
  }

  return 'neutral';
}

export function StatusBadge({ label, tone = statusTone(label) }: StatusBadgeProps) {
  const { t } = useUiLanguage();

  return (
    <span className={`status-badge status-badge-${tone}`}>
      <i aria-hidden="true" />
      {t(label)}
    </span>
  );
}
import { useUiLanguage } from '../i18n';
