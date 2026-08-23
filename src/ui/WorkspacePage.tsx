import type {
  ProductionConfigurationSnapshot,
  DiagnosticsExportResult,
  RuntimeDiagnostic,
  RuntimePresentationState,
  SystemMetricsSnapshot,
  WalletRuntimePresentationStates,
  WalletConnectionCommandResult,
  WalletRegistration,
  WalletPresentation,
  WalletFinancialOverview,
  GlobalMiningUptimeSnapshot,
} from '../application';
import type { NavigationView } from './navigation';
import { DashboardPage } from './pages/DashboardPage';
import { HealthPage } from './pages/HealthPage';
import { SettingsPage } from './pages/SettingsPage';
import { WalletsPage } from './pages/WalletsPage';

export interface WorkspacePageProps {
  readonly activeView: NavigationView;
  readonly configuration: Readonly<ProductionConfigurationSnapshot>;
  readonly runtimeState: RuntimePresentationState;
  readonly runtimeStates: WalletRuntimePresentationStates;
  readonly wallets: readonly WalletPresentation[];
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly systemMetrics: Readonly<SystemMetricsSnapshot>;
  readonly financialOverview: Readonly<WalletFinancialOverview>;
  readonly globalMiningUptime: Readonly<GlobalMiningUptimeSnapshot>;
  readonly beeStatus: string;
  readonly selectedWalletId: string | null;
  readonly commandsDisabled: boolean;
  readonly onSelectWallet: (walletId: string | null) => void;
  readonly onBeginWalletConnection: WalletConnectionCommand;
  readonly onPrepareWalletMiningCredential: WalletConnectionCommand;
  readonly onVerifyWalletMiningCredential: WalletConnectionCommand;
  readonly onDisconnectWallet: WalletConnectionCommand;
  readonly onRefreshWalletConnection: WalletConnectionCommand;
  readonly onStartWalletMining: MiningCommand;
  readonly onStopWalletMining: MiningCommand;
  readonly onRegisterWallet: (wallet: WalletRegistration) => Promise<boolean>;
  readonly onRemoveWallet: (walletId: string) => Promise<boolean>;
  readonly onExportDiagnostics: () => Promise<Readonly<DiagnosticsExportResult>>;
}

type WalletConnectionCommand = (
  walletId: string,
) => Promise<Readonly<WalletConnectionCommandResult> | null>;

type MiningCommand = (walletId: string) => Promise<boolean>;

export function WorkspacePage({
  activeView,
  configuration,
  runtimeState,
  runtimeStates,
  wallets,
  diagnostics,
  systemMetrics,
  financialOverview,
  globalMiningUptime,
  beeStatus,
  selectedWalletId,
  commandsDisabled,
  onSelectWallet,
  onBeginWalletConnection,
  onPrepareWalletMiningCredential,
  onVerifyWalletMiningCredential,
  onDisconnectWallet,
  onRefreshWalletConnection,
  onStartWalletMining,
  onStopWalletMining,
  onRegisterWallet,
  onRemoveWallet,
  onExportDiagnostics,
}: WorkspacePageProps) {
  switch (activeView) {
    case 'wallets':
      return (
        <WalletsPage
          commandsDisabled={commandsDisabled}
          configuration={configuration}
          onBeginWalletConnection={onBeginWalletConnection}
          onDisconnectWallet={onDisconnectWallet}
          onPrepareWalletMiningCredential={onPrepareWalletMiningCredential}
          onVerifyWalletMiningCredential={onVerifyWalletMiningCredential}
          onRefreshWalletConnection={onRefreshWalletConnection}
          onRegisterWallet={onRegisterWallet}
          onRemoveWallet={onRemoveWallet}
          onSelectWallet={onSelectWallet}
          onStartWalletMining={onStartWalletMining}
          onStopWalletMining={onStopWalletMining}
          selectedWalletId={selectedWalletId}
          runtimeStates={runtimeStates}
          wallets={wallets}
        />
      );
    case 'health':
      return (
        <HealthPage
          beeStatus={beeStatus}
          diagnostics={diagnostics}
          runtimeState={runtimeState}
          runtimeStates={runtimeStates}
          systemMetrics={systemMetrics}
          wallets={wallets}
        />
      );
    case 'settings':
      return <SettingsPage onExportDiagnostics={onExportDiagnostics} />;
    case 'dashboard':
      return (
        <DashboardPage
          commandsDisabled={commandsDisabled}
          onStartWalletMining={onStartWalletMining}
          onStopWalletMining={onStopWalletMining}
          runtimeStates={runtimeStates}
          systemMetrics={systemMetrics}
          financialOverview={financialOverview}
          globalMiningUptime={globalMiningUptime}
          wallets={wallets}
        />
      );
  }
}
