import type { RuntimePresentationState } from '../../application';
import { useUiLanguage } from '../i18n';
import { LightweightProgressBar } from './LightweightProgressBar';

export interface SidebarEpochProgressProps {
  readonly epochs: RuntimePresentationState['epochs'];
}

export function SidebarEpochProgress({ epochs }: SidebarEpochProgressProps) {
  const { t } = useUiLanguage();

  return (
    <section className="sidebar-epochs" aria-label={t('Canonical chain')}>
      <SidebarEpochRow
        label={t('Mini Epoch')}
        progress={epochs.miniEpoch.progressPercent}
        remaining={t(epochs.miniEpoch.remainingLabel)}
        tone="blue"
      />
      <SidebarEpochRow
        label={t('Main Epoch')}
        progress={epochs.mainEpoch.progressPercent}
        remaining={t(epochs.mainEpoch.remainingLabel)}
        tone="red"
      />
    </section>
  );
}

function SidebarEpochRow({
  label,
  progress,
  remaining,
  tone,
}: {
  readonly label: string;
  readonly progress: number | null;
  readonly remaining: string;
  readonly tone: 'blue' | 'red';
}) {
  const valueLabel = progress === null || !Number.isFinite(progress)
    ? remaining
    : `${Math.max(0, Math.min(100, progress)).toFixed(1)}%`;

  return (
    <div className={`sidebar-epoch sidebar-epoch-${tone}`}>
      <div className="sidebar-epoch-heading">
        <strong>{label}</strong>
        <time>{remaining}</time>
      </div>
      <LightweightProgressBar
        label={label}
        maximum={100}
        tone={tone}
        value={progress}
        valueLabel={valueLabel}
      />
    </div>
  );
}
