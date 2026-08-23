import {
  PRODUCTION_TAP_PACING,
  type TapPacingSource,
} from '../mining/product/MiningPacing';
import type { BeeNativeSdkFactory } from '../services/bee/BeeNativeSdk';
import { TeamGoshBeeNativeSdk } from '../services/bee/BeeNativeSdk';
import { BeeSdkGateway } from '../services/bee/BeeSdkGateway';
import { BeeWalletConnectionAdapter } from '../services/bee/BeeWalletConnectionAdapter';
import { BeeWalletBalanceSource } from '../services/bee/BeeWalletBalanceSource';
import type { BeeSdkRuntimeAdapter } from '../services/bee/contracts';
import { TeamGoshBeeSdkRuntimeAdapter } from '../services/bee/TeamGoshBeeSdkRuntimeAdapter';
import { CoreEventEmitter } from '../shared/events';
import type { RewardRecord } from '../shared/rewards';
import type { MamaBoardLevelSource } from '../shared/wallets';
import {
  ElectronStorageAdapter,
  type ApplicationStorageContract,
  type GlobalMiningUptimeStorageContract,
  type MainEpochStartStorageContract,
  type SecureReferenceStorageContract,
  type WalletAnalyticsStorageContract,
} from '../storage';
import {
  CANONICAL_CHAIN_STATE_NOT_CONFIGURED,
  CanonicalChainStateMonitor,
  type CanonicalChainStateProvider,
} from './CanonicalChainState';
import {
  MinerApplicationService,
  type ComputerShutdownRequester,
  type MinerApplication,
  type ProductionApplicationServices,
} from './MinerApplicationService';
import {
  resolveProductionConfiguration,
  type MinerProductionConfigurationInput,
  type ResolvedProductionConfiguration,
} from './productionConfiguration';
import {
  RuntimePreflight,
} from './RuntimePreflight';
import {
  RuntimeDiagnostics,
  type RuntimeDiagnostic,
} from './RuntimeDiagnostics';
import {
  REWARD_HOT_HISTORY_LIMIT_PER_WALLET,
  RewardLedger,
} from './RewardLedger';
import { WalletRegistry } from './WalletRegistry';
import {
  WalletConnectionService,
  type WalletSecureState,
} from './WalletConnectionService';
import { SystemObservability } from './SystemObservability';
import type { WalletBalanceSource } from './runtimeAnalytics';
import { GlobalMiningUptime } from './GlobalMiningUptime';
import { ProductMiningIdentityAdapter } from '../mining/product/MiningIdentityAdapter';
import { ShadowMiningPreflight } from '../mining/product/ShadowMiningPreflight';
import { WALLET_MINING_RUNTIME_CONSTRUCTIBILITY_INSPECTOR } from '../mining/composition/WalletMiningRuntimeConstructibility';
import { WalletMiningRuntimeFactory } from '../mining/composition/WalletMiningRuntimeFactory';
import {
  BeeMiningNativeAdapter,
  TeamGoshBee4MiningNativeSdkAccess,
} from '../mining/bee/BeeMiningNativeAdapter';
import { ElectronBeeMiningNativeAdapter } from '../mining/bee/ElectronBeeMiningNativeAdapter';
import type { MiningNativeAdapter } from '../mining/WalletMiningRuntime';
import { ProductCanonicalMiniEpochAdapter } from '../mining/product/CanonicalMiniEpochAdapter';
import { IsolatedMiningDiagnosticSink } from '../mining/product/IsolatedMiningDiagnosticSink';
import { SpacedRewardDispatchLimiter } from '../mining/product/SpacedRewardDispatchLimiter';
import { SpacedPrepareDispatchLimiter } from '../mining/product/SpacedPrepareDispatchLimiter';
import { AdaptiveQueuePressureController } from '../mining/product/AdaptiveQueuePressureController';
import { SpacedStartDispatchLimiter } from '../mining/product/SpacedStartDispatchLimiter';
import { SubmissionCriticalSection } from '../mining/product/SubmissionCriticalSection';
import { MiningRuntimeRouter } from './MiningRuntimeRouter';
import {
  WalletMiningWorkerDiagnosticBridge,
  WalletMiningWorkerProductAdapter,
} from './WalletMiningWorkerProductAdapter';

type MinerApplicationStorage = ApplicationStorageContract<RuntimeDiagnostic> &
  Partial<SecureReferenceStorageContract> &
  Partial<WalletAnalyticsStorageContract> &
  Partial<GlobalMiningUptimeStorageContract> &
  Partial<MainEpochStartStorageContract>;

export interface CreateMinerApplicationOptions {
  readonly storage?: MinerApplicationStorage;
  readonly configuration?: MinerProductionConfigurationInput;
  readonly beeRuntimeAdapter?: BeeSdkRuntimeAdapter;
  readonly beeNativeSdk?: BeeNativeSdkFactory;
  readonly tapPacing?: TapPacingSource;
  readonly canonicalChainState?: CanonicalChainStateProvider;
  readonly walletBalanceSource?: WalletBalanceSource;
  readonly mamaBoardLevelSource?: MamaBoardLevelSource;
  readonly computerShutdown?: ComputerShutdownRequester;
}

export function beeWalletDataSourceConfiguration(
  configured: Readonly<ResolvedProductionConfiguration>,
) {
  return Object.freeze({
    endpoints: configured.endpoints,
    mamaBoardEndpoint: configured.mamaBoardEndpoint,
    apiUrl: configured.apiUrl,
    appId: configured.appId,
  });
}

export async function createMinerApplication(
  storageOrOptions: MinerApplicationStorage | CreateMinerApplicationOptions = {},
): Promise<MinerApplication> {
  const options: CreateMinerApplicationOptions = isStorage(storageOrOptions)
    ? Object.freeze({ storage: storageOrOptions })
    : storageOrOptions;
  const storage =
    options.storage ?? new ElectronStorageAdapter<RuntimeDiagnostic>();
  const secureStorage = isSecureStorage(storage) ? storage : null;
  const eventBus = new CoreEventEmitter();
  const configuration = resolveProductionConfiguration(options.configuration);
  const gateway = new BeeSdkGateway(
    options.beeRuntimeAdapter ?? new TeamGoshBeeSdkRuntimeAdapter(),
    eventBus,
  );
  const [walletDefinitions, diagnosticHistory] = await Promise.all([
    storage.listWallets(),
    storage.recentDiagnostics(500),
  ]);
  const rewardHistory = (
    await Promise.all(
      walletDefinitions.map((wallet) =>
        storage.rewardsForWallet(
          wallet.id,
          REWARD_HOT_HISTORY_LIMIT_PER_WALLET,
        ),
      ),
    )
  ).flat() as readonly RewardRecord[];
  const initialBalanceSnapshots = (
    await Promise.all(
      walletDefinitions.map(
        (wallet) => storage.walletBalanceSnapshots?.(wallet.id, 1) ?? [],
      ),
    )
  ).flat();
  const initialSessionResults = (
    await Promise.all(
      walletDefinitions.map(
        (wallet) => storage.walletSessionResults?.(wallet.id, 5) ?? [],
      ),
    )
  ).flat();
  const diagnostics = new RuntimeDiagnostics(
    eventBus,
    500,
    diagnosticHistory,
    storage,
  );
  const walletRegistry = new WalletRegistry(walletDefinitions);
  const rewardLedger = new RewardLedger(eventBus, rewardHistory, storage);
  const nativeSdk = options.beeNativeSdk ?? new TeamGoshBeeNativeSdk();
  const configured = configuration.value;
  let walletConnectionAdapter: BeeWalletConnectionAdapter | null = null;
  const defaultWalletDataSource = configured
    ? new BeeWalletBalanceSource(
        gateway,
        beeWalletDataSourceConfiguration(configured),
      )
    : undefined;
  const walletBalanceSource =
    options.walletBalanceSource ??
    defaultWalletDataSource;
  const mamaBoardLevelSource =
    options.mamaBoardLevelSource ?? defaultWalletDataSource;

  if (configured && secureStorage) {
    walletConnectionAdapter = new BeeWalletConnectionAdapter(
      gateway,
      secureStorage,
      configured,
      nativeSdk,
      eventBus,
    );
  }

  const tapPacing = options.tapPacing ?? PRODUCTION_TAP_PACING;
  const submissionGuard = new SubmissionCriticalSection();
  // The canonical clock must keep observing chain boundaries during settlement.
  // The guard below is reserved for background wallet reads and new prepares.
  const canonicalChainState =
    options.canonicalChainState ??
    (configured
      ? new CanonicalChainStateMonitor(
          configured.canonicalEndpoint,
          globalThis.fetch,
          () => Date.now(),
        )
      : CANONICAL_CHAIN_STATE_NOT_CONFIGURED);
  void canonicalChainState.synchronize();
  let observabilityEventSequence = 0;
  let miningRuntimeRouter: MiningRuntimeRouter | null = null;
  let observedMiniEpoch = canonicalChainState.snapshot().miniEpochStart;
  const unsubscribeEpochDiagnostics = canonicalChainState.subscribe(() => {
    const snapshot = canonicalChainState.snapshot();
    const currentMiniEpoch = snapshot.miniEpochStart;

    if (
      snapshot.status !== 'live' ||
      !currentMiniEpoch ||
      currentMiniEpoch === observedMiniEpoch
    ) {
      return;
    }

    const previousMiniEpoch = observedMiniEpoch;
    observedMiniEpoch = currentMiniEpoch;
    observabilityEventSequence += 1;
    try {
      eventBus.publish({
        id: `epoch-changed:${observabilityEventSequence}`,
        occurredAt: snapshot.updatedAt ?? new Date().toISOString(),
        type: 'epoch-changed',
        payload: {
          previousMiniEpoch,
          miniEpoch: currentMiniEpoch,
          mainEpoch: snapshot.mainEpoch.id,
          currentBlock: snapshot.currentBlock,
          confidence:
            snapshot.confidence === 'estimated' ? 'estimated' : 'canonical',
          lastFailureCode: snapshot.lastFailureCode,
        },
      });
    } catch {
      // Observability cannot control canonical epoch monitoring.
    }
  });
  const preflight = new RuntimePreflight(
    configuration,
    gateway,
    walletRegistry,
    secureStorage,
    null,
    walletConnectionAdapter,
    tapPacing,
    (walletId) => miningRuntimeRouter?.status(walletId) ?? 'idle',
  );
  const miningIdentity = new ProductMiningIdentityAdapter(
    preflight,
    configuration,
    walletRegistry,
    secureStorage ?? Object.freeze({
      loadSecureValue: async () => null,
    }),
  );
  const shadowPreflight = new ShadowMiningPreflight(
    miningIdentity,
    WALLET_MINING_RUNTIME_CONSTRUCTIBILITY_INSPECTOR,
  );
  const initialGenerationByWallet = new Map<string, number>();
  for (const result of initialSessionResults) {
    initialGenerationByWallet.set(
      result.walletId,
      Math.max(
        initialGenerationByWallet.get(result.walletId) ?? 0,
        result.generation,
      ),
    );
  }
  const workerDiagnostics = new WalletMiningWorkerDiagnosticBridge(
    eventBus,
    (walletId, generationToken) =>
      miningRuntimeRouter?.productGeneration(walletId, generationToken) ?? null,
  );
  const miningNativeAdapter = productionMiningNativeAdapter(options, nativeSdk);
  let activeMiningFleetSize = (): number => 1;
  const queuePressureController = new AdaptiveQueuePressureController(
    () => activeMiningFleetSize(),
  );
  const newRuntimeFactory = new WalletMiningRuntimeFactory({
    miningIdentity,
    nativeAdapter: miningNativeAdapter,
    canonicalEpochSource: new ProductCanonicalMiniEpochAdapter(
      canonicalChainState,
    ),
    diagnostics: new IsolatedMiningDiagnosticSink(workerDiagnostics),
    prepareLimiter: new SpacedPrepareDispatchLimiter(),
    startLimiter: new SpacedStartDispatchLimiter(() =>
      queuePressureController.startSpacingMs(activeMiningFleetSize())),
    queuePressureController,
    rewardLimiter: new SpacedRewardDispatchLimiter(),
    submissionGuard,
    fleetSize: () => activeMiningFleetSize(),
    automaticContinuationEnabled: true,
    ...(configured
      ? {
          pacingPolicy: {
            sessionDurationMs: configured.maximumSessionDurationMs,
          },
        }
      : {}),
  });
  miningRuntimeRouter = new MiningRuntimeRouter({
    newRuntimeFactory,
    shadowPreflight,
    createProductAdapter: (runtime) =>
      new WalletMiningWorkerProductAdapter(runtime, {
        eventPublisher: eventBus,
        walletRegistry,
        initialGeneration:
          initialGenerationByWallet.get(runtime.walletId) ?? 0,
      }),
    newProductSessionAvailable: (walletId) =>
      walletRegistry.wallet(walletId)?.session === null,
  });
  const initialWalletSecurity = new Map<string, Readonly<WalletSecureState>>(
    await Promise.all(
      walletDefinitions.map(async (wallet) => [
        wallet.id,
        Object.freeze({
          connectionStateStored: await secureReferenceState(
            secureStorage,
            wallet.connectionReference,
          ),
          miningCredentialStored: await secureReferenceState(
            secureStorage,
            wallet.miningCredentialReference,
          ),
        }),
      ] as const),
    ),
  );
  const production: ProductionApplicationServices = Object.freeze({
    configuration: configuration.snapshot,
    gateway,
    preflight,
    shadowPreflight,
    tapPacing,
    canonicalChainState,
    backgroundReadGate: submissionGuard,
    walletConnection: Object.freeze({
      configuration: configuration.snapshot,
      capability: walletConnectionAdapter,
      secureStorageAvailable: secureStorage !== null,
      initialWalletSecurity,
      secureReferenceExists: (reference: string) =>
        secureStorage?.hasSecureValue(reference) ?? Promise.resolve(false),
    }),
    forgetWalletState: (walletId: string) => {
      preflight.forgetWallet(walletId);
    },
    dispose: async () => {
      unsubscribeEpochDiagnostics();
      canonicalChainState.dispose();
      preflight.dispose();
      await gateway.dispose();
    },
  });
  const walletConnections = new WalletConnectionService(
    walletRegistry,
    storage,
    production.walletConnection,
  );
  const systemObservability = new SystemObservability(
    typeof window === 'undefined'
      ? undefined
      : window.minerCoreApp?.observability,
  );
  systemObservability.start();
  const globalMiningUptime = isGlobalMiningUptimeStorage(storage)
    ? await GlobalMiningUptime.hydrate(storage)
    : GlobalMiningUptime.transient();
  const mainEpochStartStorage = isMainEpochStartStorage(storage)
    ? storage
    : null;
  const initialMainEpochStart = mainEpochStartStorage
    ? await mainEpochStartStorage.loadMainEpochStartSchedule().catch(() => null)
    : null;
  const computerShutdown = options.computerShutdown ?? Object.freeze({
    shutdownComputer: () =>
      typeof window === 'undefined' || !window.minerCoreApp?.system
        ? Promise.resolve('unsupported' as const)
        : window.minerCoreApp.system.shutdownComputer(),
  });

  const application = new MinerApplicationService(
    eventBus,
    diagnostics,
    {
      walletRegistry,
      rewardLedger,
      walletBalanceSource,
      mamaBoardLevelSource,
      initialBalanceSnapshots,
      initialSessionResults,
    },
    storage,
    production,
    walletConnections,
    undefined,
    eventBus,
    systemObservability,
    globalMiningUptime,
    computerShutdown,
    miningRuntimeRouter,
    mainEpochStartStorage ?? undefined,
    initialMainEpochStart,
  );
  activeMiningFleetSize = () => application.activeMiningWalletCount();
  void application.refreshWalletBalances();
  return application;
}

function productionMiningNativeAdapter(
  options: Readonly<CreateMinerApplicationOptions>,
  nativeSdk: BeeNativeSdkFactory,
): MiningNativeAdapter {
  if (!options.beeRuntimeAdapter && !options.beeNativeSdk) {
    const bridge = globalThis.window?.minerCoreApp?.beeMining;
    if (bridge) return new ElectronBeeMiningNativeAdapter(bridge);
  }
  return new BeeMiningNativeAdapter(
    new TeamGoshBee4MiningNativeSdkAccess(
      options.beeRuntimeAdapter ?? new TeamGoshBeeSdkRuntimeAdapter(),
      nativeSdk,
    ),
  );
}

function isGlobalMiningUptimeStorage(
  storage: MinerApplicationStorage,
): storage is MinerApplicationStorage & GlobalMiningUptimeStorageContract {
  return (
    typeof storage.globalMiningUptimeSnapshot === 'function' &&
    typeof storage.startGlobalMiningUptime === 'function' &&
    typeof storage.heartbeatGlobalMiningUptime === 'function' &&
    typeof storage.stopGlobalMiningUptime === 'function'
  );
}

function isMainEpochStartStorage(
  storage: MinerApplicationStorage,
): storage is MinerApplicationStorage & MainEpochStartStorageContract {
  return (
    typeof storage.loadMainEpochStartSchedule === 'function' &&
    typeof storage.saveMainEpochStartSchedule === 'function'
  );
}

async function secureReferenceState(
  storage: SecureReferenceStorageContract | null,
  reference: string | null | undefined,
): Promise<boolean | null> {
  if (!reference) {
    return false;
  }

  if (!storage) {
    return false;
  }

  try {
    return await storage.hasSecureValue(reference);
  } catch {
    return null;
  }
}

function isStorage(
  value: MinerApplicationStorage | CreateMinerApplicationOptions,
): value is MinerApplicationStorage {
  return 'listWallets' in value;
}

function isSecureStorage(
  storage: MinerApplicationStorage,
): storage is ApplicationStorageContract<RuntimeDiagnostic> &
  SecureReferenceStorageContract {
  return (
    typeof storage.saveSecureValue === 'function' &&
    typeof storage.hasSecureValue === 'function' &&
    typeof storage.loadSecureValue === 'function' &&
    typeof storage.removeSecureValue === 'function'
  );
}
