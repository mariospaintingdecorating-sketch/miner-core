import type {
  RuntimeDiagnostic,
  RuntimePresentationState,
  SystemMetricsSample,
  SystemMetricsSnapshot,
  WalletPresentation,
  WalletRuntimePresentationStates,
} from '../../application';
import { useUiLanguage } from '../i18n';
import { MetricCard } from '../components/MetricCard';
import { SectionHeading } from '../components/SectionHeading';
import { StatusBadge } from '../components/StatusBadge';

export interface HealthPageProps {
  readonly runtimeState: RuntimePresentationState;
  readonly runtimeStates: WalletRuntimePresentationStates;
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly systemMetrics: Readonly<SystemMetricsSnapshot>;
  readonly wallets: readonly WalletPresentation[];
  readonly beeStatus: string;
}

export function HealthPage({
  runtimeState,
  runtimeStates,
  diagnostics,
  systemMetrics,
  wallets,
  beeStatus,
}: HealthPageProps) {
  const { language, t } = useUiLanguage();
  const currentMetrics = systemMetrics.current;
  const recentIncidents = diagnostics
    .filter((entry) => entry.level === 'error' || entry.level === 'warning')
    .slice(0, 10);
  const activeWallets = [...runtimeStates.values()].filter((state) =>
    state.runtimeStatus !== 'idle' && state.runtimeStatus !== 'disposed',
  ).length;
  const currentNeedsAttention =
    runtimeState.recoveryStatus !== 'idle' ||
    runtimeState.runtimeStatus === 'disposed' ||
    beeStatus === 'failed';
  const healthLabel = currentNeedsAttention ? 'Attention' : 'Healthy';

  return (
    <div className="page-stack health-page">
      <SectionHeading
        description={t('Real application, process, and component health without simulated metrics.')}
        eyebrow={t('Runtime health')}
        title={t('Health')}
      />

      <section className="health-hero">
        <div className="health-pulse" aria-hidden="true"><i /></div>
        <div>
          <p className="eyebrow">{t('Current status')}</p>
          <h2>{t(healthLabel)}</h2>
          <p>
            {currentNeedsAttention
              ? t('A current component state requires operator attention.')
              : t('No current runtime or recovery blocker is reported.')}
          </p>
        </div>
        <StatusBadge label={healthLabel.toLocaleLowerCase()} />
      </section>

      <section aria-labelledby="current-health-title" className="page-stack compact-stack">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">{t('Live')}</p>
            <h3 id="current-health-title">{t('Current status')}</h3>
          </div>
          <StatusBadge
            label={systemMetrics.status === 'available' ? 'live' : 'unavailable'}
            tone={systemMetrics.status === 'available' ? 'success' : 'neutral'}
          />
        </div>

        <section className="metric-grid health-metric-grid">
          <MetricCard
            detail={t('All Core Miner Electron processes')}
            label={t('CPU usage')}
            value={currentMetrics ? `${currentMetrics.cpuPercent.toFixed(1)}%` : t('Not available')}
          />
          <MetricCard
            detail={t('Current working set')}
            label={t('Memory')}
            value={currentMetrics ? formatBytes(currentMetrics.memoryBytes) : t('Not available')}
          />
          <MetricCard
            detail={t('Electron main process duration')}
            label={t('Uptime')}
            value={currentMetrics ? formatUptime(currentMetrics.uptimeMs) : t('Not available')}
          />
          <MetricCard
            detail={t('Main, renderer, and related processes')}
            label={t('Processes')}
            value={currentMetrics?.processCount ?? t('Not available')}
          />
          <MetricCard
            detail={t('{count} wallets configured', { count: wallets.length })}
            label={t('Active wallets')}
            value={activeWallets}
          />
          <MetricCard
            accent={beeStatus === 'failed' ? 'warning' : 'success'}
            detail={t('Bee gateway connectivity state')}
            label={t('Bee connectivity')}
            value={<StatusBadge label={beeStatus} />}
          />
        </section>
      </section>

      <section className="health-grid">
        <article className="surface-panel">
          <div className="panel-title-row">
            <div><p className="eyebrow">{t('Components')}</p><h3>{t('Runtime services')}</h3></div>
            <StatusBadge label={runtimeState.runtimeStatus === 'disposed' ? 'offline' : 'healthy'} />
          </div>
          <dl className="component-list">
            <div><dt>{t('Mining runtime')}</dt><dd><StatusBadge label={runtimeState.runtimeStatus} /></dd></div>
            <div><dt>{t('Tap worker')}</dt><dd><StatusBadge label={runtimeState.schedulerStatus} /></dd></div>
            <div><dt>{t('Settlement')}</dt><dd><StatusBadge label={runtimeState.settlementStatus} /></dd></div>
            <div><dt>{t('Network boundary')}</dt><dd><StatusBadge label={runtimeState.boundaryStatus} /></dd></div>
            <div><dt>{t('Recovery')}</dt><dd><StatusBadge label={runtimeState.recoveryStatus} /></dd></div>
          </dl>
        </article>

        <article className="surface-panel">
          <div className="panel-title-row">
            <div><p className="eyebrow">{t('Device resources')}</p><h3>{t('Process breakdown')}</h3></div>
            <StatusBadge label={systemMetrics.status} tone={systemMetrics.status === 'available' ? 'success' : 'neutral'} />
          </div>
          {currentMetrics ? (
            <div className="process-metric-list">
              {currentMetrics.processes.map((processMetric) => (
                <div key={`${processMetric.pid}:${processMetric.kind}`}>
                  <strong>{t(processMetric.kind)}</strong>
                  <span>PID {processMetric.pid}</span>
                  <span>{processMetric.cpuPercent.toFixed(1)}% CPU</span>
                  <span>{formatBytes(processMetric.memoryBytes)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="panel-description">
              {t('Electron system metrics are explicitly unavailable in this environment.')}
            </p>
          )}
        </article>
      </section>

      <section className="surface-panel metrics-history-panel">
        <div className="panel-title-row">
          <div><p className="eyebrow">{t('Leak analysis')}</p><h3>{t('Metrics history')}</h3></div>
          <span className="section-count">{t('24 hour retention')}</span>
        </div>
        <div className="metrics-history-grid">
          <HistorySummary label="1h" samples={systemMetrics.history.oneHour} />
          <HistorySummary label="6h" samples={systemMetrics.history.sixHours} />
          <HistorySummary label="24h" samples={systemMetrics.history.twentyFourHours} />
        </div>
      </section>

      <section className="surface-panel incidents-panel">
        <div className="panel-title-row">
          <div><p className="eyebrow">{t('History')}</p><h3>{t('Recent incidents')}</h3></div>
          <span className="section-count">{t('{count} retained', { count: recentIncidents.length })}</span>
        </div>
        {recentIncidents.length > 0 ? (
          <div className="incident-list">
            {recentIncidents.map((incident) => (
              <article key={incident.id}>
                <StatusBadge label={incident.level} />
                <div>
                  <strong>{incident.title}</strong>
                  <span>{incident.detail}</span>
                  <small>
                    {new Date(incident.timestamp).toLocaleString(language)}
                    {incident.walletId ? ` · ${incident.walletId}` : ''}
                  </small>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="panel-description">{t('No warning or error is retained in diagnostics history.')}</p>
        )}
      </section>
    </div>
  );
}

function HistorySummary({
  label,
  samples,
}: {
  readonly label: string;
  readonly samples: readonly Readonly<SystemMetricsSample>[];
}) {
  const first = samples.at(0);
  const last = samples.at(-1);
  return (
    <article>
      <strong>{label}</strong>
      <span>{samples.length} samples</span>
      <small>
        {first && last
          ? `${formatBytes(first.memoryBytes)} → ${formatBytes(last.memoryBytes)}`
          : 'No samples'}
      </small>
    </article>
  );
}

function formatUptime(uptimeMs: number): string {
  const totalMinutes = Math.floor(uptimeMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
