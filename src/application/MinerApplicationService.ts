import {
  CORE_EVENT_TYPES,
  type CoreEvent,
  type CoreEventPayloads,
  type CoreEventType,
  type EventObserver,
  type EventPublisher,
} from '../shared/events';
import type {
  EpochPresentation,
  EpochPresentationStatus,
  EpochWindowPresentation,
  RuntimePresentationState,
  WalletRuntimePresentationStates,
} from './runtimeState';
import type { BeeSdkGatewayContract } from '../services/bee/contracts';
import type { RewardLedgerContract, RewardRecord } from '../shared/rewards';
import {
  classifyBeeFailureText,
  type BeeFailureClassification,
} from '../shared/beeFailures';
import type {
  MamaBoardLevelSource,
  WalletRegistryContract,
  WalletSnapshot,
} from '../shared/wallets';
import type {
  MainEpochStartPersistenceSnapshot,
  MainEpochStartStorageContract,
  WalletAnalyticsStorageContract,
  WalletConfigurationStorageContract,
} from '../storage/contracts';
import {
  redactDiagnosticText,
  RuntimeDiagnostics,
  type RuntimeDiagnostic,
  type RuntimeDiagnosticListener,
  type RuntimeDiagnosticsSource,
} from './RuntimeDiagnostics';
import type {
  WalletPresentation,
  WalletRewardPresentation,
} from './walletState';
import type {
  MinerOperatorState,
  MainEpochStartSnapshot,
  TimedMiningSnapshot,
} from './operatorState';
import type { ProductionConfigurationSnapshot } from './productionConfiguration';
import type {
  MiningPreflightReasonCode,
  MiningPreflightResult,
  RuntimePreflight,
  TapPacingReadinessSource,
} from './RuntimePreflight';
import type {
  ShadowMiningPreflightCapability,
  ShadowMiningPreflightResult,
} from '../mining/product/ShadowMiningPreflight';
import {
  CANONICAL_CHAIN_STATE_NOT_CONFIGURED,
  type CanonicalChainStateProvider,
  type EpochWindowSnapshot,
} from './CanonicalChainState';
import {
  WalletConnectionService,
  type WalletConnectionCommandResult,
  type WalletConnectionOperations,
  type WalletConnectionProductionServices,
} from './WalletConnectionService';
import {
  SystemObservability,
  type DiagnosticsExportResult,
  type SystemMetricsListener,
  type SystemMetricsSnapshot,
  type SystemObservabilitySource,
} from './SystemObservability';
import {
  aggregateDailyNacklRewardRecords,
  aggregateWalletBalances,
  positiveLockedNacklDelta,
  type WalletBalanceSnapshot,
  type WalletBalanceSource,
  type WalletFinancialOverview,
  type WalletRecoveryHistoryEntry,
  type WalletRecoveryPresentation,
  type WalletRecoveryState,
  type WalletRewardDelta,
  type WalletSessionResult,
  type WalletStopReason,
} from './runtimeAnalytics';
import { GlobalMiningUptime } from './GlobalMiningUptime';
import {
  MiningRuntimeRouter,
  type MiningStartSource,
} from './MiningRuntimeRouter';
import type { WalletMiningSubmissionGuard } from '../mining/WalletMiningRuntime';
import { SpacedBackgroundReadDispatcher } from './SpacedBackgroundReadDispatcher';

export type {
  WalletApprovalPresentation,
  WalletConnectionCommandResult,
  WalletConnectionReasonCode,
} from './WalletConnectionService';

export type ApplicationLifecycleEvent<TType extends CoreEventType = CoreEventType> = {
  [Type in TType]: Readonly<{
    id: string;
    occurredAt: string;
    type: Type;
    payload: Readonly<CoreEventPayloads[Type]>;
  }>;
}[TType];

export interface RuntimePresentationUpdate {
  readonly scope: 'all' | 'wallet' | 'canonical';
  readonly walletId: string | null;
  readonly currentRuntimeState: RuntimePresentationState | null;
  readonly runtimeStates: WalletRuntimePresentationStates;
  readonly canonicalEpochs?: Readonly<EpochPresentation>;
}

export type RuntimeUpdateListener = (
  update: Readonly<RuntimePresentationUpdate>,
) => void;
export type LifecycleEventListener = (event: ApplicationLifecycleEvent) => void;

export interface WalletPresentationUpdate {
  readonly scope: 'all' | 'wallet';
  readonly walletId: string | null;
  readonly wallets: readonly WalletPresentation[];
  readonly financialChanged: boolean;
}

export type WalletUpdateListener = (
  update: Readonly<WalletPresentationUpdate>,
) => void;

export interface WalletRegistration {
  readonly name: string;
}

export interface MiningCommandResult {
  readonly accepted: boolean;
  readonly reasonCode:
    | MiningPreflightReasonCode
    | 'started'
    | 'stopped'
    | 'runtime-not-active'
    | 'runtime-start-failed'
    | 'runtime-stop-failed'
    | 'new-worker-shadow-blocked'
    | 'new-worker-shadow-error'
    | 'new-worker-construction-failed'
    | 'new-worker-not-configured'
    | 'new-worker-product-session-conflict'
    | 'new-worker-quarantined'
    | 'new-worker-disposal-failed'
    | 'new-worker-wallet-required'
    | 'runtime-already-active';
  readonly message: string;
  readonly walletId: string | null;
}

export interface MiningBatchCommandResult {
  readonly accepted: boolean;
  readonly reasonCode:
    | 'all-started'
    | 'partially-started'
    | 'no-startable-wallets'
    | 'all-stopped'
    | 'partially-stopped'
    | 'no-active-runtimes';
  readonly message: string;
  readonly results: readonly Readonly<MiningCommandResult>[];
}

export interface TimedMiningCommandResult {
  readonly accepted: boolean;
  readonly reasonCode:
    | 'timed-mining-armed'
    | 'timed-mining-cancelled'
    | 'timed-mining-inactive'
    | 'timed-mining-already-active'
    | 'timed-mining-invalid-duration';
  readonly message: string;
}

export interface MainEpochStartCommandResult {
  readonly accepted: boolean;
  readonly reasonCode:
    | 'main-epoch-start-armed'
    | 'main-epoch-start-cancelled'
    | 'main-epoch-start-inactive'
    | 'main-epoch-start-already-active'
    | 'main-epoch-start-invalid-delay'
    | 'main-epoch-start-chain-unavailable';
  readonly message: string;
}

export type ComputerShutdownResult =
  | 'requested'
  | 'unsupported'
  | 'failed'
  | 'busy';

export interface ComputerShutdownRequester {
  shutdownComputer(): Promise<ComputerShutdownResult>;
}

export interface WalletSelectionResult {
  readonly selected: boolean;
  readonly walletId: string | null;
  readonly reasonCode:
    | 'selected'
    | 'cleared'
    | 'wallet-not-found';
}

export interface MinerApplication {
  startMining(): Promise<Readonly<MiningCommandResult>>;
  stopMining(): Promise<void>;
  startWalletMining(
    walletId: string,
  ): Promise<Readonly<MiningCommandResult>>;
  stopWalletMining(
    walletId: string,
  ): Promise<Readonly<MiningCommandResult>>;
  startAllMining(): Promise<Readonly<MiningBatchCommandResult>>;
  stopAllMining(): Promise<Readonly<MiningBatchCommandResult>>;
  startTimedMining(
    durationHours: number,
    shutdownAfterCompletion: boolean,
  ): Promise<Readonly<TimedMiningCommandResult>>;
  cancelTimedMining(): Readonly<TimedMiningCommandResult>;
  armMainEpochMiningStart(
    delayHours: number,
  ): Readonly<MainEpochStartCommandResult>;
  cancelMainEpochMiningStart(): Readonly<MainEpochStartCommandResult>;
  selectWallet(walletId: string | null): Readonly<WalletSelectionResult>;
  selectedWalletId(): string | null;
  preflightMining(): Promise<Readonly<MiningPreflightResult>>;
  shadowPreflightMining(
    walletId?: string,
  ): Promise<Readonly<ShadowMiningPreflightResult>>;
  beginWalletConnection(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  prepareWalletMiningCredential(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  verifyWalletMiningCredentialPropagation(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  disconnectWallet(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  getWalletConnectionState(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  getOperatorState(): Readonly<MinerOperatorState>;
  getCurrentRuntimeState(): RuntimePresentationState;
  getRuntimeStates(): WalletRuntimePresentationStates;
  subscribeToRuntimeUpdates(listener: RuntimeUpdateListener): () => void;
  subscribeToLifecycleEvents(listener: LifecycleEventListener): () => void;
  getDiagnostics(): readonly RuntimeDiagnostic[];
  subscribeToDiagnostics(listener: RuntimeDiagnosticListener): () => void;
  getSystemMetrics(): Readonly<SystemMetricsSnapshot>;
  subscribeToSystemMetrics(listener: SystemMetricsListener): () => void;
  exportDiagnostics(): Promise<Readonly<DiagnosticsExportResult>>;
  getWallets(): readonly WalletPresentation[];
  getFinancialOverview(): Readonly<WalletFinancialOverview>;
  getRecoveryHistory(walletId?: string): readonly WalletRecoveryHistoryEntry[];
  getBalanceSnapshots(walletId?: string): readonly WalletBalanceSnapshot[];
  getRewardDeltas(walletId?: string): readonly WalletRewardDelta[];
  getSessionResults(walletId?: string): readonly WalletSessionResult[];
  refreshWalletBalances(walletId?: string): Promise<void>;
  registerWallet(wallet: WalletRegistration): Promise<void>;
  removeWallet(walletId: string): Promise<boolean>;
  subscribeToWalletUpdates(listener: WalletUpdateListener): () => void;
  dispose(): Promise<void>;
}

export interface ProductionApplicationServices {
  readonly configuration: Readonly<ProductionConfigurationSnapshot>;
  readonly gateway: BeeSdkGatewayContract;
  readonly preflight: Pick<RuntimePreflight, 'assess' | 'preview'>;
  readonly shadowPreflight?: ShadowMiningPreflightCapability;
  readonly tapPacing: TapPacingReadinessSource;
  readonly canonicalChainState: CanonicalChainStateProvider;
  readonly backgroundReadGate?: Pick<
    WalletMiningSubmissionGuard,
    'waitUntilIdle'
  > & Partial<Pick<WalletMiningSubmissionGuard, 'acquireIdleLease'>>;
  readonly walletConnection: Readonly<WalletConnectionProductionServices>;
  forgetWalletState?(walletId: string): void;
  dispose(): Promise<void>;
}

export interface ApplicationDataSources {
  readonly walletRegistry: Pick<
    WalletRegistryContract,
    | 'wallet'
    | 'wallets'
    | 'registerWallet'
    | 'removeWallet'
    | 'updateConnection'
    | 'updateMamaBoardLevel'
  >;
  readonly rewardLedger: Pick<
    RewardLedgerContract,
    'recordReward' | 'rewardsForWallet' | 'forgetWallet'
  >;
  readonly walletBalanceSource?: WalletBalanceSource;
  readonly mamaBoardLevelSource?: MamaBoardLevelSource;
  readonly initialBalanceSnapshots?: readonly Readonly<WalletBalanceSnapshot>[];
  readonly initialSessionResults?: readonly Readonly<WalletSessionResult>[];
}

const EMPTY_APPLICATION_DATA: ApplicationDataSources = Object.freeze({
  walletRegistry: Object.freeze({
    wallet: () => null,
    wallets: () => Object.freeze([]),
    registerWallet: () => {
      throw new Error('Wallet registry is not configured.');
    },
    removeWallet: () => null,
    updateConnection: () => false,
    updateMamaBoardLevel: () => false,
  }),
  rewardLedger: Object.freeze({
    recordReward: async () => null,
    rewardsForWallet: () => Object.freeze([]),
  }),
});

export class MinerApplicationService implements MinerApplication {
  readonly #runtimeRouter: MiningRuntimeRouter;
  readonly #eventObserver: EventObserver;
  readonly #eventPublisher?: EventPublisher;
  readonly #systemObservability: SystemObservabilitySource;
  readonly #diagnostics: RuntimeDiagnosticsSource;
  readonly #applicationData: ApplicationDataSources;
  readonly #walletListeners = new Set<WalletUpdateListener>();
  readonly #walletStorage?: Pick<
    WalletConfigurationStorageContract,
    'saveWallet' | 'removeWallet'
  > & Partial<WalletAnalyticsStorageContract>;
  readonly #production?: ProductionApplicationServices;
  readonly #walletConnections: WalletConnectionOperations;
  readonly #walletIdFactory: () => string;
  readonly #unsubscribeFromWalletConnections: () => void;
  readonly #unsubscribeFromApplicationEvents: () => void;
  readonly #unsubscribeFromSystemObservability: () => void;
  readonly #desiredMiningWallets = new Set<string>();
  readonly #globalMiningUptime: GlobalMiningUptime;
  readonly #computerShutdown: ComputerShutdownRequester;
  readonly #mainEpochStartStorage?: MainEpochStartStorageContract;
  readonly #recoveryByWallet = new Map<string, WalletRecoveryPresentation>();
  readonly #recoveryHistoryByWallet = new Map<
    string,
    readonly WalletRecoveryHistoryEntry[]
  >();
  readonly #rewardVerifications = new Map<string, Promise<void>>();
  readonly #balanceByWallet = new Map<string, WalletBalanceSnapshot>();
  readonly #balanceReads = new Map<string, Promise<void>>();
  readonly #mamaBoardReads = new Map<string, Promise<void>>();
  readonly #backgroundReadDispatcher = new SpacedBackgroundReadDispatcher();
  readonly #pendingBalanceReads = new Map<
    string,
    Readonly<{
      sessionId: string | null;
      generation: number | null;
      source: WalletRewardDelta['source'];
    }>
  >();
  readonly #balanceSyncKeys = new Set<string>();
  readonly #sessionResultsByWallet = new Map<
    string,
    readonly WalletSessionResult[]
  >();
  readonly #sessionDrafts = new Map<string, WalletSessionResult>();
  readonly #latestLiveRewardByWallet = new Map<string, WalletRewardDelta>();
  readonly #walletRemovals = new Map<string, Promise<boolean>>();
  #mamaBoardRefreshTimer: ReturnType<typeof setInterval> | null = null;
  #mamaBoardRefresh: Promise<void> | null = null;
  #runtimeStartEventSequence = 0;
  #timedMiningSequence = 0;
  #timedMiningTimer: ReturnType<typeof setTimeout> | null = null;
  #timedMining: Readonly<TimedMiningSnapshot> = INACTIVE_TIMED_MINING;
  #mainEpochStartSequence = 0;
  #mainEpochStartTimer: ReturnType<typeof setTimeout> | null = null;
  #mainEpochStart: Readonly<MainEpochStartSnapshot> =
    INACTIVE_MAIN_EPOCH_START;
  #mainEpochStartPersistence: Promise<void> = Promise.resolve();
  #selectedWalletId: string | null = null;
  #disposed = false;
  #disposal: Promise<void> | null = null;

  constructor(
    eventObserver: EventObserver,
    diagnostics: RuntimeDiagnosticsSource = new RuntimeDiagnostics(eventObserver),
    applicationData: ApplicationDataSources = EMPTY_APPLICATION_DATA,
    walletStorage?: Pick<
      WalletConfigurationStorageContract,
      'saveWallet' | 'removeWallet'
    > & Partial<WalletAnalyticsStorageContract>,
    production?: ProductionApplicationServices,
    walletConnections?: WalletConnectionOperations,
    walletIdFactory: () => string = createWalletId,
    eventPublisher?: EventPublisher,
    systemObservability: SystemObservabilitySource = new SystemObservability(),
    globalMiningUptime: GlobalMiningUptime = GlobalMiningUptime.transient(),
    computerShutdown: ComputerShutdownRequester = UNSUPPORTED_COMPUTER_SHUTDOWN,
    miningRuntimeRouter?: MiningRuntimeRouter,
    mainEpochStartStorage?: MainEpochStartStorageContract,
    initialMainEpochStart?: Readonly<MainEpochStartPersistenceSnapshot> | null,
  ) {
    this.#runtimeRouter = miningRuntimeRouter ?? new MiningRuntimeRouter({});
    this.#eventObserver = eventObserver;
    this.#eventPublisher = eventPublisher;
    this.#systemObservability = systemObservability;
    this.#globalMiningUptime = globalMiningUptime;
    this.#computerShutdown = computerShutdown;
    this.#mainEpochStartStorage = mainEpochStartStorage;
    if (initialMainEpochStart) {
      this.#mainEpochStartSequence = 1;
      this.#mainEpochStart = Object.freeze({
        ...initialMainEpochStart,
        failureCode: null,
      });
    }
    this.#diagnostics = diagnostics;
    this.#applicationData = applicationData;
    this.#walletStorage = walletStorage;
    this.#production = production;
    this.#walletIdFactory = walletIdFactory;
    this.#walletConnections =
      walletConnections ??
      new WalletConnectionService(
        applicationData.walletRegistry,
        walletStorage,
        production?.walletConnection,
      );
    this.#unsubscribeFromWalletConnections = this.#walletConnections.subscribe(
      () => {
        this.#notifyWalletListeners();
        void this.#refreshMamaBoardLevels(false);
      },
    );
    this.#unsubscribeFromApplicationEvents = this.subscribeToAllCoreEvents(
      (event) => this.#observeApplicationEvent(event),
    );
    this.#hydrateAnalytics(applicationData);
    this.#unsubscribeFromSystemObservability = this.#systemObservability.subscribe(
      () => {
        if (this.#globalMiningUptime.heartbeat()) {
          this.#notifyWalletListeners();
        }
      },
    );
    if (applicationData.mamaBoardLevelSource) {
      queueMicrotask(() => void this.#refreshMamaBoardLevels(true));
      this.#mamaBoardRefreshTimer = setInterval(
        () => void this.#refreshMamaBoardLevels(true),
        MAMA_BOARD_REFRESH_INTERVAL_MS,
      );
    }
    if (this.#mainEpochStart.status === 'waiting-for-delay') {
      this.#scheduleMainEpochStart(this.#mainEpochStartSequence);
    } else if (this.#mainEpochStart.status === 'waiting-for-main-epoch') {
      this.#observeMainEpochForArmedStart(
        this.#production?.canonicalChainState.snapshot().mainEpoch.id ?? null,
      );
    }
  }

  async startMining(): Promise<Readonly<MiningCommandResult>> {
    return this.#startRuntime(
      this.#production ? this.#selectedWalletId : null,
      true,
    );
  }

  startWalletMining(
    walletId: string,
  ): Promise<Readonly<MiningCommandResult>> {
    if (this.#desiredMiningWallets.has(walletId)) {
      return Promise.resolve(
        this.#commandResult(
          false,
          'runtime-not-active',
          'Mining start is already requested for this wallet.',
          walletId,
        ),
      );
    }
    return this.#startRuntime(walletId, true);
  }

  activeMiningWalletCount(): number {
    return this.#desiredMiningWallets.size;
  }

  async #startRuntime(
    walletId: string | null,
    operatorRequested = false,
    requestAlreadyPublished = false,
    source: MiningStartSource = 'EXPLICIT_WALLET',
  ): Promise<Readonly<MiningCommandResult>> {
    if (this.#disposed) {
      return this.#commandResult(
        false,
        'runtime-not-active',
        'Application shutdown is in progress.',
        walletId,
      );
    }

    const observeOperatorStart = operatorRequested && walletId !== null;

    if (observeOperatorStart) {
      if (!requestAlreadyPublished) {
        this.#publishRuntimeStartStage(walletId, 'requested');
      }
      this.#publishRuntimeStartStage(walletId, 'prepare-started');
    }

    if (operatorRequested && walletId) {
      this.#requestMining(walletId);
      this.#setRecovery(walletId, 'healthy', 0, null, null, null);
    }

    const routed = await this.#runtimeRouter.start({ walletId, source });

    if (routed.accepted) {
      if (observeOperatorStart && walletId) {
        this.#publishRuntimeStartStage(walletId, 'running-reached');
      }
      return this.#commandResult(
        true,
        routed.reasonCode as MiningCommandResult['reasonCode'],
        routed.message,
        walletId,
      );
    }

    if (
      operatorRequested &&
      walletId &&
      !this.#runtimeRouter.retainsDesiredMining(walletId)
    ) {
      this.#releaseMining(walletId);
      const reason: WalletStopReason =
        routed.reasonCode === 'wallet-onboarding-incomplete'
          ? 'wallet-not-ready'
          : routed.reasonCode === 'mining-credential-propagation-failed'
            ? 'propagation-failed'
            : 'unknown';
      this.#markActiveSessionStopReason(walletId, reason);
    }

    return this.#commandResult(
      false,
      routed.reasonCode as MiningCommandResult['reasonCode'],
      routed.message,
      walletId,
    );
  }

  async stopMining(): Promise<void> {
    await this.#stopRuntime(
      this.#production ? this.#selectedWalletId : null,
      true,
      true,
      'OPERATOR',
    );
  }

  stopWalletMining(
    walletId: string,
  ): Promise<Readonly<MiningCommandResult>> {
    return this.#stopRuntime(walletId, false, true, 'OPERATOR');
  }

  async startAllMining(
    source: Extract<MiningStartSource, 'START_ALL' | 'MAIN_EPOCH'> =
      'START_ALL',
  ): Promise<Readonly<MiningBatchCommandResult>> {
    if (this.#disposed) {
      return this.#batchCommandResult(
        false,
        'no-startable-wallets',
        'Application shutdown is in progress.',
        [],
      );
    }

    const startableWalletIds = this.#applicationData.walletRegistry
      .wallets()
      .filter(
        (wallet) =>
          wallet.onboardingStatus === 'ready' &&
          !this.#desiredMiningWallets.has(wallet.id) &&
          this.#runtimeRouter.status(wallet.id) === 'idle',
      )
      .map((wallet) => wallet.id);

    if (startableWalletIds.length === 0) {
      return this.#batchCommandResult(
        false,
        'no-startable-wallets',
        'No mining-ready idle wallet runtime is available to start.',
        [],
      );
    }

    const operations = startableWalletIds.map((walletId, index) => {
      this.#requestMining(walletId);
      this.#publishRuntimeStartStage(walletId, 'requested');
      return this.#startWalletMiningAfterStagger(
        walletId,
        index * START_ALL_STAGGER_MS,
        source,
      );
    });
    const settledResults = await Promise.allSettled(operations);
    const results = settledResults.map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : this.#commandResult(
            false,
            'runtime-start-failed',
            'Wallet runtime start failed. Review diagnostics and retry.',
            startableWalletIds[index] ?? null,
          ),
    );

    const accepted = results.every((result) => result.accepted);
    return this.#batchCommandResult(
      accepted,
      accepted ? 'all-started' : 'partially-started',
      accepted
        ? 'All mining-ready wallet runtimes were started.'
        : 'Some wallet runtimes could not be started. Review diagnostics.',
      results,
    );
  }

  async #startWalletMiningAfterStagger(
    walletId: string,
    delayMs: number,
    source: Extract<MiningStartSource, 'START_ALL' | 'MAIN_EPOCH'>,
  ): Promise<Readonly<MiningCommandResult>> {
    if (delayMs > 0) {
      await waitFor(delayMs);
    }

    if (this.#disposal || !this.#desiredMiningWallets.has(walletId)) {
      return this.#commandResult(
        false,
        'runtime-not-active',
        'Mining start was cancelled before wallet preparation.',
        walletId,
      );
    }

    return this.#startRuntime(walletId, true, true, source);
  }

  async startTimedMining(
    durationHours: number,
    shutdownAfterCompletion: boolean,
  ): Promise<Readonly<TimedMiningCommandResult>> {
    if (!isWholeHoursInRange(durationHours, 1, 16)) {
      return this.#timedMiningResult(
        false,
        'timed-mining-invalid-duration',
        'Timed mining duration must be a whole number from 1 to 16 hours.',
      );
    }
    if (
      this.#timedMining.status === 'running' ||
      this.#timedMining.status === 'stopping'
    ) {
      return this.#timedMiningResult(
        false,
        'timed-mining-already-active',
        'Timed mining is already active.',
      );
    }

    const startedAt = Date.now();
    const durationMs = durationHours * HOUR_MS;
    const sequence = ++this.#timedMiningSequence;
    this.#timedMining = Object.freeze({
      status: 'running',
      startedAt,
      durationMs,
      targetEndAt: startedAt + durationMs,
      shutdownAfterCompletion,
      failureCode: null,
    });
    this.#scheduleTimedMiningCompletion(sequence);
    this.#notifyWalletListeners();

    return this.#timedMiningResult(
      true,
      'timed-mining-armed',
      'Timed stop armed. Existing mining will stop at the selected time.',
    );
  }

  cancelTimedMining(): Readonly<TimedMiningCommandResult> {
    if (
      this.#timedMining.status !== 'running' &&
      this.#timedMining.status !== 'stopping'
    ) {
      return this.#timedMiningResult(
        false,
        'timed-mining-inactive',
        'Timed mining is not active.',
      );
    }

    this.#cancelTimedMiningState();
    return this.#timedMiningResult(
      true,
      'timed-mining-cancelled',
      'Timed mining was cancelled. Current wallet runtimes were not stopped.',
    );
  }

  armMainEpochMiningStart(
    delayHours: number,
  ): Readonly<MainEpochStartCommandResult> {
    if (!isWholeHoursInRange(delayHours, 1, 24)) {
      return this.#mainEpochStartResult(
        false,
        'main-epoch-start-invalid-delay',
        'Main epoch start delay must be a whole number from 1 to 24 hours.',
      );
    }
    if (
      this.#mainEpochStart.status === 'waiting-for-main-epoch' ||
      this.#mainEpochStart.status === 'waiting-for-delay' ||
      this.#mainEpochStart.status === 'starting'
    ) {
      return this.#mainEpochStartResult(
        false,
        'main-epoch-start-already-active',
        'A Main Epoch mining start is already armed.',
      );
    }

    const chain = this.#production?.canonicalChainState.snapshot();
    const baselineMainEpoch = chain?.mainEpoch.id;
    if (chain?.status !== 'live' || !baselineMainEpoch) {
      return this.#mainEpochStartResult(
        false,
        'main-epoch-start-chain-unavailable',
        'Network synchronization is unavailable. The Main Epoch start could not be armed.',
      );
    }

    this.#mainEpochStartSequence += 1;
    this.#mainEpochStart = Object.freeze({
      status: 'waiting-for-main-epoch',
      armedAt: Date.now(),
      baselineMainEpoch,
      delayHours,
      detectedMainEpoch: null,
      epochDetectedAt: null,
      targetStartAt: null,
      failureCode: null,
    });
    this.#persistMainEpochStart();
    this.#notifyWalletListeners();
    return this.#mainEpochStartResult(
      true,
      'main-epoch-start-armed',
      'Mining start is armed for the next Main Epoch.',
    );
  }

  cancelMainEpochMiningStart(): Readonly<MainEpochStartCommandResult> {
    if (
      this.#mainEpochStart.status === 'inactive' ||
      this.#mainEpochStart.status === 'completed' ||
      this.#mainEpochStart.status === 'failed'
    ) {
      return this.#mainEpochStartResult(
        false,
        'main-epoch-start-inactive',
        'No Main Epoch mining start is armed.',
      );
    }

    this.#cancelMainEpochStartState();
    return this.#mainEpochStartResult(
      true,
      'main-epoch-start-cancelled',
      'The Main Epoch mining start was cancelled.',
    );
  }

  async stopAllMining(): Promise<Readonly<MiningBatchCommandResult>> {
    this.#cancelTimedMiningState();
    return this.#stopAllMiningRuntimes('STOP_ALL');
  }

  async #stopAllMiningRuntimes(
    reason: 'STOP_ALL' | 'TIMED_COMPLETION' = 'STOP_ALL',
  ): Promise<Readonly<MiningBatchCommandResult>> {
    const walletIds = new Set([
      ...this.#desiredMiningWallets,
      ...this.#runtimeRouter.activeWalletIds(),
    ]);

    if (walletIds.size === 0) {
      return this.#batchCommandResult(
        true,
        'no-active-runtimes',
        'No active wallet runtime needs to be stopped.',
        [],
      );
    }

    const results: Readonly<MiningCommandResult>[] = [];

    for (const walletId of walletIds) {
      results.push(await this.#stopRuntime(walletId, false, true, reason));
    }

    const accepted = results.every((result) => result.accepted);
    return this.#batchCommandResult(
      accepted,
      accepted ? 'all-stopped' : 'partially-stopped',
      accepted
        ? 'All active wallet runtimes received a stop command.'
        : 'Some wallet runtimes could not be stopped. Review diagnostics.',
      results,
    );
  }

  #scheduleTimedMiningCompletion(sequence: number): void {
    if (this.#timedMiningTimer) clearTimeout(this.#timedMiningTimer);
    const targetEndAt = this.#timedMining.targetEndAt;
    if (targetEndAt === null) return;
    this.#timedMiningTimer = setTimeout(() => {
      this.#timedMiningTimer = null;
      if (sequence !== this.#timedMiningSequence || this.#disposed) return;
      void this.#finishTimedMining(sequence).catch(() => {
        if (sequence !== this.#timedMiningSequence || this.#disposed) return;
        this.#timedMining = Object.freeze({
          ...this.#timedMining,
          status: 'failed',
          failureCode: 'computer-shutdown-failed',
        });
        this.#notifyWalletListeners();
      });
    }, Math.max(0, targetEndAt - Date.now()));
  }

  async #finishTimedMining(sequence: number): Promise<void> {
    if (sequence !== this.#timedMiningSequence || this.#disposed) return;
    this.#timedMining = Object.freeze({
      ...this.#timedMining,
      status: 'stopping',
    });
    this.#notifyWalletListeners();
    const terminalDeadline = Date.now() + TIMED_MINING_TERMINAL_WAIT_MS;
    const stopCompleted = await settlesBefore(
      this.#stopAllMiningRuntimes('TIMED_COMPLETION'),
      TIMED_MINING_TERMINAL_WAIT_MS,
    );
    if (sequence !== this.#timedMiningSequence || this.#disposed) return;
    if (!stopCompleted) {
      this.#failTimedMiningTerminalWait();
      return;
    }

    const terminal = await this.#waitForTerminalMiningState(
      sequence,
      Math.max(0, terminalDeadline - Date.now()),
    );
    if (sequence !== this.#timedMiningSequence || this.#disposed) return;
    if (!terminal) {
      this.#failTimedMiningTerminalWait();
      return;
    }

    await this.#globalMiningUptime.settled();
    if (sequence !== this.#timedMiningSequence || this.#disposed) return;
    if (this.#timedMining.shutdownAfterCompletion) {
      const shutdown = await this.#computerShutdown.shutdownComputer();
      if (sequence !== this.#timedMiningSequence || this.#disposed) return;
      if (shutdown !== 'requested') {
        this.#timedMining = Object.freeze({
          ...this.#timedMining,
          status: 'failed',
          failureCode: shutdown === 'unsupported'
            ? 'computer-shutdown-unsupported'
            : 'computer-shutdown-failed',
        });
        this.#notifyWalletListeners();
        return;
      }
    }

    this.#timedMining = INACTIVE_TIMED_MINING;
    this.#notifyWalletListeners();
  }

  #waitForTerminalMiningState(
    sequence: number,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.#allMiningRuntimesTerminal()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve(value);
      };
      const check = (): void => {
        if (sequence !== this.#timedMiningSequence || this.#disposed) {
          finish(false);
        } else if (this.#allMiningRuntimesTerminal()) {
          finish(true);
        }
      };
      const unsubscribe = this.subscribeToAllCoreEvents(() => check());
      const timeout = setTimeout(
        () => finish(false),
        timeoutMs,
      );
      check();
    });
  }

  #failTimedMiningTerminalWait(): void {
    this.#timedMining = Object.freeze({
      ...this.#timedMining,
      status: 'failed',
      failureCode: 'terminal-state-timeout',
    });
    this.#notifyWalletListeners();
  }

  #allMiningRuntimesTerminal(): boolean {
    if (this.#desiredMiningWallets.size > 0) return false;
    return this.#applicationData.walletRegistry.wallets().every((wallet) =>
      this.#runtimeRouter.isTerminal(wallet.id),
    );
  }

  async #stopRuntime(
    walletId: string | null,
    allowIdle = false,
    operatorRequested = true,
    reason: 'OPERATOR' | 'STOP_ALL' | 'TIMED_COMPLETION' = 'OPERATOR',
  ): Promise<Readonly<MiningCommandResult>> {
    const pendingOperatorStart = Boolean(
      operatorRequested &&
      walletId &&
      this.#desiredMiningWallets.has(walletId) &&
      this.#runtimeRouter.ownership(walletId) === 'NONE',
    );
    if (operatorRequested && walletId) {
      this.#releaseMining(walletId);
      this.#markActiveSessionStopReason(walletId, 'operator-stop');
      this.#setRecovery(walletId, 'manual-stop', 0, null, null, null);
    }
    if (pendingOperatorStart) {
      await this.#runtimeRouter.stop(walletId, reason, allowIdle);
      return this.#commandResult(
        true,
        'stopped',
        'The pending wallet mining start was cancelled.',
        walletId,
      );
    }

    const stopped = await this.#runtimeRouter.stop(walletId, reason, allowIdle);
    if (!stopped.accepted && stopped.reasonCode === 'runtime-stop-failed') {
      this.#publishRuntimeError(
        walletId,
        'runtime-stop-failed',
        'The wallet runtime could not be stopped.',
      );
    }
    return this.#commandResult(
      stopped.accepted,
      stopped.reasonCode as MiningCommandResult['reasonCode'],
      stopped.message,
      walletId,
    );
  }

  selectWallet(walletId: string | null): Readonly<WalletSelectionResult> {
    if (walletId === null) {
      this.#selectedWalletId = null;
      return Object.freeze({
        selected: false,
        walletId: null,
        reasonCode: 'cleared',
      });
    }

    if (!this.#applicationData.walletRegistry.wallet(walletId)) {
      return Object.freeze({
        selected: false,
        walletId,
        reasonCode: 'wallet-not-found',
      });
    }

    this.#selectedWalletId = walletId;
    return Object.freeze({ selected: true, walletId, reasonCode: 'selected' });
  }

  selectedWalletId(): string | null {
    return this.#selectedWalletId;
  }

  async preflightMining(): Promise<Readonly<MiningPreflightResult>> {
    if (!this.#production) {
      return Object.freeze({
        ready: false,
        reasonCode: 'production-configuration-missing',
        message: 'Production runtime services are not configured.',
        walletId: this.#selectedWalletId,
        readiness: Object.freeze({
          configurationStatus: 'missing',
          beeSdkStatus: 'idle',
          walletOnboardingStatus: null,
          connectionReferencePresent: false,
          miningCredentialReferencePresent: false,
          secureConnectionStatePresent: null,
          secureMiningCredentialPresent: null,
          nativeSessionConflict: false,
          nativePreparation: 'deferred-to-core-start',
          tapPacingStatus: 'not-configured',
        }),
      });
    }

    return (await this.#production.preflight.assess(this.#selectedWalletId)).result;
  }

  shadowPreflightMining(
    walletId: string = this.#selectedWalletId ?? '',
  ): Promise<Readonly<ShadowMiningPreflightResult>> {
    if (this.#production?.shadowPreflight) {
      return this.#production.shadowPreflight.check(walletId);
    }
    return Promise.resolve(Object.freeze({
      walletId,
      status: 'BLOCKED' as const,
      checkedAt: new Date().toISOString(),
      checks: Object.freeze({
        walletRegistered: false,
        configurationReady: false,
        endpointsValid: false,
        appIdValid: false,
        credentialReferencePresent: false,
        credentialAvailable: false,
        credentialParsed: false,
        walletIdentityMatches: false,
        minerAddressValid: false,
        publicKeyValid: false,
        keyBindingVerified: false,
        validatedIdentityCreated: false,
        newRuntimeConstructible: false,
      }),
      blockers: Object.freeze([Object.freeze({
        code: 'CONFIGURATION_NOT_READY' as const,
        check: 'configurationReady' as const,
        message: 'Production configuration is not ready.',
      })]),
    }));
  }

  beginWalletConnection(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    return this.#walletConnections.beginWalletConnection(
      walletId,
      this.#selectedWalletId,
    );
  }
  async prepareWalletMiningCredential(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    return this.#walletConnections.prepareWalletMiningCredential(
      walletId,
      this.#selectedWalletId,
    );
  }
  async verifyWalletMiningCredentialPropagation(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    return this.#walletConnections.verifyWalletMiningCredentialPropagation(
      walletId,
      this.#selectedWalletId,
    );
  }
  disconnectWallet(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    return this.#walletConnections.disconnectWallet(
      walletId,
      this.#selectedWalletId,
    );
  }
  async getWalletConnectionState(
    walletId: string,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    const result = await this.#walletConnections.getWalletConnectionState(
      walletId,
      this.#selectedWalletId,
    );
    if (result.accepted) {
      await this.#synchronizeMamaBoardLevel(walletId, true);
    }
    return result;
  }
  getOperatorState(): Readonly<MinerOperatorState> {
    const selectedWallet = this.#selectedWalletId
      ? this.#applicationData.walletRegistry.wallet(this.#selectedWalletId)
      : null;
    const preflight = this.#production?.preflight.preview(
      this.#selectedWalletId,
    );
    const gatewayReadiness = this.#production?.gateway.readiness();
    const nativeSession = this.#selectedWalletId
      ? this.#runtimeRouter.nativeSession(this.#selectedWalletId)
      : null;
    const diagnostics = Object.freeze(
      this.#diagnostics.entries().slice(0, 10).map((entry) =>
        Object.freeze({
          id: entry.id,
          timestamp: entry.timestamp,
          eventType: entry.eventType,
          level: entry.level,
          category: entry.category,
          walletId: entry.walletId ?? null,
          sessionId: entry.sessionId,
          generation: entry.generation,
          miniEpoch: entry.miniEpoch,
          code: entry.code,
        }),
      ),
    );

    return Object.freeze({
      configuration:
        this.#production?.configuration ??
        Object.freeze({
          status: 'missing',
          code: 'production-configuration-missing',
          endpointCount: 0,
          appIdConfigured: false,
          maximumSessionDurationMs: 135_000,
        }),
      beeSdk: Object.freeze({
        status: gatewayReadiness?.status ?? 'idle',
        version: gatewayReadiness?.version ?? null,
        failureCode: gatewayReadiness?.failure?.code ?? null,
      }),
      selectedWalletId: this.#selectedWalletId,
      walletReadiness: Object.freeze({
        registered: selectedWallet !== null,
        onboardingStatus: selectedWallet?.onboardingStatus ?? null,
        connectionReferencePresent: Boolean(
          selectedWallet?.connectionReference,
        ),
        miningCredentialReferencePresent: Boolean(
          selectedWallet?.miningCredentialReference,
        ),
      }),
      walletConnection: selectedWallet
        ? this.#walletConnections.presentation(selectedWallet.id)
        : null,
      runtime: this.getCurrentRuntimeState(),
      nativeSession: nativeSession
        ? Object.freeze({ ...nativeSession })
        : null,
      rewardSynchronization:
        (this.#selectedWalletId
          ? this.#runtimeRouter.rewardSynchronization(this.#selectedWalletId)
          : null) ??
        Object.freeze({
          status: 'idle',
          walletId: null,
          sessionId: null,
          generation: null,
          confirmedRewardCount: 0,
          code: null,
        }),
      tapPacingStatus:
        this.#production?.tapPacing.readiness().status ?? 'not-configured',
      canonicalChainState:
        this.#production?.canonicalChainState.snapshot() ??
        CANONICAL_CHAIN_STATE_NOT_CONFIGURED.snapshot(),
      globalMiningUptime: this.#globalMiningUptime.snapshot(),
      timedMining: this.#timedMining,
      mainEpochStart: this.#mainEpochStart,
      diagnostics,
      blockers: Object.freeze(
        preflight && !preflight.ready ? [preflight] : [],
      ),
    });
  }

  getCurrentRuntimeState(): RuntimePresentationState {
    return this.#selectedWalletId
      ? this.#presentWalletRuntime(this.#selectedWalletId)
      : this.#presentRuntime();
  }

  getRuntimeStates(): WalletRuntimePresentationStates {
    return new Map(
      this.#applicationData.walletRegistry.wallets().map((wallet) => [
        wallet.id,
        this.#presentWalletRuntime(wallet.id),
      ] as const),
    );
  }

  #presentWalletRuntime(walletId: string): RuntimePresentationState {
    const base = this.#presentRuntime();
    return this.#runtimeRouter.presentation(walletId, base) ?? base;
  }

  #presentRuntime(): RuntimePresentationState {
    const lastError = this.#diagnostics.latestError();

    return Object.freeze({
      runtimeStatus: this.#disposal ? 'disposed' : 'idle',
      miningExecution: null,
      schedulerStatus: 'idle',
      settlementStatus: 'idle',
      boundaryStatus: 'idle',
      recoveryStatus: 'idle',
      recoveryIssue: null,
      epochs: this.#presentCanonicalEpochs(),
      health: Object.freeze({
        uptimeMs: null,
        lastError: lastError
          ? Object.freeze({
              occurredAt: lastError.timestamp,
              code: lastError.code,
              message: lastError.message,
            })
          : null,
      }),
    });
  }

  getDiagnostics(): readonly RuntimeDiagnostic[] {
    return this.#diagnostics.entries();
  }

  subscribeToDiagnostics(listener: RuntimeDiagnosticListener): () => void {
    return this.#diagnostics.subscribe(listener);
  }

  getSystemMetrics(): Readonly<SystemMetricsSnapshot> {
    return this.#systemObservability.snapshot();
  }

  subscribeToSystemMetrics(listener: SystemMetricsListener): () => void {
    return this.#systemObservability.subscribe(listener);
  }

  exportDiagnostics(): Promise<Readonly<DiagnosticsExportResult>> {
    const runtimeStates = Object.fromEntries(this.getRuntimeStates());
    const walletSummary = this.getWallets().map((wallet) =>
      Object.freeze({
        walletId: wallet.id,
        name: wallet.name,
        status: wallet.status,
        connectionStatus: wallet.connectionStatus,
        sessionId: wallet.sessionId,
        generation: wallet.generation,
        runtimeStatus: wallet.runtimeStatus,
        schedulerStatus: wallet.schedulerStatus,
        settlementStatus: wallet.settlementStatus,
        progressPercent: wallet.progressPercent,
        completedTaps: wallet.completedTaps,
        tapTarget: wallet.tapTarget,
        latestReward: wallet.latestReward,
      }),
    );

    return this.#systemObservability.exportDiagnostics({
      logs: this.#diagnostics.entries(),
      runtimeState: Object.freeze({
        selectedWalletId: this.#selectedWalletId,
        selected: this.getCurrentRuntimeState(),
        wallets: runtimeStates,
      }),
      walletSummary: Object.freeze(walletSummary),
      epochState:
        this.#production?.canonicalChainState.snapshot() ??
        CANONICAL_CHAIN_STATE_NOT_CONFIGURED.snapshot(),
      systemMetrics: this.#systemObservability.snapshot(),
      recoveryHistory: this.getRecoveryHistory(),
      rewardHistory: Object.freeze({
        ledger: Object.freeze(
          this.#applicationData.walletRegistry
            .wallets()
            .flatMap((wallet) =>
              this.#applicationData.rewardLedger.rewardsForWallet(wallet.id),
            ),
        ),
        lockedNacklDeltas: this.getRewardDeltas(),
      }),
      balanceSnapshots: this.getBalanceSnapshots(),
      sessionResults: this.getSessionResults(),
    });
  }

  getWallets(): readonly WalletPresentation[] {
    const runtimeStates = this.getRuntimeStates();

    return Object.freeze(
      this.#applicationData.walletRegistry.wallets().map((wallet) =>
        this.#presentWallet(
          wallet,
          runtimeStates.get(wallet.id) ?? this.#presentRuntime(),
        ),
      ),
    );
  }

  #presentWallet(
    wallet: Readonly<WalletSnapshot>,
    runtimeState = this.#presentWalletRuntime(wallet.id),
  ): Readonly<WalletPresentation> {
    const execution = runtimeState.miningExecution;
    const connection = this.#walletConnections.presentation(wallet.id);
    const latestRewardRecord = this.#applicationData.rewardLedger
      .rewardsForWallet(wallet.id)
      .at(-1);
    const latestReward: WalletRewardPresentation | null = latestRewardRecord
      ? Object.freeze({
          id: latestRewardRecord.id,
          amountLabel: `${latestRewardRecord.amount.value} ${latestRewardRecord.amount.unit}`,
          recordedAtLabel: new Date(latestRewardRecord.recordedAt).toISOString(),
          sessionId: latestRewardRecord.sessionId,
          generation: latestRewardRecord.generation,
        })
      : null;
    const activeWalletExecution =
      wallet.session &&
      execution?.sessionId === wallet.session.sessionId &&
      execution.generation === wallet.session.generation
        ? execution
        : null;
    const miningRewards = this.#rewardDeltasForWallet(
      wallet.id,
      WALLET_REWARD_PRESENTATION_LIMIT,
    );
    let latestMiningReward: Readonly<WalletRewardDelta> | null = null;
    for (let index = miningRewards.length - 1; index >= 0; index -= 1) {
      const reward = miningRewards[index];
      if (reward && isLiveMiningRewardDelta(reward)) {
        latestMiningReward = reward;
        break;
      }
    }

    return Object.freeze({
      id: wallet.id,
      name: wallet.name,
      status: wallet.status,
      walletAddress: wallet.walletAddress,
      mamaBoardLevel: wallet.mamaBoardLevel,
      connectionStatus: connection.phase,
      connection,
      sessionId: wallet.session?.sessionId ?? null,
      generation: wallet.session?.generation ?? null,
      runtimeStatus: runtimeState.runtimeStatus,
      schedulerStatus: runtimeState.schedulerStatus,
      settlementStatus: runtimeState.settlementStatus,
      progressPercent:
        activeWalletExecution?.sessionProgressPercent ?? null,
      completedTaps:
        activeWalletExecution?.tapProgress.completedTapCount ?? null,
      tapTarget:
        activeWalletExecution?.tapProgress.targetTapCount ?? null,
      latestReward,
      balance: this.#balanceByWallet.get(wallet.id) ?? null,
      recovery: this.#recoveryFor(wallet.id),
      latestMiningReward,
      miningRewards,
    });
  }

  getFinancialOverview(): Readonly<WalletFinancialOverview> {
    const wallets = this.#applicationData.walletRegistry.wallets();
    return aggregateWalletBalances(
      [...this.#balanceByWallet.values()],
      wallets.length,
      aggregateDailyNacklRewardRecords(
        wallets.map((wallet) =>
          this.#applicationData.rewardLedger.rewardsForWallet(wallet.id),
        ),
        4,
      ),
    );
  }

  getRecoveryHistory(
    walletId?: string,
  ): readonly WalletRecoveryHistoryEntry[] {
    return this.#historyValues(this.#recoveryHistoryByWallet, walletId);
  }

  getBalanceSnapshots(walletId?: string): readonly WalletBalanceSnapshot[] {
    if (walletId) {
      const snapshot = this.#balanceByWallet.get(walletId);
      return Object.freeze(snapshot ? [snapshot] : []);
    }

    return Object.freeze([...this.#balanceByWallet.values()]);
  }

  getSessionResults(walletId?: string): readonly WalletSessionResult[] {
    return this.#historyValues(this.#sessionResultsByWallet, walletId);
  }

  getRewardDeltas(walletId?: string): readonly WalletRewardDelta[] {
    if (walletId) {
      return this.#rewardDeltasForWallet(walletId);
    }

    return Object.freeze(
      this.#applicationData.walletRegistry
        .wallets()
        .flatMap((wallet) => this.#rewardDeltasForWallet(wallet.id)),
    );
  }

  async refreshWalletBalances(walletId?: string): Promise<void> {
    const wallets = walletId
      ? [this.#applicationData.walletRegistry.wallet(walletId)].filter(
          (wallet): wallet is NonNullable<typeof wallet> => wallet !== null,
        )
      : this.#applicationData.walletRegistry.wallets();

    await Promise.all(
      wallets
        .filter((wallet) => Boolean(wallet.walletAddress))
        .map((wallet) => this.#synchronizeWalletBalance(wallet.id)),
    );
  }

  async registerWallet(wallet: WalletRegistration): Promise<void> {
    const registered = this.#applicationData.walletRegistry.registerWallet({
      id: this.#walletIdFactory(),
      name: wallet.name.trim(),
      status: 'idle',
    });

    try {
      await this.#walletStorage?.saveWallet({
        id: registered.id,
        name: registered.name,
        status: registered.status,
        walletAddress: registered.walletAddress,
        onboardingStatus: registered.onboardingStatus,
        connectionReference: registered.connectionReference,
        miningCredentialReference: registered.miningCredentialReference,
        mamaBoardLevel: registered.mamaBoardLevel,
      });
    } catch (error) {
      this.#applicationData.walletRegistry.removeWallet(registered.id);
      throw error;
    }

    this.#walletConnections.trackWallet(registered.id);
    this.selectWallet(registered.id);

    this.#notifyWalletListeners(null, true);
  }

  removeWallet(walletId: string): Promise<boolean> {
    const existing = this.#walletRemovals.get(walletId);
    if (existing) {
      return existing;
    }

    const operation = Promise.resolve().then(() =>
      this.#removeWallet(walletId),
    );
    this.#walletRemovals.set(walletId, operation);
    const releaseRemoval = () => {
      if (this.#walletRemovals.get(walletId) === operation) {
        this.#walletRemovals.delete(walletId);
      }
    };
    void operation.then(releaseRemoval, releaseRemoval);
    return operation;
  }

  async #removeWallet(walletId: string): Promise<boolean> {
    const wallet = this.#applicationData.walletRegistry.wallet(walletId);

    if (!wallet || this.#walletConnections.hasPendingOperation(walletId)) {
      return false;
    }

    this.#releaseMining(walletId);
    await Promise.allSettled(
      [this.#balanceReads.get(walletId), this.#mamaBoardReads.get(walletId)].filter(
        (operation): operation is Promise<void> => Boolean(operation),
      ),
    );
    const runtimeStatus = this.#runtimeRouter.status(walletId);

    if (runtimeStatus !== 'idle' && runtimeStatus !== 'disposed') {
      const stopped = await this.#stopRuntime(walletId, true, true, 'OPERATOR');
      if (!stopped.accepted) {
        return false;
      }
    }

    if (!(await this.#runtimeRouter.release(walletId))) {
      return false;
    }

    this.#production?.forgetWalletState?.(walletId);

    await this.#walletStorage?.removeWallet(walletId);
    const removed = this.#applicationData.walletRegistry.removeWallet(walletId);

    if (!removed) {
      throw new Error('Wallet registry removal lost ownership after persistence cleanup.');
    }

    if (this.#selectedWalletId === walletId) {
      this.#selectedWalletId = null;
    }

    this.#walletConnections.forgetWallet(walletId);
    this.#releaseMining(walletId);
    this.#recoveryByWallet.delete(walletId);
    this.#recoveryHistoryByWallet.delete(walletId);
    this.#balanceByWallet.delete(walletId);
    this.#pendingBalanceReads.delete(walletId);
    this.#sessionResultsByWallet.delete(walletId);
    this.#latestLiveRewardByWallet.delete(walletId);
    this.#applicationData.rewardLedger.forgetWallet?.(walletId);
    this.#balanceReads.delete(walletId);
    this.#mamaBoardReads.delete(walletId);
    for (const [key, draft] of this.#sessionDrafts) {
      if (draft.walletId === walletId) {
        this.#sessionDrafts.delete(key);
      }
    }
    for (const key of this.#balanceSyncKeys) {
      if (key.startsWith(`${walletId}:`)) {
        this.#balanceSyncKeys.delete(key);
      }
    }

    this.#notifyWalletListeners(null, true);
    return true;
  }

  subscribeToWalletUpdates(listener: WalletUpdateListener): () => void {
    this.#deliverWallets(listener, null, false);
    this.#walletListeners.add(listener);

    return () => {
      this.#walletListeners.delete(listener);
    };
  }

  dispose(): Promise<void> {
    if (this.#disposal) {
      return this.#disposal;
    }

    this.#disposed = true;
    this.#disposal = this.#dispose();
    return this.#disposal;
  }

  subscribeToRuntimeUpdates(listener: RuntimeUpdateListener): () => void {
    this.#deliverRuntimeUpdate(listener);
    const unsubscribeFromEvents = this.subscribeToAllCoreEvents((event) =>
      this.#deliverRuntimeUpdate(listener, event),
    );
    const unsubscribeFromEpochs =
      this.#production?.canonicalChainState.subscribe(() =>
        this.#deliverCanonicalEpochUpdate(listener),
      ) ?? (() => undefined);
    void this.#production?.canonicalChainState.synchronize();

    return () => {
      unsubscribeFromEvents();
      unsubscribeFromEpochs();
    };
  }

  subscribeToLifecycleEvents(listener: LifecycleEventListener): () => void {
    return this.subscribeToAllCoreEvents((event) => {
      try {
        listener(this.translateEvent(event));
      } catch {
        // Presentation observers cannot control Core Engine lifecycle.
      }
    });
  }

  #deliverRuntimeUpdate(
    listener: RuntimeUpdateListener,
    event?: CoreEvent,
  ): void {
    try {
      if (event?.type === 'wallet-mining-worker-diagnostic') return;
      const walletId = event ? coreEventWalletId(event) : null;
      const wallet = walletId
        ? this.#applicationData.walletRegistry.wallet(walletId)
        : null;

      if (walletId && wallet) {
        const state = this.#presentWalletRuntime(walletId);
        listener(Object.freeze({
          scope: 'wallet',
          walletId,
          currentRuntimeState:
            this.#selectedWalletId === walletId ? state : null,
          runtimeStates: new Map([[walletId, state]]),
        }));
        return;
      }

      listener(Object.freeze({
        scope: 'all',
        walletId: null,
        currentRuntimeState: this.getCurrentRuntimeState(),
        runtimeStates: this.getRuntimeStates(),
      }));
    } catch {
      // Presentation observers cannot control Core Engine lifecycle.
    }
  }

  #deliverCanonicalEpochUpdate(listener: RuntimeUpdateListener): void {
    try {
      listener(Object.freeze({
        scope: 'canonical',
        walletId: null,
        currentRuntimeState: null,
        runtimeStates: new Map(),
        canonicalEpochs: this.#presentCanonicalEpochs(),
      }));
    } catch {
      // Canonical presentation observers cannot control the chain source.
    }
  }

  #presentCanonicalEpochs(): Readonly<EpochPresentation> {
    const snapshot =
      this.#production?.canonicalChainState.snapshot() ??
      CANONICAL_CHAIN_STATE_NOT_CONFIGURED.snapshot();
    const status: EpochPresentationStatus =
      snapshot.status !== 'live'
        ? 'synchronizing'
        : snapshot.confidence === 'estimated'
          ? 'waiting'
          : 'live';

    return Object.freeze({
      miniEpoch: presentEpochWindow(
        snapshot.miniEpoch,
        snapshot.currentBlock,
        status,
      ),
      mainEpoch: presentEpochWindow(
        snapshot.mainEpoch,
        snapshot.currentBlock,
        status,
      ),
    });
  }

  #notifyWalletListeners(
    walletId: string | null = null,
    financialChanged = false,
  ): void {
    if (this.#disposed) {
      return;
    }

    for (const listener of [...this.#walletListeners]) {
      this.#deliverWallets(listener, walletId, financialChanged);
    }
  }

  #deliverWallets(
    listener: WalletUpdateListener,
    walletId: string | null,
    financialChanged: boolean,
  ): void {
    try {
      const wallet = walletId
        ? this.#applicationData.walletRegistry.wallet(walletId)
        : null;
      listener(Object.freeze({
        scope: wallet ? 'wallet' : 'all',
        walletId: wallet ? walletId : null,
        wallets: wallet
          ? Object.freeze([this.#presentWallet(wallet)])
          : this.getWallets(),
        financialChanged,
      }));
    } catch {
      // Presentation observers cannot control wallet ownership.
    }
  }

  private subscribeToAllCoreEvents(
    listener: (event: CoreEvent) => void,
  ): () => void {
    const unsubscribers = CORE_EVENT_TYPES.map((type) =>
      this.#eventObserver.subscribe(type, listener),
    );

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }

  private translateEvent(event: CoreEvent): ApplicationLifecycleEvent {
    return Object.freeze({
      id: event.id,
      occurredAt: event.occurredAt,
      type: event.type,
      payload: Object.freeze({ ...event.payload }),
    }) as ApplicationLifecycleEvent;
  }

  #observeApplicationEvent(event: CoreEvent): void {
    const eventWalletId = (event.payload as { readonly walletId?: unknown }).walletId;
    if (
      typeof eventWalletId === 'string' &&
      (this.#walletRemovals.has(eventWalletId) ||
        !this.#applicationData.walletRegistry.wallet(eventWalletId))
    ) {
      return;
    }

    switch (event.type) {
      case 'session-created':
      case 'session-started':
        this.#observeSessionStart(event);
        return;
      case 'tap-progress':
        this.#updateSession(
          event.payload.walletId,
          event.payload.sessionId,
          event.payload.generation,
          (result) => ({
            ...result,
            completedTaps: event.payload.completedTapCount,
          }),
        );
        return;
      case 'boundary-reached':
        if (event.payload.walletId) {
          this.#markActiveSessionStopReason(
            event.payload.walletId,
            'epoch-boundary',
          );
        }
        return;
      case 'bee-settlement-outcome':
        this.#observeSettlementOutcome(event);
        this.#requestBalanceSynchronization(
          event.payload.walletId,
          `session:${event.payload.sessionId}:${event.payload.generation}`,
          event.payload.sessionId,
          event.payload.generation,
          event.payload.outcome === 'accepted' ||
          event.payload.outcome === 'completed'
            ? 'settlement'
            : 'monitoring',
        );
        return;
      case 'settlement-completed':
        this.#updateSession(
          event.payload.walletId,
          event.payload.sessionId,
          event.payload.generation,
          (result) => ({
            ...result,
            settlementOutcome:
              result.settlementOutcome === 'pending'
                ? 'completed'
                : result.settlementOutcome,
            stopReason:
              result.stopReason === 'unknown'
                ? 'settlement-completed'
                : result.stopReason,
          }),
        );
        if (event.payload.walletId) {
          this.#requestBalanceSynchronization(
            event.payload.walletId,
            `session:${event.payload.sessionId}:${event.payload.generation}`,
            event.payload.sessionId,
            event.payload.generation,
            'settlement',
          );
        }
        return;
      case 'session-finished':
        this.#observeSessionFinished(event);
        {
          const walletId = event.payload.walletId;
          if (
            !walletId ||
            this.#runtimeRouter.ownership(walletId) !== 'NEW' ||
            this.#runtimeRouter.retainsDesiredMining(walletId)
          ) {
            return;
          }
          this.#releaseMining(walletId);
          void this.#runtimeRouter.release(walletId).then(
            (released) => {
              if (!released) {
                this.#publishRuntimeError(
                  walletId,
                  'new-worker-disposal-failed',
                  'The completed controlled new-worker session remains quarantined.',
                );
              }
            },
            () => {
              this.#publishRuntimeError(
                walletId,
                'new-worker-disposal-failed',
                'The completed controlled new-worker session remains quarantined.',
              );
            },
          );
        }
        return;
      case 'bee-reward-sync-completed':
        this.#requestBalanceSynchronization(
          event.payload.walletId,
          `session:${event.payload.sessionId}:${event.payload.generation}`,
          event.payload.sessionId,
          event.payload.generation,
          'reward-sync',
        );
        return;
      case 'epoch-changed':
        this.#observeMainEpochForArmedStart(event.payload.mainEpoch);
        for (const wallet of this.#applicationData.walletRegistry.wallets()) {
          if (this.#runtimeRouter.ownership(wallet.id) === 'NEW') continue;
          this.#requestBalanceSynchronization(
            wallet.id,
            `epoch:${event.payload.miniEpoch}:${wallet.id}`,
            null,
            null,
            'epoch',
          );
        }
        return;
      case 'tap-execution-failed':
        if (
          event.payload.walletId &&
          this.#matchesActiveSession(
            event.payload.walletId,
            event.payload.sessionId,
            event.payload.generation,
          )
        ) {
          this.#requestRecovery(
            event.payload.walletId,
            event.payload.code,
            event.payload.message,
            {
              operation: 'tap',
              sessionId: event.payload.sessionId,
              generation: event.payload.generation,
            },
          );
        }
        return;
      case 'bee-mining-failed':
        if (
          this.#matchesActiveSession(
            event.payload.walletId,
            event.payload.sessionId,
            event.payload.generation,
          )
        ) {
          const operation = recoveryOperationFromId(event.payload.operationId);
          const classification =
            event.payload.classification ??
            classifyBeeFailureText(event.payload.code, event.payload.message);
          if (
            operation === 'reward' &&
            isAmbiguousRewardFailure(classification)
          ) {
            this.#requestAmbiguousRewardVerification(event, classification);
            return;
          }

          this.#requestRecovery(
            event.payload.walletId,
            classification ?? event.payload.code ?? 'bee-mining-failed',
            event.payload.message ?? 'Bee mining worker failed.',
            {
              operation,
              sessionId: event.payload.sessionId,
              generation: event.payload.generation,
              classification,
              messageHash: event.payload.messageHash ?? null,
            },
          );
        }
        return;
      case 'runtime-error':
        if (event.payload.walletId) {
          this.#requestRecovery(
            event.payload.walletId,
            event.payload.code,
            event.payload.message,
            { operation: 'runtime' },
          );
        }
        return;
      default:
        return;
    }
  }

  #observeSessionStart(
    event: CoreEvent<'session-created' | 'session-started'>,
  ): void {
    const walletId = event.payload.walletId;
    if (!walletId) {
      return;
    }

    const key = sessionKey(
      walletId,
      event.payload.sessionId,
      event.payload.generation,
    );
    const existing = this.#sessionDrafts.get(key);
    if (existing) {
      return;
    }

    for (const [draftKey, draft] of this.#sessionDrafts) {
      if (draft.walletId === walletId) {
        this.#sessionDrafts.delete(draftKey);
      }
    }

    const targetTaps = 70;
    this.#sessionDrafts.set(
      key,
      Object.freeze({
        walletId,
        sessionId: event.payload.sessionId,
        generation: event.payload.generation,
        miniEpoch: event.payload.miniEpoch ?? null,
        startedAt: event.occurredAt,
        completedAt: null,
        completedTaps: 0,
        targetTaps,
        verifiedTaps: null,
        rejectedTaps: null,
        settlementOutcome: 'pending',
        stopReason: 'unknown',
        rewardDeltaRaw: null,
        recoveryUsed: false,
      }),
    );
  }

  #observeSessionFinished(event: CoreEvent<'session-finished'>): void {
    const walletId = event.payload.walletId;
    if (!walletId) {
      return;
    }

    const key = sessionKey(
      walletId,
      event.payload.sessionId,
      event.payload.generation,
    );
    const draft = this.#sessionDrafts.get(key);
    if (!draft) {
      return;
    }

    const completed = Object.freeze({
      ...draft,
      completedAt: event.occurredAt,
    });
    this.#sessionDrafts.delete(key);
    this.#sessionResultsByWallet.set(
      walletId,
      appendBounded(
        this.#sessionResultsByWallet.get(walletId),
        completed,
        WALLET_SESSION_HOT_HISTORY_LIMIT,
      ),
    );
    void this.#walletStorage?.saveWalletSessionResult?.(completed);
    this.#notifyWalletListeners(walletId);
  }

  #observeSettlementOutcome(event: CoreEvent<'bee-settlement-outcome'>): void {
    const outcome = event.payload.outcome;
    const stopReason: WalletStopReason =
      outcome === 'accepted' || outcome === 'completed'
        ? 'settlement-completed'
        : outcome === 'rejected'
          ? 'settlement-failed'
          : outcome === 'timeout'
            ? 'timeout'
            : outcome === 'native_error'
              ? 'native-error'
              : 'unknown';

    this.#updateSession(
      event.payload.walletId,
      event.payload.sessionId,
      event.payload.generation,
      (result) => ({
        ...result,
        verifiedTaps: event.payload.confirmedTaps,
        settlementOutcome: outcome,
        stopReason:
          result.stopReason === 'epoch-boundary'
            ? result.stopReason
            : stopReason,
      }),
    );

    if (
      isQueueOverflowFailure(
        event.payload.code,
        event.payload.message,
        event.payload.classification,
      ) &&
      this.#matchesActiveSession(
        event.payload.walletId,
        event.payload.sessionId,
        event.payload.generation,
      )
    ) {
      this.#requestRecovery(
        event.payload.walletId,
        event.payload.code ?? 'QUEUE_OVERFLOW',
        event.payload.message ?? 'Bee settlement queue is full.',
        {
          operation: 'settlement',
          sessionId: event.payload.sessionId,
          generation: event.payload.generation,
          errorType: event.payload.outcome,
          classification: event.payload.classification ?? null,
          messageHash: event.payload.messageHash ?? null,
        },
      );
    }

  }

  #updateSession(
    walletId: string | undefined,
    sessionId: string,
    generation: number,
    update: (result: WalletSessionResult) => WalletSessionResult,
  ): void {
    if (!walletId) {
      return;
    }

    const key = sessionKey(walletId, sessionId, generation);
    const draft = this.#sessionDrafts.get(key);
    if (draft) {
      this.#sessionDrafts.set(key, Object.freeze(update(draft)));
      return;
    }

    const history = this.#sessionResultsByWallet.get(walletId);
    if (!history) {
      return;
    }

    let changed = false;
    const updated = history.map((result) => {
      if (result.sessionId !== sessionId || result.generation !== generation) {
        return result;
      }
      changed = true;
      return Object.freeze(update(result));
    });
    if (changed) {
      this.#sessionResultsByWallet.set(walletId, Object.freeze(updated));
      const changedResult = updated.find(
        (result) =>
          result.sessionId === sessionId && result.generation === generation,
      );
      if (changedResult) {
        void this.#walletStorage?.saveWalletSessionResult?.(changedResult);
      }
      this.#notifyWalletListeners(walletId);
    }
  }

  #markActiveSessionStopReason(
    walletId: string,
    stopReason: WalletStopReason,
  ): void {
    const session = this.#runtimeRouter.activeSessionIdentity(walletId);
    if (session) {
      this.#updateSession(walletId, session.sessionId, session.generation, (result) => ({
        ...result,
        stopReason,
      }));
    }
  }

  #requestAmbiguousRewardVerification(
    event: CoreEvent<'bee-mining-failed'>,
    classification: 'DUPLICATE_MESSAGE' | 'TIMEOUT',
  ): void {
    const key = sessionKey(
      event.payload.walletId,
      event.payload.sessionId,
      event.payload.generation,
    );
    if (this.#rewardVerifications.has(key)) {
      return;
    }

    const operation = this.#verifyAmbiguousRewardOutcome(
      event,
      classification,
    );
    this.#rewardVerifications.set(key, operation);
    void operation.finally(() => {
      if (this.#rewardVerifications.get(key) === operation) {
        this.#rewardVerifications.delete(key);
      }
    });
  }

  async #verifyAmbiguousRewardOutcome(
    event: CoreEvent<'bee-mining-failed'>,
    classification: 'DUPLICATE_MESSAGE' | 'TIMEOUT',
  ): Promise<void> {
    const walletId = event.payload.walletId;
    const context = this.#createRecoveryContext(
      walletId,
      {
        operation: 'reward',
        sessionId: event.payload.sessionId,
        generation: event.payload.generation,
        classification,
        messageHash: event.payload.messageHash ?? null,
      },
      classification,
    );

    await waitFor(AMBIGUOUS_REWARD_VERIFY_DELAY_MS);
    if (
      this.#disposal ||
      this.#walletRemovals.has(walletId) ||
      !this.#desiredMiningWallets.has(walletId) ||
      !this.#recoveryIdentityIsCurrent(walletId, context)
    ) {
      return;
    }

    try {
      await this.#balanceReads.get(walletId);
      await this.#synchronizeWalletBalance(
        walletId,
        event.payload.sessionId,
        event.payload.generation,
        'reward-sync',
      );
    } catch {
      // A failed public read leaves the reward outcome unconfirmed.
    }

    if (
      this.#disposal ||
      this.#walletRemovals.has(walletId) ||
      !this.#desiredMiningWallets.has(walletId) ||
      !this.#recoveryIdentityIsCurrent(walletId, context)
    ) {
      return;
    }

    if (
      this.#hasRewardEvidence(
        walletId,
        event.payload.sessionId,
        event.payload.generation,
      )
    ) {
      this.#setRecovery(walletId, 'healthy', 0, null, null, null);
      this.#publishRecoveryEvent(
        'recovery-completed',
        walletId,
        classification,
        'Ambiguous Bee reward request was confirmed by public wallet state.',
        {
          ...context,
          attempt: 0,
          maximumAttempts: MAX_RECOVERY_ATTEMPTS,
          delayMs: AMBIGUOUS_REWARD_VERIFY_DELAY_MS,
        },
      );
      return;
    }

    if (
      this.#disposal ||
      !this.#desiredMiningWallets.has(walletId) ||
      !this.#recoveryIdentityIsCurrent(walletId, context)
    ) {
      return;
    }

    this.#requestRecovery(
      walletId,
      classification,
      event.payload.message ??
        'Bee reward request outcome remained unconfirmed after public verification.',
      context,
    );
  }

  #hasRewardEvidence(
    walletId: string,
    sessionId: string,
    generation: number,
  ): boolean {
    return this.#applicationData.rewardLedger
      .rewardsForWallet(walletId)
      .some(
        (reward) =>
          reward.kind === 'locked-nackl-delta' &&
          reward.sessionId === sessionId &&
          reward.generation === generation,
      );
  }

  #requestRecovery(
    walletId: string,
    code: string,
    message: string,
    request: Partial<RecoveryRequestContext> = {},
  ): void {
    if (
      !this.#desiredMiningWallets.has(walletId) ||
      this.#runtimeRouter.ownership(walletId) !== 'NEW'
    ) {
      return;
    }
    const classification =
      request.classification ?? classifyBeeFailureText(code, message);
    const queueOverflow = isQueueOverflowFailure(
      code,
      message,
      classification,
    );
    const normalizedCode = queueOverflow
      ? QUEUE_OVERFLOW_CODE
      : classification ?? code;
    const maximumAttempts = 0;
    const context = this.#createRecoveryContext(
      walletId,
      request,
      queueOverflow
        ? 'queue-overflow'
        : request.errorType ?? classification ?? normalizedCode,
    );
    this.#markRecoveryUsed(walletId);
    this.#setRecovery(
      walletId,
      'recovery-pending',
      0,
      normalizedCode,
      message,
      null,
      maximumAttempts,
    );
    this.#publishRecoveryEvent(
      'warning',
      walletId,
      normalizedCode,
      message,
      {
        ...context,
        attempt: 0,
        maximumAttempts,
        delayMs: 0,
      },
    );
  }

  #recoveryFor(walletId: string): Readonly<WalletRecoveryPresentation> {
    const existing = this.#recoveryByWallet.get(walletId);
    if (existing) {
      return existing;
    }

    const healthy = Object.freeze({
      walletId,
      state: 'healthy' as const,
      attempt: 0,
      maximumAttempts: MAX_RECOVERY_ATTEMPTS,
      issueCode: null,
      issueMessage: null,
      nextAttemptAt: null,
      updatedAt: new Date().toISOString(),
    });
    this.#recoveryByWallet.set(walletId, healthy);
    return healthy;
  }

  #setRecovery(
    walletId: string,
    state: WalletRecoveryState,
    attempt: number,
    issueCode: string | null,
    issueMessage: string | null,
    nextAttemptAt: string | null,
    maximumAttempts = MAX_RECOVERY_ATTEMPTS,
  ): void {
    const updatedAt = new Date().toISOString();
    const safeIssueCode = issueCode ? redactDiagnosticText(issueCode) : null;
    const safeIssueMessage = issueMessage
      ? redactDiagnosticText(issueMessage)
      : null;
    const recovery = Object.freeze({
      walletId,
      state,
      attempt,
      maximumAttempts,
      issueCode: safeIssueCode,
      issueMessage: safeIssueMessage,
      nextAttemptAt,
      updatedAt,
    });
    const history = this.#recoveryHistoryByWallet.get(walletId);
    const entry = Object.freeze({
      ...recovery,
      id: `recovery:${walletId}:${updatedAt}:${history?.length ?? 0}`,
    });
    this.#recoveryByWallet.set(walletId, recovery);
    this.#recoveryHistoryByWallet.set(
      walletId,
      appendBounded(history, entry),
    );
    this.#notifyWalletListeners(walletId);
  }

  #markRecoveryUsed(walletId: string): void {
    for (const [key, draft] of this.#sessionDrafts) {
      if (draft.walletId === walletId && !draft.recoveryUsed) {
        this.#sessionDrafts.set(
          key,
          Object.freeze({ ...draft, recoveryUsed: true }),
        );
      }
    }
  }

  #matchesActiveSession(
    walletId: string,
    sessionId: string,
    generation: number,
  ): boolean {
    const active = this.#runtimeRouter.activeSessionIdentity(walletId);
    return active?.sessionId === sessionId && active.generation === generation;
  }

  #createRecoveryContext(
    walletId: string,
    request: Partial<RecoveryRequestContext>,
    errorType: string,
  ): Readonly<RecoveryRequestContext> {
    const current = this.#latestSessionIdentity(walletId);
    return Object.freeze({
      operation: request.operation ?? 'runtime',
      sessionId:
        request.sessionId !== undefined
          ? request.sessionId
          : current?.sessionId ?? null,
      generation:
        request.generation !== undefined
          ? request.generation
          : current?.generation ?? null,
      errorType,
      classification: request.classification ?? null,
      messageHash: request.messageHash ?? null,
    });
  }

  #recoveryIdentityIsCurrent(
    walletId: string,
    context: Readonly<RecoveryRequestContext>,
  ): boolean {
    if (context.generation === null) {
      return true;
    }

    const current = this.#latestSessionIdentity(walletId);
    return Boolean(
      current &&
      current.generation === context.generation &&
      (context.sessionId === null || current.sessionId === context.sessionId),
    );
  }

  #latestSessionIdentity(walletId: string): Readonly<{
    sessionId: string;
    generation: number;
  }> | null {
    const active = this.#runtimeRouter.activeSessionIdentity(walletId);
    if (active) {
      return active;
    }

    let latestDraft: WalletSessionResult | null = null;
    for (const session of this.#sessionDrafts.values()) {
      if (session.walletId === walletId) {
        latestDraft = session;
      }
    }
    if (latestDraft) {
      return Object.freeze({
        sessionId: latestDraft.sessionId,
        generation: latestDraft.generation,
      });
    }

    const latestCompleted = this.#sessionResultsByWallet.get(walletId)?.at(-1);

    return latestCompleted
      ? Object.freeze({
          sessionId: latestCompleted.sessionId,
          generation: latestCompleted.generation,
        })
      : null;
  }

  #publishRecoveryEvent(
    type: 'warning' | 'recovery-started' | 'recovery-completed',
    walletId: string,
    code: string,
    message: string,
    context?: Readonly<RecoveryEventContext>,
  ): void {
    try {
      this.#eventPublisher?.publish({
        id: `${type}:${walletId}:${Date.now()}`,
        occurredAt: new Date().toISOString(),
        type,
        payload: {
          walletId,
          code,
          message,
          severity: type === 'warning' ? 'warning' : 'error',
          operation: context?.operation,
          attempt: context?.attempt,
          maximumAttempts: context?.maximumAttempts,
          delayMs: context?.delayMs,
          errorType: context?.errorType,
          classification: context?.classification ?? null,
          messageHash: context?.messageHash ?? null,
        },
      });
    } catch {
      // Recovery notifications cannot control a wallet runtime.
    }
  }

  #requestBalanceSynchronization(
    walletId: string,
    key: string,
    sessionId: string | null = null,
    generation: number | null = null,
    source: WalletRewardDelta['source'] = 'monitoring',
  ): void {
    if (
      this.#walletRemovals.has(walletId) ||
      !this.#applicationData.walletRegistry.wallet(walletId)
    ) {
      return;
    }

    const walletKey = `${walletId}:${key}`;
    if (this.#balanceSyncKeys.has(walletKey)) {
      return;
    }
    this.#balanceSyncKeys.add(walletKey);
    if (this.#balanceSyncKeys.size > MAX_BALANCE_SYNC_KEYS) {
      this.#balanceSyncKeys.delete(this.#balanceSyncKeys.values().next().value!);
    }
    const currentRead = this.#balanceReads.get(walletId);
    if (!currentRead) {
      void this.#synchronizeWalletBalance(
        walletId,
        sessionId,
        generation,
        source,
      );
      return;
    }

    this.#pendingBalanceReads.set(
      walletId,
      Object.freeze({ sessionId, generation, source }),
    );
    void currentRead.finally(() => {
      const pending = this.#pendingBalanceReads.get(walletId);
      if (!pending) {
        return;
      }
      this.#pendingBalanceReads.delete(walletId);
      void this.#synchronizeWalletBalance(
        walletId,
        pending.sessionId,
        pending.generation,
        pending.source,
      );
    });
  }

  #synchronizeWalletBalance(
    walletId: string,
    sessionId: string | null = null,
    generation: number | null = null,
    synchronizationSource: WalletRewardDelta['source'] = 'manual',
  ): Promise<void> {
    if (this.#walletRemovals.has(walletId)) {
      return Promise.resolve();
    }

    const existing = this.#balanceReads.get(walletId);
    if (existing) {
      return existing;
    }

    const balanceSource = this.#applicationData.walletBalanceSource;
    const wallet = this.#applicationData.walletRegistry.wallet(walletId);
    if (!balanceSource || !wallet?.walletAddress) {
      return Promise.resolve();
    }

    const operation = (async () => {
      const synchronizedAt = new Date().toISOString();
      const previous = this.#balanceByWallet.get(walletId);
      try {
        const values = Object.freeze(
          await this.#backgroundReadDispatcher.dispatch(async () => {
            const release = await this.#acquireBackgroundReadLease(
              'balance',
              walletId,
            );
            try {
              return await balanceSource.synchronize(
                walletId,
                wallet.walletAddress!,
              );
            } finally {
              release();
            }
          }),
        );
        if (
          this.#walletRemovals.has(walletId) ||
          !this.#applicationData.walletRegistry.wallet(walletId)
        ) {
          return;
        }
        const snapshot = Object.freeze({
          walletId,
          values,
          synchronizedAt,
          status: 'fresh' as const,
          errorCode: null,
        });

        if (previous?.values) {
          const delta = positiveLockedNacklDelta(
            previous.values.nacklLockedRaw,
            values.nacklLockedRaw,
          );
          if (delta) {
            await this.#recordRewardDelta(
              walletId,
              delta,
              synchronizedAt,
              sessionId,
              generation,
              synchronizationSource,
              previous.values.nacklLockedRaw,
              values.nacklLockedRaw,
              previous.synchronizedAt,
            );
          }
        }
        await this.#storeBalanceSnapshot(snapshot);
      } catch {
        if (
          this.#walletRemovals.has(walletId) ||
          !this.#applicationData.walletRegistry.wallet(walletId)
        ) {
          return;
        }
        const failedSnapshot = Object.freeze({
          walletId,
          values: previous?.values ?? null,
          synchronizedAt,
          status: previous?.values ? ('partial' as const) : ('error' as const),
          errorCode: 'wallet-balance-read-failed',
        });
        try {
          await this.#storeBalanceSnapshot(failedSnapshot);
        } catch {
          this.#rememberBalanceSnapshot(failedSnapshot);
        }
      }
    })();
    this.#balanceReads.set(walletId, operation);
    void operation.finally(() => {
      if (this.#balanceReads.get(walletId) === operation) {
        this.#balanceReads.delete(walletId);
      }
    });
    return operation;
  }

  #synchronizeMamaBoardLevel(
    walletId: string,
    force = false,
  ): Promise<void> {
    if (this.#disposed || this.#walletRemovals.has(walletId)) {
      return Promise.resolve();
    }

    const current = this.#mamaBoardReads.get(walletId);
    if (current) {
      return current;
    }

    const source = this.#applicationData.mamaBoardLevelSource;
    const wallet = this.#applicationData.walletRegistry.wallet(walletId);
    if (
      !source ||
      !wallet?.walletAddress ||
      (!force && wallet.mamaBoardLevel !== null)
    ) {
      return Promise.resolve();
    }

    const operation = (async () => {
      try {
        const level = await this.#backgroundReadDispatcher.dispatch(
          async () => {
            const release = await this.#acquireBackgroundReadLease(
              'mama-board',
              walletId,
            );
            try {
              return await source.readMamaBoardLevel(
                walletId,
                wallet.walletAddress!,
              );
            } finally {
              release();
            }
          },
        );
        if (this.#disposed || level === null) {
          return;
        }

        const latest = this.#applicationData.walletRegistry.wallet(walletId);
        if (
          this.#walletRemovals.has(walletId) ||
          !latest ||
          (!force && latest.mamaBoardLevel !== null)
        ) {
          return;
        }

        await this.#walletStorage?.saveWallet({
          id: latest.id,
          name: latest.name,
          status: latest.status,
          walletAddress: latest.walletAddress,
          onboardingStatus: latest.onboardingStatus,
          connectionReference: latest.connectionReference,
          miningCredentialReference: latest.miningCredentialReference,
          mamaBoardLevel: level,
        });
        if (this.#disposed) {
          return;
        }
        if (
          this.#applicationData.walletRegistry.updateMamaBoardLevel(
            walletId,
            level,
          )
        ) {
          this.#notifyWalletListeners(walletId);
        }
      } catch {
        // Public metadata is optional and cannot block wallet or mining lifecycle.
      }
    })();
    this.#mamaBoardReads.set(walletId, operation);
    void operation.finally(() => {
      if (this.#mamaBoardReads.get(walletId) === operation) {
        this.#mamaBoardReads.delete(walletId);
      }
    });
    return operation;
  }

  async #acquireBackgroundReadLease(
    scope: string,
    ownerId: string,
  ): Promise<() => void> {
    const gate = this.#production?.backgroundReadGate;
    if (gate?.acquireIdleLease) {
      return gate.acquireIdleLease(scope, ownerId);
    }
    await gate?.waitUntilIdle();
    return () => undefined;
  }

  #hydrateAnalytics(applicationData: ApplicationDataSources): void {
    for (const snapshot of applicationData.initialBalanceSnapshots ?? []) {
      this.#rememberBalanceSnapshot(snapshot);
    }

    for (const result of applicationData.initialSessionResults ?? []) {
      this.#sessionResultsByWallet.set(
        result.walletId,
        appendBounded(
          this.#sessionResultsByWallet.get(result.walletId),
          result,
          WALLET_SESSION_HOT_HISTORY_LIMIT,
        ),
      );
    }
  }

  async #refreshMamaBoardLevels(force: boolean): Promise<void> {
    if (this.#disposed) {
      return;
    }

    if (this.#mamaBoardRefresh) {
      await this.#mamaBoardRefresh;
      return;
    }

    const operation = (async () => {
      for (const wallet of this.#applicationData.walletRegistry.wallets()) {
        if (this.#disposed) {
          break;
        }

        if (wallet.walletAddress) {
          await this.#synchronizeMamaBoardLevel(wallet.id, force);
        }
      }
    })();
    this.#mamaBoardRefresh = operation;

    try {
      await operation;
    } finally {
      if (this.#mamaBoardRefresh === operation) {
        this.#mamaBoardRefresh = null;
      }
    }
  }

  async #storeBalanceSnapshot(
    snapshot: Readonly<WalletBalanceSnapshot>,
  ): Promise<void> {
    await this.#walletStorage?.appendWalletBalanceSnapshot?.(snapshot);
    this.#rememberBalanceSnapshot(snapshot);
  }

  #rememberBalanceSnapshot(snapshot: Readonly<WalletBalanceSnapshot>): void {
    this.#balanceByWallet.set(snapshot.walletId, snapshot);
    this.#notifyWalletListeners(snapshot.walletId, true);
  }

  async #recordRewardDelta(
    walletId: string,
    amountRaw: string,
    detectedAt: string,
    sessionId: string | null,
    generation: number | null,
    source: WalletRewardDelta['source'],
    lockedNacklBeforeRaw: string,
    lockedNacklAfterRaw: string,
    baselineSynchronizedAt: string,
  ): Promise<void> {
    if (
      this.#walletRemovals.has(walletId) ||
      !this.#applicationData.walletRegistry.wallet(walletId)
    ) {
      return;
    }

    const id = [
      'locked-nackl',
      walletId,
      lockedNacklBeforeRaw,
      lockedNacklAfterRaw,
      baselineSynchronizedAt,
    ].join(':');
    if (
      this.#applicationData.rewardLedger
        .rewardsForWallet(walletId)
        .some((reward) => reward.id === id)
    ) {
      return;
    }

    const recorded = await this.#applicationData.rewardLedger.recordReward({
      id,
      walletId,
      amount: Object.freeze({ value: amountRaw, unit: 'NACKL' }),
      recordedAt: new Date(detectedAt).getTime(),
      sessionId,
      generation,
      kind: 'locked-nackl-delta',
      lockedNacklBeforeRaw,
      lockedNacklAfterRaw,
      detectionSource: source,
    });
    if (
      !recorded ||
      this.#walletRemovals.has(walletId) ||
      !this.#applicationData.walletRegistry.wallet(walletId)
    ) {
      return;
    }

    const entry = Object.freeze({
      id,
      walletId,
      amountRaw,
      detectedAt,
      sessionId,
      generation,
      lockedNacklBeforeRaw,
      lockedNacklAfterRaw,
      observedInCurrentRun: true,
      source,
    });
    this.#latestLiveRewardByWallet.set(walletId, entry);
    if (sessionId !== null && generation !== null) {
      this.#updateSession(walletId, sessionId, generation, (result) => ({
        ...result,
        rewardDeltaRaw: amountRaw,
      }));
    }
  }

  #rewardDeltasForWallet(
    walletId: string,
    limit?: number,
  ): readonly WalletRewardDelta[] {
    const latestLiveReward = this.#latestLiveRewardByWallet.get(walletId);
    const rewards = this.#applicationData.rewardLedger.rewardsForWallet(walletId);
    const selectedRewards = limit ? rewards.slice(-limit) : rewards;

    return Object.freeze(
      selectedRewards
        .map((reward) =>
          rewardDeltaFromRecord(
            reward,
            latestLiveReward?.id === reward.id,
          ),
        )
        .filter(
          (reward): reward is Readonly<WalletRewardDelta> => reward !== null,
        ),
    );
  }

  #historyValues<T>(
    source: ReadonlyMap<string, readonly T[]>,
    walletId?: string,
  ): readonly T[] {
    return Object.freeze(
      walletId
        ? [...(source.get(walletId) ?? [])]
        : [...source.values()].flat(),
    );
  }

  #publishRuntimeError(
    walletId: string | null,
    code: string,
    message: string,
  ): void {
    if (!this.#eventPublisher) {
      return;
    }

    try {
      this.#eventPublisher.publish({
        id: `runtime-error:${walletId ?? 'unbound'}:${Date.now()}`,
        occurredAt: new Date().toISOString(),
        type: 'runtime-error',
        payload: { walletId, code, message },
      });
    } catch {
      // Diagnostics cannot control Application commands.
    }
  }

  #publishRuntimeStartStage(
    walletId: string,
    stage: CoreEventPayloads['wallet-runtime-start-stage']['stage'],
  ): void {
    if (!this.#eventPublisher) {
      return;
    }

    this.#runtimeStartEventSequence += 1;
    try {
      this.#eventPublisher.publish({
        id: `wallet-runtime-start-stage:${this.#runtimeStartEventSequence}`,
        occurredAt: new Date().toISOString(),
        type: 'wallet-runtime-start-stage',
        payload: { walletId, stage },
      });
    } catch {
      // Diagnostics cannot control Application commands.
    }
  }

  async #dispose(): Promise<void> {
    this.#cancelTimedMiningState(false);
    this.#suspendMainEpochStartForDisposal();
    if (this.#mamaBoardRefreshTimer) {
      clearInterval(this.#mamaBoardRefreshTimer);
      this.#mamaBoardRefreshTimer = null;
    }
    this.#unsubscribeFromApplicationEvents();
    this.#unsubscribeFromWalletConnections();
    this.#unsubscribeFromSystemObservability();
    await this.#globalMiningUptime.dispose();
    const mamaBoardRefresh = this.#mamaBoardRefresh;
    if (mamaBoardRefresh) {
      await mamaBoardRefresh;
    }
    await this.#walletConnections.dispose();
    await this.#runtimeRouter.dispose();
    await this.#production?.dispose();
    await this.#mainEpochStartPersistence;

    this.#systemObservability.dispose();
    this.#diagnostics.dispose?.();

    this.#walletListeners.clear();
  }

  #cancelTimedMiningState(notify = true): void {
    if (this.#timedMiningTimer) {
      clearTimeout(this.#timedMiningTimer);
      this.#timedMiningTimer = null;
    }
    this.#timedMiningSequence += 1;
    this.#timedMining = INACTIVE_TIMED_MINING;
    if (notify) this.#notifyWalletListeners();
  }

  #observeMainEpochForArmedStart(currentMainEpoch: string | null): void {
    if (
      this.#mainEpochStart.status !== 'waiting-for-main-epoch' ||
      !currentMainEpoch ||
      !this.#mainEpochStart.baselineMainEpoch ||
      compareEpochIds(
        currentMainEpoch,
        this.#mainEpochStart.baselineMainEpoch,
      ) <= 0
    ) {
      return;
    }

    const epochDetectedAt = Date.now();
    const delayHours = this.#mainEpochStart.delayHours!;
    const sequence = this.#mainEpochStartSequence;
    this.#mainEpochStart = Object.freeze({
      ...this.#mainEpochStart,
      status: 'waiting-for-delay',
      detectedMainEpoch: currentMainEpoch,
      epochDetectedAt,
      targetStartAt: epochDetectedAt + delayHours * HOUR_MS,
      failureCode: null,
    });
    this.#persistMainEpochStart();
    this.#scheduleMainEpochStart(sequence);
    this.#notifyWalletListeners();
  }

  #scheduleMainEpochStart(sequence: number): void {
    if (this.#mainEpochStartTimer) clearTimeout(this.#mainEpochStartTimer);
    const targetStartAt = this.#mainEpochStart.targetStartAt;
    if (targetStartAt === null) return;
    this.#mainEpochStartTimer = setTimeout(() => {
      this.#mainEpochStartTimer = null;
      if (
        sequence !== this.#mainEpochStartSequence ||
        this.#disposed ||
        this.#mainEpochStart.status !== 'waiting-for-delay'
      ) {
        return;
      }
      if (Date.now() < targetStartAt) {
        this.#scheduleMainEpochStart(sequence);
        return;
      }
      this.#mainEpochStart = Object.freeze({
        ...this.#mainEpochStart,
        status: 'starting',
        failureCode: null,
      });
      this.#persistMainEpochStart(null);
      this.#notifyWalletListeners();
      void this.startAllMining('MAIN_EPOCH').then((result) => {
        if (
          sequence !== this.#mainEpochStartSequence ||
          this.#disposed ||
          this.#mainEpochStart.status !== 'starting'
        ) {
          return;
        }
        this.#mainEpochStart = Object.freeze({
          ...this.#mainEpochStart,
          status: result.accepted ? 'completed' : 'failed',
          failureCode: result.accepted ? null : 'start-failed',
        });
        this.#notifyWalletListeners();
      }).catch(() => {
        if (
          sequence !== this.#mainEpochStartSequence ||
          this.#disposed ||
          this.#mainEpochStart.status !== 'starting'
        ) {
          return;
        }
        this.#mainEpochStart = Object.freeze({
          ...this.#mainEpochStart,
          status: 'failed',
          failureCode: 'start-failed',
        });
        this.#notifyWalletListeners();
      });
    }, Math.max(0, targetStartAt - Date.now()));
  }

  #cancelMainEpochStartState(notify = true): void {
    if (this.#mainEpochStartTimer) {
      clearTimeout(this.#mainEpochStartTimer);
      this.#mainEpochStartTimer = null;
    }
    this.#mainEpochStartSequence += 1;
    this.#mainEpochStart = INACTIVE_MAIN_EPOCH_START;
    this.#persistMainEpochStart(null);
    if (notify) this.#notifyWalletListeners();
  }

  #suspendMainEpochStartForDisposal(): void {
    if (this.#mainEpochStartTimer) {
      clearTimeout(this.#mainEpochStartTimer);
      this.#mainEpochStartTimer = null;
    }
    this.#mainEpochStartSequence += 1;
  }

  #persistMainEpochStart(
    explicit?: Readonly<MainEpochStartPersistenceSnapshot> | null,
  ): void {
    if (!this.#mainEpochStartStorage) return;
    const current = this.#mainEpochStart;
    const snapshot = explicit !== undefined
      ? explicit
      : current.status === 'waiting-for-main-epoch' ||
          current.status === 'waiting-for-delay'
        ? Object.freeze({
            status: current.status,
            armedAt: current.armedAt!,
            baselineMainEpoch: current.baselineMainEpoch!,
            delayHours: current.delayHours!,
            detectedMainEpoch: current.detectedMainEpoch,
            epochDetectedAt: current.epochDetectedAt,
            targetStartAt: current.targetStartAt,
          })
        : null;
    this.#mainEpochStartPersistence = this.#mainEpochStartPersistence
      .catch(() => undefined)
      .then(() => this.#mainEpochStartStorage!.saveMainEpochStartSchedule(snapshot))
      .catch(() => undefined);
  }

  #requestMining(walletId: string): void {
    const wasEmpty = this.#desiredMiningWallets.size === 0;
    this.#desiredMiningWallets.add(walletId);
    if (wasEmpty) {
      this.#globalMiningUptime.start();
      this.#notifyWalletListeners();
    }
  }

  #releaseMining(walletId: string): void {
    if (!this.#desiredMiningWallets.delete(walletId)) {
      return;
    }
    if (this.#desiredMiningWallets.size === 0) {
      this.#globalMiningUptime.stop();
      this.#notifyWalletListeners();
    }
  }

  #commandResult(
    accepted: boolean,
    reasonCode: MiningCommandResult['reasonCode'],
    message: string,
    walletId: string | null,
  ): Readonly<MiningCommandResult> {
    return Object.freeze({ accepted, reasonCode, message, walletId });
  }

  #batchCommandResult(
    accepted: boolean,
    reasonCode: MiningBatchCommandResult['reasonCode'],
    message: string,
    results: readonly Readonly<MiningCommandResult>[],
  ): Readonly<MiningBatchCommandResult> {
    return Object.freeze({
      accepted,
      reasonCode,
      message,
      results: Object.freeze([...results]),
    });
  }

  #timedMiningResult(
    accepted: boolean,
    reasonCode: TimedMiningCommandResult['reasonCode'],
    message: string,
  ): Readonly<TimedMiningCommandResult> {
    return Object.freeze({ accepted, reasonCode, message });
  }

  #mainEpochStartResult(
    accepted: boolean,
    reasonCode: MainEpochStartCommandResult['reasonCode'],
    message: string,
  ): Readonly<MainEpochStartCommandResult> {
    return Object.freeze({ accepted, reasonCode, message });
  }
}

function isLiveMiningRewardDelta(
  reward: Readonly<WalletRewardDelta>,
): boolean {
  return (
    reward.observedInCurrentRun &&
    (reward.source === 'settlement' || reward.source === 'reward-sync') &&
    reward.sessionId !== null &&
    reward.generation !== null
  );
}

const MAX_RECOVERY_ATTEMPTS = 5;
const QUEUE_OVERFLOW_CODE = 'QUEUE_OVERFLOW';
const MAX_HISTORY_ENTRIES = 100;
const MAX_BALANCE_SYNC_KEYS = 500;
const MAMA_BOARD_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;
const WALLET_SESSION_HOT_HISTORY_LIMIT = 5;
const WALLET_REWARD_PRESENTATION_LIMIT = 6;
const START_ALL_STAGGER_MS = 1_000;
const HOUR_MS = 60 * 60 * 1_000;
export const TIMED_MINING_TERMINAL_WAIT_MS = 15 * 60 * 1_000;
const AMBIGUOUS_REWARD_VERIFY_DELAY_MS = 2_000;

const INACTIVE_TIMED_MINING: Readonly<TimedMiningSnapshot> = Object.freeze({
  status: 'inactive',
  startedAt: null,
  durationMs: null,
  targetEndAt: null,
  shutdownAfterCompletion: false,
  failureCode: null,
});

const INACTIVE_MAIN_EPOCH_START: Readonly<MainEpochStartSnapshot> =
  Object.freeze({
    status: 'inactive',
    armedAt: null,
    baselineMainEpoch: null,
    delayHours: null,
    detectedMainEpoch: null,
    epochDetectedAt: null,
    targetStartAt: null,
    failureCode: null,
  });

const UNSUPPORTED_COMPUTER_SHUTDOWN: ComputerShutdownRequester = Object.freeze({
  shutdownComputer: async () => 'unsupported' as const,
});

interface RecoveryRequestContext {
  readonly operation: string;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly errorType: string;
  readonly classification: BeeFailureClassification | null;
  readonly messageHash: string | null;
}

interface RecoveryEventContext extends RecoveryRequestContext {
  readonly attempt: number;
  readonly maximumAttempts: number;
  readonly delayMs: number;
}

function isQueueOverflowFailure(
  code: string | null | undefined,
  message: string | null | undefined,
  classification?: BeeFailureClassification | null,
): boolean {
  return (
    classification === 'QUEUE_OVERFLOW' ||
    (classification === undefined &&
      classifyBeeFailureText(code, message) === 'QUEUE_OVERFLOW')
  );
}

function isAmbiguousRewardFailure(
  classification: BeeFailureClassification | null,
): classification is 'DUPLICATE_MESSAGE' | 'TIMEOUT' {
  return classification === 'DUPLICATE_MESSAGE' || classification === 'TIMEOUT';
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function settlesBefore(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    operation.then(() => true, () => false),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function isWholeHoursInRange(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function compareEpochIds(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

function errorDetail(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message.trim() || null;
  }
  if (typeof error === 'string') {
    return error.trim() || null;
  }
  if (error === null || error === undefined) {
    return null;
  }

  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : null;
  } catch {
    return null;
  }
}

function recoveryOperationFromId(operationId: string): string {
  const [operation] = operationId.split(':', 1);
  return operation?.trim() || 'runtime';
}

function appendBounded<T>(
  history: readonly T[] | undefined,
  entry: T,
  limit = MAX_HISTORY_ENTRIES,
): readonly T[] {
  return Object.freeze([...(history ?? []), entry].slice(-limit));
}

function rewardDeltaFromRecord(
  reward: Readonly<RewardRecord>,
  observedInCurrentRun: boolean,
): Readonly<WalletRewardDelta> | null {
  if (
    reward.kind !== 'locked-nackl-delta' ||
    reward.lockedNacklBeforeRaw == null ||
    reward.lockedNacklAfterRaw == null ||
    !reward.detectionSource
  ) {
    return null;
  }

  return Object.freeze({
    id: reward.id,
    walletId: reward.walletId,
    amountRaw: reward.amount.value,
    detectedAt: new Date(reward.recordedAt).toISOString(),
    sessionId: reward.sessionId,
    generation: reward.generation,
    lockedNacklBeforeRaw: reward.lockedNacklBeforeRaw,
    lockedNacklAfterRaw: reward.lockedNacklAfterRaw,
    observedInCurrentRun,
    source: reward.detectionSource,
  });
}

function coreEventWalletId(event: CoreEvent): string | null {
  if (!('walletId' in event.payload)) {
    return null;
  }

  const walletId = event.payload.walletId;
  return typeof walletId === 'string' && walletId.length > 0
    ? walletId
    : null;
}

function sessionKey(
  walletId: string,
  sessionId: string,
  generation: number,
): string {
  return `${walletId}:${sessionId}:${generation}`;
}

function createWalletId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure wallet identity generation is unavailable.');
  }

  return `wallet-${globalThis.crypto.randomUUID()}`;
}

function presentEpochWindow(
  window: Readonly<EpochWindowSnapshot>,
  currentBlock: string | null,
  status: EpochPresentationStatus,
): Readonly<EpochWindowPresentation> {
  return Object.freeze({
    status,
    id: window.id,
    startBlock: window.startBlock,
    endBlock: window.endBlock,
    currentBlock,
    progressPercent: roundProgress(window.progressPercent),
    elapsedMs: window.elapsedMs,
    remainingMs: window.remainingMs,
    remainingBlocks: window.remainingBlocks,
    elapsedLabel: formatDuration(window.elapsedMs),
    remainingLabel: formatDuration(window.remainingMs),
    startedAt: window.startedAt,
    expectedEndAt: window.expectedEndAt,
    expectedEndLabel: formatTimestamp(window.expectedEndAt),
  });
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return 'Synchronizing';
  }

  const totalSeconds = Math.max(0, Math.ceil(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : `${minutes}m ${seconds}s`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Synchronizing';
  }

  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function roundProgress(value: number | null): number {
  return value === null ? 0 : Math.round(value * 10) / 10;
}
