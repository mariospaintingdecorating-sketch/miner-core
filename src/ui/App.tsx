import { useEffect, useRef, useState } from 'react';
import type {
  MinerApplication,
  MiningBatchCommandResult,
  MiningCommandResult,
  MainEpochStartCommandResult,
  TimedMiningCommandResult,
  WalletConnectionCommandResult,
} from '../application';
import { DesktopLayout } from './components/DesktopLayout';
import { CustomTitleBar } from './components/CustomTitleBar';
import { useMinerPresentation } from './hooks/useMinerPresentation';
import { type UiLanguage, UiLanguageProvider, useUiLanguage } from './i18n';
import type { NavigationView } from './navigation';
import { WorkspacePage } from './WorkspacePage';
import { RewardEffectsProvider } from './rewardEffects';

export interface AppProps {
  readonly application: MinerApplication;
  readonly initialLanguage?: UiLanguage;
}

interface OperatorBannerState {
  readonly id: number;
  readonly message: string;
}

export const OPERATOR_BANNER_AUTO_HIDE_MS = 60_000;

export function scheduleOperatorBannerAutoHide(onHide: () => void): () => void {
  const timeout = globalThis.setTimeout(onHide, OPERATOR_BANNER_AUTO_HIDE_MS);
  return () => globalThis.clearTimeout(timeout);
}

export function OperatorBanner({ message }: { readonly message: string }) {
  return <p className="command-error" role="alert">{message}</p>;
}

export function App({ application, initialLanguage }: AppProps) {
  return (
    <UiLanguageProvider initialLanguage={initialLanguage}>
      <RewardEffectsProvider>
        <LocalizedApp application={application} />
      </RewardEffectsProvider>
    </UiLanguageProvider>
  );
}

function LocalizedApp({ application }: Pick<AppProps, 'application'>) {
  const { t } = useUiLanguage();
  const [activeView, setActiveView] = useState<NavigationView>('dashboard');
  const [commandPending, setCommandPending] = useState(false);
  const [commandBanner, setCommandBanner] = useState<OperatorBannerState | null>(null);
  const commandBannerSequence = useRef(0);
  const [selectedWalletId, setSelectedWalletId] = useState(
    application.selectedWalletId(),
  );
  const {
    runtimeState,
    runtimeStates,
    diagnostics,
    wallets,
    operatorState,
    systemMetrics,
    financialOverview,
  } =
    useMinerPresentation(
      application,
      activeView === 'health',
    );

  const showCommandBanner = (message: string): void => {
    commandBannerSequence.current += 1;
    setCommandBanner(Object.freeze({
      id: commandBannerSequence.current,
      message,
    }));
  };

  const navigateTo = (view: NavigationView): void => {
    setCommandBanner(null);
    setActiveView(view);
  };

  useEffect(() => {
    if (!commandBanner) return;

    const bannerId = commandBanner.id;
    return scheduleOperatorBannerAutoHide(() => {
      setCommandBanner((current) => current?.id === bannerId ? null : current);
    });
  }, [commandBanner]);

  const runCommand = async (
    command: () => Promise<
      | void
      | Readonly<MiningCommandResult>
      | Readonly<MiningBatchCommandResult>
      | Readonly<TimedMiningCommandResult>
      | Readonly<MainEpochStartCommandResult>
    >,
  ): Promise<boolean> => {
    setCommandPending(true);
    setCommandBanner(null);

    try {
      const result = await command();

      if (result && !result.accepted) {
        showCommandBanner(result.message);
        return false;
      }

      return true;
    } catch {
      showCommandBanner(t('The command could not be completed. Review diagnostics and retry.'));
      return false;
    } finally {
      setCommandPending(false);
    }
  };

  const runWalletCommand = async (
    command: () => Promise<Readonly<WalletConnectionCommandResult>>,
  ): Promise<Readonly<WalletConnectionCommandResult> | null> => {
    setCommandBanner(null);

    try {
      const result = await command();

      if (!result.accepted) {
        showCommandBanner(result.message);
      }

      return result;
    } catch {
      showCommandBanner(t('The wallet command could not be completed. Review diagnostics and retry.'));
      return null;
    }
  };

  const selectWallet = (walletId: string | null) => {
    const result = application.selectWallet(walletId);

    if (result.reasonCode === 'selected' || result.reasonCode === 'cleared') {
      setSelectedWalletId(result.walletId);
      setCommandBanner(null);
      return;
    }

    showCommandBanner(t('The selected wallet is no longer registered.'));
  };

  const globalMiningActive = wallets.some((wallet) => {
    const status = runtimeStates.get(wallet.id)?.runtimeStatus ?? wallet.runtimeStatus;
    return status !== 'idle' && status !== 'disposed';
  });
  const startAllDisabled = commandPending || !wallets.some((wallet) =>
    wallet.connection.miningReady &&
    (runtimeStates.get(wallet.id)?.runtimeStatus ?? wallet.runtimeStatus) === 'idle'
  );
  const stopAllDisabled = commandPending || !globalMiningActive;

  return (
    <div className="application-frame">
      <CustomTitleBar />
      <DesktopLayout
        activeView={activeView}
        commandsDisabled={commandPending}
        epochs={runtimeState.epochs}
        financialOverview={financialOverview}
        globalMiningActive={globalMiningActive}
        mainEpochStart={operatorState.mainEpochStart}
        onArmMainEpochStart={(hours) =>
          runCommand(async () => application.armMainEpochMiningStart(hours))
        }
        onCancelMainEpochStart={() =>
          runCommand(async () => application.cancelMainEpochMiningStart())
        }
        onCancelTimedMining={() =>
          runCommand(async () => application.cancelTimedMining())
        }
        onNavigate={navigateTo}
        onStartAllMining={() => runCommand(() => application.startAllMining())}
        onStopAllMining={() => runCommand(() => application.stopAllMining())}
        onStartTimedMining={(hours, shutdown) =>
          runCommand(() => application.startTimedMining(hours, shutdown))
        }
        runtimeStatus={runtimeState.runtimeStatus}
        startAllDisabled={startAllDisabled}
        stopAllDisabled={stopAllDisabled}
        timedMining={operatorState.timedMining}
      >
        {commandBanner ? <OperatorBanner message={commandBanner.message} /> : null}
        <WorkspacePage
        activeView={activeView}
        configuration={operatorState.configuration}
        diagnostics={diagnostics}
        systemMetrics={systemMetrics}
        financialOverview={financialOverview}
        globalMiningUptime={operatorState.globalMiningUptime}
        beeStatus={operatorState.beeSdk.status}
        commandsDisabled={commandPending}
        onBeginWalletConnection={(walletId, accountName) =>
          runWalletCommand(() => application.beginWalletConnection(walletId, accountName))
        }
        onDisconnectWallet={(walletId) =>
          runWalletCommand(() => application.disconnectWallet(walletId))
        }
        onStartWalletMining={(walletId) =>
          runCommand(() => application.startWalletMining(walletId))
        }
        onStopWalletMining={(walletId) =>
          runCommand(() => application.stopWalletMining(walletId))
        }
        onPrepareWalletMiningCredential={(walletId) =>
          runWalletCommand(() => application.prepareWalletMiningCredential(walletId))
        }
        onVerifyWalletMiningCredential={(walletId) =>
          runWalletCommand(() =>
            application.verifyWalletMiningCredentialPropagation(walletId)
          )
        }
        onRefreshWalletConnection={(walletId) =>
          runWalletCommand(() => application.getWalletConnectionState(walletId))
        }
        onRegisterWallet={async (wallet) => {
          const registered = await runCommand(() =>
            application.registerWallet(wallet),
          );

          if (registered) {
            const id = application.selectedWalletId();
            setSelectedWalletId(id);
            if (id) void runWalletCommand(() => application.beginWalletConnection(id, wallet.name));
          }

          return registered;
        }}
        onRemoveWallet={async (walletId) => {
          setCommandPending(true);
          setCommandBanner(null);
          try {
            const removed = await application.removeWallet(walletId);

            if (!removed) {
              showCommandBanner(
                t('The wallet could not be removed safely. Wait for current wallet operations and retry.'),
              );
              return false;
            }

            if (selectedWalletId === walletId) {
              selectWallet(null);
            }

            return true;
          } catch {
            showCommandBanner(
              t('The wallet could not be removed safely. Review diagnostics and retry.'),
            );
            return false;
          } finally {
            setCommandPending(false);
          }
        }}
        onSelectWallet={selectWallet}
        onExportDiagnostics={() => application.exportDiagnostics()}
        runtimeState={runtimeState}
        runtimeStates={runtimeStates}
        selectedWalletId={selectedWalletId}
          wallets={wallets}
        />
      </DesktopLayout>
    </div>
  );
}
