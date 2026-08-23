import { memo } from 'react';

export interface LightweightProgressBarProps {
  readonly label: string;
  readonly maximum: number;
  readonly tone: 'blue' | 'red' | 'mixed';
  readonly value: number | null;
  readonly valueLabel: string;
}

export const LightweightProgressBar = memo(function LightweightProgressBar({
  label,
  maximum,
  tone,
  value,
  valueLabel,
}: LightweightProgressBarProps) {
  const safeMaximum = Number.isFinite(maximum) && maximum > 0
    ? maximum
    : 100;
  const safeValue = value !== null && Number.isFinite(value)
    ? Math.min(safeMaximum, Math.max(0, value))
    : 0;
  const ratio = safeValue / safeMaximum;

  return (
    <div
      aria-label={label}
      aria-valuemax={safeMaximum}
      aria-valuemin={0}
      aria-valuenow={safeValue}
      aria-valuetext={valueLabel}
      className={`lightweight-progress lightweight-progress-${tone}`}
      role="progressbar"
    >
      <span
        aria-hidden="true"
        className="lightweight-progress-fill"
        style={{ transform: `scaleX(${ratio})` }}
      />
    </div>
  );
});
