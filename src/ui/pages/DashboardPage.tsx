import {
  type SystemMetricsSnapshot,
  type WalletPresentation,
  type WalletFinancialOverview,
  type WalletRuntimePresentationStates,
  type GlobalMiningUptimeSnapshot,
} from '../../application';
import { formatRawAmount } from '../../application/runtimeAnalytics';
import { type Translate, useUiLanguage } from '../i18n';
import { EmptyState } from '../components/EmptyState';
import { MetricCard } from '../components/MetricCard';
import { StatusBadge } from '../components/StatusBadge';
import { WalletCard } from '../components/WalletCard';
import { compareWalletsByMamaBoardLevel } from '../walletSorting';

export interface DashboardPageProps {
  readonly runtimeStates: WalletRuntimePresentationStates;
  readonly wallets: readonly WalletPresentation[];
  readonly systemMetrics: Readonly<SystemMetricsSnapshot>;
  readonly financialOverview: Readonly<WalletFinancialOverview>;
  readonly globalMiningUptime: Readonly<GlobalMiningUptimeSnapshot>;
  readonly commandsDisabled: boolean;
  readonly onStartWalletMining: (walletId: string) => Promise<boolean>;
  readonly onStopWalletMining: (walletId: string) => Promise<boolean>;
}

export function DashboardPage({
  runtimeStates,
  wallets,
  systemMetrics,
  financialOverview,
  globalMiningUptime,
  commandsDisabled,
  onStartWalletMining,
  onStopWalletMining,
}: DashboardPageProps) {
  const { language, t } = useUiLanguage();
  const readyWallets = wallets.filter((wallet) => wallet.connection.miningReady).length;
  const runningWallets = wallets.filter(
    (wallet) => runtimeStates.get(wallet.id)?.runtimeStatus === 'running',
  );
  const currentMetrics = systemMetrics.current;
  const orderedWallets = [...wallets].sort(compareWalletsByMamaBoardLevel);

  return (
    <div className="page-stack dashboard-page">
      <section className="metric-grid dashboard-kpi-grid" aria-label={t('Operator summary')}>
        <MetricCard
          accent={wallets.length > 0 ? 'info' : 'neutral'}
          detail={t('{count} mining ready', { count: readyWallets })}
          icon="▣"
          label={t('Total wallets')}
          prominentValue
          value={wallets.length}
        />
        <MetricCard
          accent={runningWallets.length > 0 ? 'success' : 'neutral'}
          detail={t(runningWallets.length > 0 ? 'Mining now' : 'No active miner')}
          icon="⚒"
          label={t('Active miners')}
          prominentValue
          value={runningWallets.length}
        />
        <GlobalUptimeCard uptime={globalMiningUptime} />
        <DailyRewardsCard rewards={financialOverview.dailyRewards} />
        <MetricCard
          accent={currentMetrics ? 'info' : 'neutral'}
          detail={currentMetrics
            ? t('{count} Electron processes', { count: currentMetrics.processCount })
            : t('Electron metrics unavailable')}
          icon="▥"
          label={t('CPU and memory')}
          value={currentMetrics
            ? `CPU ${currentMetrics.cpuPercent.toFixed(1)}% · RAM ${formatBytes(currentMetrics.memoryBytes)}`
            : t('Not available')}
        />
      </section>

      <section className="dashboard-operations-grid dashboard-operations-grid-single">
        <article className="surface-panel wallet-fleet-panel">
          {wallets.length > 0 ? (
            <div className="wallet-grid dashboard-wallet-grid">
              {orderedWallets.map((wallet) => (
                <WalletCard
                  commandsDisabled={commandsDisabled}
                  rewardEffects
                  key={wallet.id}
                  onStart={(walletId) => void onStartWalletMining(walletId)}
                  onStop={(walletId) => void onStopWalletMining(walletId)}
                  runtimeState={runtimeStates.get(wallet.id)}
                  wallet={wallet}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              description={t('Add a wallet in the Wallets section to begin setup.')}
              title={t('No wallets configured')}
            />
          )}
        </article>

      </section>

    </div>
  );
}


export function formatMiningUptime(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours} h ${minutes} min`;
}

function DailyRewardsCard({
  rewards,
}: {
  readonly rewards: WalletFinancialOverview['dailyRewards'];
}) {
  const { language, t } = useUiLanguage();
  const today = rewards[0];

  return (
    <article className="metric-card metric-card-info daily-rewards-card">
      <div className="metric-card-label">
        <i aria-hidden="true">◇</i>
        <span>{t('Daily rewards')}</span>
      </div>
      <strong>
        {today
          ? `${formatRawAmount(
              today.amountRaw,
              9,
              2,
              language === 'en' ? '.' : ',',
            )} NACKL`
          : `0 NACKL`}
      </strong>
      <ol aria-label={t('Previous 3 days')}>
        {rewards.slice(1, 4).map((reward) => (
          <li key={reward.date}>
            <time dateTime={reward.date}>{compactDate(reward.date)}</time>
            <span>
              {formatRawAmount(
                reward.amountRaw,
                9,
                2,
                language === 'en' ? '.' : ',',
              )} NACKL
            </span>
          </li>
        ))}
      </ol>
    </article>
  );
}

export function GlobalUptimeCard({
  uptime,
}: {
  readonly uptime: Readonly<GlobalMiningUptimeSnapshot>;
}) {
  const { t } = useUiLanguage();

  return (
    <article className={`metric-card ${uptime.active ? 'metric-card-success' : 'metric-card-info'} global-uptime-card`}>
      <div className="metric-card-label">
        <i aria-hidden="true">◴</i>
        <span>{t('Up time today')}</span>
      </div>
      <strong>
        <span className="uptime-value">
          {uptime.active ? <i aria-hidden="true" /> : null}
          {formatMiningUptime(uptime.todayMs)}
        </span>
      </strong>
      <ol aria-label={t('Previous 3 days')}>
        {uptime.history.map((entry) => (
          <li key={entry.date}>
            <time dateTime={entry.date}>{compactDate(entry.date)}</time>
            <span>{formatMiningUptime(entry.durationMs)}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}

function compactDate(value: string): string {
  const [, month = '', day = ''] = value.split('-');
  return `${day}.${month}`;
}

function formatBytes(bytes: number): string {
  return bytes < 1_024 * 1_024
    ? `${Math.round(bytes / 1_024)} KB`
    : `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
