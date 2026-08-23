import type { ReactNode } from 'react';

export interface MetricCardProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly detail?: string;
  readonly icon?: ReactNode;
  readonly accent?: 'neutral' | 'success' | 'warning' | 'info';
  readonly prominentValue?: boolean;
}

export function MetricCard({
  label,
  value,
  detail,
  icon,
  accent = 'neutral',
  prominentValue = false,
}: MetricCardProps) {
  return (
    <article className={`metric-card metric-card-${accent}${prominentValue ? ' metric-card-prominent-value' : ''}`}>
      <div className="metric-card-label">
        {icon ? <i aria-hidden="true">{icon}</i> : null}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      {detail ? <p>{detail}</p> : null}
    </article>
  );
}
