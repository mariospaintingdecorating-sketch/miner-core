import { CORE_MINER_VERSION, CORE_MINER_SDK_VERSION } from '../../application';
import type { ReactNode } from 'react';
import type {
  MainEpochStartSnapshot,
  RuntimePresentationState,
  TimedMiningSnapshot,
  WalletFinancialOverview,
} from '../../application';
import { formatRawAmount } from '../../application/runtimeAnalytics';
import { useUiLanguage } from '../i18n';
import { navigationLabel, type NavigationView } from '../navigation';
import { BrandLogo } from './BrandLogo';
import { Navigation } from './Navigation';
import { SidebarAutomationControls } from './SidebarAutomationControls';
import { SidebarEpochProgress } from './SidebarEpochProgress';
import { StatusBadge } from './StatusBadge';

export interface DesktopLayoutProps {
  readonly activeView: NavigationView;
  readonly financialOverview: Readonly<WalletFinancialOverview>;
  readonly runtimeStatus: RuntimePresentationState['runtimeStatus'];
  readonly epochs: RuntimePresentationState['epochs'];
  readonly timedMining: Readonly<TimedMiningSnapshot>;
  readonly mainEpochStart: Readonly<MainEpochStartSnapshot>;
  readonly commandsDisabled: boolean;
  readonly globalMiningActive: boolean;
  readonly startAllDisabled: boolean;
  readonly stopAllDisabled: boolean;
  readonly onNavigate: (view: NavigationView) => void;
  readonly onStartAllMining: () => Promise<boolean>;
  readonly onStopAllMining: () => Promise<boolean>;
  readonly onStartTimedMining: (hours: number, shutdown: boolean) => Promise<boolean>;
  readonly onCancelTimedMining: () => Promise<boolean>;
  readonly onArmMainEpochStart: (hours: number) => Promise<boolean>;
  readonly onCancelMainEpochStart: () => Promise<boolean>;
  readonly children: ReactNode;
}

export function DesktopLayout({
  activeView,
  financialOverview,
  runtimeStatus,
  epochs,
  timedMining,
  mainEpochStart,
  commandsDisabled,
  globalMiningActive,
  startAllDisabled,
  stopAllDisabled,
  onNavigate,
  onStartAllMining,
  onStopAllMining,
  onStartTimedMining,
  onCancelTimedMining,
  onArmMainEpochStart,
  onCancelMainEpochStart,
  children,
}: DesktopLayoutProps) {
  const { language, t } = useUiLanguage();
  const formatSidebarBalance = (rawTotal: string | null, decimals = 9): string =>
    rawTotal
      ? formatRawAmount(
          rawTotal,
          decimals,
          2,
          language === 'en' ? '.' : ',',
        )
      : '—';

  return (
    <div className="desktop-shell">
      <aside className="sidebar">
        <BrandLogo />
        <SidebarEpochProgress epochs={epochs} />
        <article className="sidebar-nackl-total">
          <span>{t('Total NACKL')}</span>
          <strong>
            {financialOverview.nacklTotal.rawTotal
              ? `${formatRawAmount(
                  financialOverview.nacklTotal.rawTotal,
                  9,
                  2,
                  language === 'en' ? '.' : ',',
                )} NACKL`
              : '—'}
          </strong>
        </article>
        <SidebarAutomationControls
          commandsDisabled={commandsDisabled}
          mainEpochStart={mainEpochStart}
          onArmMainEpochStart={onArmMainEpochStart}
          onCancelMainEpochStart={onCancelMainEpochStart}
          onCancelTimedMining={onCancelTimedMining}
          onStartTimedMining={onStartTimedMining}
          timedMining={timedMining}
        />
        <p className="sidebar-section-label">{t('Operator workspace')}</p>
        <Navigation activeView={activeView} onNavigate={onNavigate} translate={t} />
        <div className="sidebar-mining-actions" aria-label={t('Mining commands')}>
          <button
            className={globalMiningActive
              ? 'button button-secondary button-stop-action'
              : 'button button-primary button-start-all'}
            disabled={globalMiningActive ? stopAllDisabled : startAllDisabled}
            onClick={() => void (globalMiningActive
              ? onStopAllMining()
              : onStartAllMining())}
            type="button"
          >
            <span aria-hidden="true">{globalMiningActive ? '■' : '▶'}</span>
            {t(globalMiningActive ? 'Stop all miners' : 'Start all miners')}
          </button>
        </div>
        <dl className="sidebar-balance-list" aria-label={t('Wallet financial overview')}>
          <div className="sidebar-balance-row sidebar-balance-row-red">
            <dt>{t('NACKL locked')}</dt>
            <dd>{formatSidebarBalance(financialOverview.nacklLocked.rawTotal)}</dd>
          </div>
          <div className="sidebar-balance-row sidebar-balance-row-blue">
            <dt>{t('NACKL available')}</dt>
            <dd>{formatSidebarBalance(financialOverview.nacklAvailable.rawTotal)}</dd>
          </div>
          <div className="sidebar-balance-row sidebar-balance-row-red">
            <dt>USDC</dt>
            <dd>{formatSidebarBalance(financialOverview.usdc.rawTotal, 6)}</dd>
          </div>
          <div className="sidebar-balance-row sidebar-balance-row-blue">
            <dt>SHELL</dt>
            <dd>{formatSidebarBalance(financialOverview.shell.rawTotal)}</dd>
          </div>
        </dl>
      </aside>

      <div className="workspace">
        <header className="workspace-header">
          <div className="mobile-brand"><BrandLogo compact /></div>
          <div className="workspace-title">
            <h1>Core Miner</h1>
            <p>{t(navigationLabel(activeView))} · {CORE_MINER_VERSION} · Bee SDK {CORE_MINER_SDK_VERSION}</p>
          </div>
          <div className="header-runtime" aria-label={t('Current miner status')}>
            <span>{t('Runtime status')}</span>
            <StatusBadge label={runtimeStatus} />
          </div>
        </header>

        <main className="workspace-content">{children}</main>
      </div>
    </div>
  );
}
