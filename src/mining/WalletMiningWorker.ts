import {
  DEFAULT_WALLET_MINING_WORKER_OPTIONS,
  isQueueFailure,
  MiningNativeAdapterError,
  NOOP_MINING_DIAGNOSTIC_SINK,
  NOOP_PREPARE_DISPATCH_LIMITER,
  NOOP_QUEUE_PRESSURE_CONTROLLER,
  NOOP_REWARD_DISPATCH_LIMITER,
  NOOP_START_DISPATCH_LIMITER,
  NOOP_SUBMISSION_GUARD,
  SYSTEM_WALLET_MINING_RANDOM,
  SYSTEM_WALLET_MINING_TIMER,
  type CanonicalMiniEpochSource,
  type MiningNativeAdapter,
  type NativeMinerHandle,
  type SafeMiningFailure,
  type SafeNativeCallback,
  type ValidatedMiningIdentity,
  type WalletMiningDiagnosticEvent,
  type WalletMiningDiagnosticSink,
  type WalletMiningDisposalStatus,
  type WalletMiningIdentitySource,
  type WalletMiningPrepareDispatchLimiter,
  type WalletMiningQueuePressureController,
  type WalletMiningRandomSource,
  type WalletMiningRewardDispatchLimiter,
  type WalletMiningRewardStatus,
  type WalletMiningStartDispatchLimiter,
  type WalletMiningSubmissionGuard,
  type WalletMiningRuntime,
  type WalletMiningSnapshot,
  type WalletMiningStartResult,
  type WalletMiningStopReason,
  type WalletMiningStopResult,
  type WalletMiningTerminalOutcome,
  type WalletMiningTimerSource,
  type WalletMiningWorkerOptions,
  type WalletMiningWorkerState,
} from './WalletMiningRuntime';

const LEGAL_TRANSITIONS: Readonly<
  Record<WalletMiningWorkerState, ReadonlySet<WalletMiningWorkerState>>
> = Object.freeze({
  IDLE: stateSet('PREPARING', 'WAITING_EPOCH', 'BACKOFF', 'DISPOSED'),
  PREPARING: stateSet('READY', 'TERMINAL', 'BACKOFF', 'DISPOSING'),
  READY: stateSet('MINING', 'TERMINAL', 'DISPOSING'),
  MINING: stateSet('STOP_REQUESTED', 'SUBMITTING_ROOT', 'WAITING_RESULT', 'TERMINAL'),
  STOP_REQUESTED: stateSet('SUBMITTING_ROOT', 'WAITING_RESULT', 'TERMINAL'),
  SUBMITTING_ROOT: stateSet('WAITING_INTERVAL', 'WAITING_RESULT', 'TERMINAL'),
  WAITING_INTERVAL: stateSet('SUBMITTING_PROOF', 'WAITING_RESULT', 'TERMINAL'),
  SUBMITTING_PROOF: stateSet('WAITING_RESULT', 'TERMINAL'),
  WAITING_RESULT: stateSet('TERMINAL'),
  TERMINAL: stateSet('REWARDING', 'DISPOSING'),
  REWARDING: stateSet('DISPOSING'),
  DISPOSING: stateSet('WAITING_EPOCH', 'BACKOFF', 'IDLE', 'DISPOSED'),
  WAITING_EPOCH: stateSet('PREPARING', 'DISPOSING', 'IDLE', 'DISPOSED'),
  BACKOFF: stateSet('PREPARING', 'WAITING_EPOCH', 'DISPOSING', 'IDLE', 'DISPOSED'),
  DISPOSED: stateSet(),
});

// A just-started native worker gets one second to become tap-ready before the
// tap is treated as failed.
const WORKER_LIFECYCLE_TAP_RETRY_MS = 1_000;
const EPOCH_START_ORDER_STEP_MS = 25;
const MINI_EPOCH_BLOCKS = 1_000n;
const PREPARE_RETRY_DELAYS_MS = Object.freeze([
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
] as const);
const QUEUE_PREPARE_RETRY_DELAYS_MS = Object.freeze([
  8_000,
  16_000,
  30_000,
] as const);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface GenerationOwnership {
  readonly token: string;
  readonly sessionId: string;
  readonly miniEpoch: string;
  readonly allocationSettled: Deferred<void>;
  readonly completion: Deferred<void>;
  readonly callbackSequences: Set<number>;
  readonly prepareAbortController: AbortController;
  nativeMiner: NativeMinerHandle | null;
  queuedLocalTaps: number;
  nativeComputedTaps: number;
  computationCompletedTaps: number | null;
  baselineTapSum: bigint | null;
  latestTapSum: bigint | null;
  confirmedTapDelta: bigint | null;
  terminalOutcome: WalletMiningTerminalOutcome | null;
  terminalFailure: Readonly<SafeMiningFailure> | null;
  pendingFailure: Readonly<SafeMiningFailure> | null;
  partialNativeSession: boolean;
  productiveStarted: boolean;
  pressureOutcomeReported: boolean;
  queueFailureObserved: Readonly<SafeMiningFailure> | null;
  stopIssued: boolean;
  freeIssued: boolean;
  rewardIssued: boolean;
  completionStarted: boolean;
  disposeRequested: boolean;
  backoffAfterDisposal: boolean;
  releaseNativeAfterTerminal: boolean;
  prepareDispatchOwned: boolean;
  startDispatchOwned: boolean;
  releaseIdleLease: (() => void) | null;
  releaseSubmissionGuard: (() => void) | null;
  postSubmissionPermit: Promise<() => void> | null;
  tapTimer: unknown | null;
  nativeSessionWatchdogTimer: unknown | null;
  terminalGraceTimer: unknown | null;
  settlementTimer: unknown | null;
}

export interface WalletMiningWorkerDependencies {
  readonly nativeAdapter: MiningNativeAdapter;
  readonly epochSource: CanonicalMiniEpochSource;
  readonly identitySource: WalletMiningIdentitySource;
  readonly timerSource?: WalletMiningTimerSource;
  readonly randomSource?: WalletMiningRandomSource;
  readonly diagnostics?: WalletMiningDiagnosticSink;
  readonly prepareDispatchLimiter?: WalletMiningPrepareDispatchLimiter;
  readonly startDispatchLimiter?: WalletMiningStartDispatchLimiter;
  readonly queuePressureController?: WalletMiningQueuePressureController;
  readonly rewardDispatchLimiter?: WalletMiningRewardDispatchLimiter;
  readonly submissionGuard?: WalletMiningSubmissionGuard;
  readonly automaticContinuationEnabled?: boolean;
  readonly options?: Partial<WalletMiningWorkerOptions>;
}

export class WalletMiningWorker implements WalletMiningRuntime {
  readonly #listeners = new Set<
    (snapshot: Readonly<WalletMiningSnapshot>) => void
  >();
  readonly #timer: WalletMiningTimerSource;
  readonly #random: WalletMiningRandomSource;
  readonly #diagnostics: WalletMiningDiagnosticSink;
  readonly #prepareLimiter: WalletMiningPrepareDispatchLimiter;
  readonly #startLimiter: WalletMiningStartDispatchLimiter;
  readonly #queuePressure: WalletMiningQueuePressureController;
  readonly #rewardLimiter: WalletMiningRewardDispatchLimiter;
  readonly #submissionGuard: WalletMiningSubmissionGuard;
  readonly #automaticContinuationEnabled: boolean;
  readonly #options: Readonly<WalletMiningWorkerOptions>;
  readonly #unsubscribeEpoch: () => void;

  #state: WalletMiningWorkerState = 'IDLE';
  #desiredMining = false;
  #identity: Readonly<ValidatedMiningIdentity> | null = null;
  #generation: GenerationOwnership | null = null;
  #pendingMiniEpoch: string | null = null;
  #rewardStatus: WalletMiningRewardStatus = 'NOT_REQUESTED';
  #disposalStatus: WalletMiningDisposalStatus = 'NOT_STARTED';
  #quarantined = false;
  #lastCallbackAction: string | null = null;
  #lastCallbackSequence: number | null = null;
  #lastTransitionObservationDerived = false;
  #disposedRequested = false;
  #prepareRetryTimer: unknown | null = null;
  #prepareRetryCount = 0;
  #prepareRetryMiniEpoch: string | null = null;
  #prepareRetryKind: 'QUEUE' | 'ORDINARY' | null = null;
  #epochStartTimer: unknown | null = null;
  #epochStartMiniEpoch: string | null = null;
  #lastNativeStartMiniEpoch: string | null = null;

  constructor(
    readonly walletId: string,
    readonly dependencies: Readonly<WalletMiningWorkerDependencies>,
  ) {
    if (!walletId.trim()) {
      throw new TypeError('WalletMiningWorker requires a wallet ID.');
    }

    this.#timer = dependencies.timerSource ?? SYSTEM_WALLET_MINING_TIMER;
    this.#random = dependencies.randomSource ?? SYSTEM_WALLET_MINING_RANDOM;
    this.#diagnostics = dependencies.diagnostics ?? NOOP_MINING_DIAGNOSTIC_SINK;
    this.#prepareLimiter =
      dependencies.prepareDispatchLimiter ?? NOOP_PREPARE_DISPATCH_LIMITER;
    this.#startLimiter =
      dependencies.startDispatchLimiter ?? NOOP_START_DISPATCH_LIMITER;
    this.#queuePressure =
      dependencies.queuePressureController ?? NOOP_QUEUE_PRESSURE_CONTROLLER;
    this.#rewardLimiter =
      dependencies.rewardDispatchLimiter ?? NOOP_REWARD_DISPATCH_LIMITER;
    this.#submissionGuard =
      dependencies.submissionGuard ?? NOOP_SUBMISSION_GUARD;
    this.#automaticContinuationEnabled =
      dependencies.automaticContinuationEnabled ?? true;
    this.#options = Object.freeze({
      ...DEFAULT_WALLET_MINING_WORKER_OPTIONS,
      ...dependencies.options,
    });
    validateOptions(this.#options);
    this.#unsubscribeEpoch = dependencies.epochSource.subscribe(() => {
      this.#handleMiniEpochChange();
    });
  }

  async start(
    input: Readonly<ValidatedMiningIdentity>,
  ): Promise<Readonly<WalletMiningStartResult>> {
    if (this.#state === 'DISPOSED' || this.#disposedRequested) {
      return startResult('FAILED', null);
    }
    if (input.walletId !== this.walletId) {
      throw new Error('Validated mining identity belongs to another wallet.');
    }
    if (this.#quarantined) {
      return startResult('FAILED', this.#generation);
    }

    this.#clearAutomaticEpochStart();
    this.#desiredMining = true;
    this.#identity = freezeIdentity(input);
    const miniEpoch = this.dependencies.epochSource.snapshot().miniEpoch;

    if (!miniEpoch) {
      this.#transition('BACKOFF');
      return startResult('FAILED', this.#generation);
    }

    if (
      this.#state !== 'IDLE' &&
      this.#state !== 'BACKOFF' &&
      !(
        this.#state === 'WAITING_EPOCH' &&
        this.#generation?.miniEpoch !== miniEpoch
      )
    ) {
      return startResult('ALREADY_ACTIVE', this.#generation);
    }

    if (
      this.#state === 'WAITING_EPOCH' &&
      this.#generation?.miniEpoch === miniEpoch
    ) {
      return startResult('ALREADY_ACTIVE', this.#generation);
    }

    return this.#beginGeneration(this.#identity, miniEpoch);
  }

  async stop(
    _reason: WalletMiningStopReason,
  ): Promise<Readonly<WalletMiningStopResult>> {
    this.#clearAutomaticEpochStart();
    this.#clearPrepareRetry(true);
    this.#desiredMining = false;
    this.#identity = null;
    const generation = this.#generation;

    if (this.#state === 'IDLE' || this.#state === 'DISPOSED') {
      return stopResult('ALREADY_STOPPED', generation);
    }

    if (this.#state === 'WAITING_EPOCH' || this.#state === 'BACKOFF') {
      if (generation?.nativeMiner) {
        this.#transition('DISPOSING');
        const disposed = await this.#disposeNativeMiner(generation);
        if (!disposed) return stopResult('QUARANTINED', generation);
      }
      this.#transition('IDLE');
      return stopResult('STOPPED', generation);
    }

    if (!generation) {
      this.#transition('IDLE');
      return stopResult('STOPPED', null);
    }

    switch (this.#state) {
      case 'PREPARING':
      case 'READY':
        this.#terminalize(generation, 'CANCELLED', null);
        break;
      case 'MINING':
        this.#clearTapScheduling(generation);
        this.#issueNativeStop(generation);
        break;
      case 'STOP_REQUESTED':
      case 'SUBMITTING_ROOT':
      case 'WAITING_INTERVAL':
      case 'SUBMITTING_PROOF':
      case 'WAITING_RESULT':
      case 'TERMINAL':
      case 'REWARDING':
      case 'DISPOSING':
        break;
      default:
        break;
    }

    await generation.completion.promise;
    return stopResult(
      this.#quarantined ? 'QUARANTINED' : 'STOPPED',
      generation,
    );
  }

  snapshot(): Readonly<WalletMiningSnapshot> {
    const generation = this.#generation;
    return Object.freeze({
      walletId: this.walletId,
      state: this.#state,
      sessionId: generation?.sessionId ?? null,
      generationToken: generation?.token ?? null,
      miniEpoch: generation?.miniEpoch ?? null,
      desiredMining: this.#desiredMining,
      queuedLocalTaps: generation?.queuedLocalTaps ?? 0,
      nativeComputedTaps: generation?.nativeComputedTaps ?? 0,
      computationCompletedTaps:
        generation?.computationCompletedTaps ?? null,
      baselineTapSum: generation?.baselineTapSum?.toString() ?? null,
      latestTapSum: generation?.latestTapSum?.toString() ?? null,
      confirmedTapDelta: generation?.confirmedTapDelta?.toString() ?? null,
      // Retained in the public snapshot only for persisted diagnostic compatibility.
      submissionStaggerMs: null,
      terminalOutcome: generation?.terminalOutcome ?? null,
      failureStage:
        generation?.terminalFailure?.failureStage ??
        (generation?.terminalOutcome
          ? null
          : generation?.pendingFailure?.failureStage ?? null),
      errorCategory:
        generation?.terminalFailure?.errorCategory ??
        (generation?.terminalOutcome
          ? null
          : generation?.pendingFailure?.errorCategory ?? null),
      rewardStatus: this.#rewardStatus,
      disposalStatus: this.#disposalStatus,
      quarantined: this.#quarantined,
      lastCallbackAction: this.#lastCallbackAction,
      lastCallbackSequence: this.#lastCallbackSequence,
      transitionObservationDerived: this.#lastTransitionObservationDerived,
    });
  }

  subscribe(
    listener: (snapshot: Readonly<WalletMiningSnapshot>) => void,
  ): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#state === 'DISPOSED') return;
    this.#clearAutomaticEpochStart();
    this.#clearPrepareRetry(true);
    this.#disposedRequested = true;
    this.#desiredMining = false;
    this.#identity = null;
    this.#unsubscribeEpoch();

    if (this.#state === 'WAITING_EPOCH' || this.#state === 'BACKOFF') {
      const generation = this.#generation;
      if (generation?.nativeMiner) {
        this.#transition('DISPOSING');
        const disposed = await this.#disposeNativeMiner(generation);
        if (!disposed) return;
      }
      this.#transition('DISPOSED');
      return;
    }

    if (this.#state === 'IDLE') {
      this.#transition('DISPOSED');
      return;
    }

    const generation = this.#generation;
    if (!generation) {
      this.#transition('DISPOSED');
      return;
    }
    generation.disposeRequested = true;

    if (this.#state === 'PREPARING' || this.#state === 'READY') {
      this.#terminalize(generation, 'CANCELLED', null);
    } else if (this.#state === 'MINING') {
      this.#clearTapScheduling(generation);
      this.#issueNativeStop(generation);
    }

    await generation.completion.promise;
  }

  async #beginGeneration(
    identity: Readonly<ValidatedMiningIdentity>,
    miniEpoch: string,
  ): Promise<Readonly<WalletMiningStartResult>> {
    if (this.#state === 'DISPOSED' || this.#quarantined) {
      return startResult('FAILED', this.#generation);
    }

    const admission = this.dependencies.epochSource.snapshot();
    if (this.#options.minimumStartWindowMs > 0 &&
        (admission.miniEpoch !== miniEpoch || admission.remainingMs === null ||
         !Number.isFinite(admission.remainingMs) || admission.remainingMs < this.#options.minimumStartWindowMs)) {
      this.#transition('WAITING_EPOCH');
      return startResult('WAITING_EPOCH', this.#generation);
    }
    this.#clearAutomaticEpochStart();
    this.#clearPrepareRetry(false);
    if (this.#prepareRetryMiniEpoch !== miniEpoch) {
      this.#prepareRetryMiniEpoch = miniEpoch;
      this.#prepareRetryCount = 0;
      this.#prepareRetryKind = null;
    }

    const generation = createGeneration(
      this.dependencies.identitySource.nextGenerationToken(this.walletId),
      this.dependencies.identitySource.nextSessionId(this.walletId),
      miniEpoch,
    );
    this.#generation = generation;
    this.#pendingMiniEpoch = null;
    this.#rewardStatus = 'NOT_REQUESTED';
    this.#disposalStatus = 'NOT_STARTED';
    this.#lastCallbackAction = null;
    this.#lastCallbackSequence = null;
    this.#transition('PREPARING');

    try {
      await this.#prepareLimiter.waitForDispatch(
        this.walletId,
        generation.token,
        generation.prepareAbortController.signal,
      );
      generation.prepareDispatchOwned = true;
      generation.releaseIdleLease =
        await this.#submissionGuard.acquireIdleLease(
          'prepare',
          `${this.walletId}:${generation.token}`,
          generation.prepareAbortController.signal,
        );
      if (
        !this.#owns(generation) ||
        generation.terminalOutcome ||
        !this.#desiredMining ||
        this.#disposedRequested
      ) {
        this.#releaseIdleLease(generation);
        this.#reportPrepareOutcome(generation, null);
        generation.allocationSettled.resolve(undefined);
        await generation.completion.promise;
        return startResult('CANCELLED', generation);
      }
      if (!this.#admissionCurrent(miniEpoch)) {
        this.#releaseIdleLease(generation);
        this.#reportPrepareOutcome(generation, null);
        generation.allocationSettled.resolve(undefined);
        this.#terminalize(generation, 'CANCELLED', null);
        await generation.completion.promise;
        return startResult('CANCELLED', generation);
      }
      this.#recordStage('NATIVE_PREPARE_START', generation);
      generation.nativeMiner = await this.dependencies.nativeAdapter.createMiner({
        endpoints: [...identity.endpoints],
        appId: identity.appId,
        minerAddress: identity.minerAddress,
        publicKey: identity.publicKey,
        secretKey: identity.secretKey,
      });
      generation.allocationSettled.resolve(undefined);
      this.#recordStage('NATIVE_PREPARE_RESULT', generation);
    } catch (error) {
      generation.allocationSettled.resolve(undefined);
      this.#releaseIdleLease(generation);
      if (generation.prepareAbortController.signal.aborted) {
        this.#reportPrepareOutcome(generation, null);
        if (!generation.terminalOutcome) {
          this.#terminalize(generation, 'CANCELLED', null);
        }
        await generation.completion.promise;
        return startResult('CANCELLED', generation);
      }
      generation.backoffAfterDisposal = true;
      generation.releaseNativeAfterTerminal = true;
      const prepareFailure = safeFailure(
        error,
        'PREPARE',
        'MINER_NEW_FAILED',
      );
      this.#observeQueueFailure(generation, prepareFailure);
      this.#reportPrepareOutcome(generation, prepareFailure);
      this.#recordStage(
        'NATIVE_PREPARE_RESULT',
        generation,
        undefined,
        prepareFailure,
      );
      if (!generation.terminalOutcome) {
        this.#terminalize(
          generation,
          'NATIVE_ERROR',
          prepareFailure,
        );
      }
      return startResult('FAILED', generation);
    }

    if (!this.#owns(generation) || generation.terminalOutcome) {
      this.#releaseIdleLease(generation);
      this.#reportPrepareOutcome(generation, null);
      await generation.completion.promise;
      return startResult('CANCELLED', generation);
    }
    const nativeMiner = generation.nativeMiner;
    if (!nativeMiner) {
      this.#releaseIdleLease(generation);
      const ownershipFailure = failure('PREPARE', 'MINER_HANDLE_MISSING');
      generation.backoffAfterDisposal = true;
      generation.releaseNativeAfterTerminal = true;
      this.#reportPrepareOutcome(generation, ownershipFailure);
      this.#terminalize(generation, 'NATIVE_ERROR', ownershipFailure);
      return startResult('FAILED', generation);
    }

    await this.#readBaselineBestEffort(generation);
    if (!this.#owns(generation) || generation.terminalOutcome) {
      this.#releaseIdleLease(generation);
      this.#reportPrepareOutcome(generation, null);
      await generation.completion.promise;
      return startResult('CANCELLED', generation);
    }

    let canStart = false;
    try {
      canStart = await nativeMiner.canStart();
    } catch (error) {
      this.#releaseIdleLease(generation);
      generation.backoffAfterDisposal = true;
      generation.releaseNativeAfterTerminal = true;
      const canStartFailure = safeFailure(error, 'PREPARE', 'CAN_START_FAILED');
      this.#reportPrepareOutcome(generation, canStartFailure);
      this.#terminalize(
        generation,
        'NATIVE_ERROR',
        canStartFailure,
      );
      return startResult('FAILED', generation);
    }

    if (!canStart) {
      this.#releaseIdleLease(generation);
      generation.backoffAfterDisposal = true;
      generation.releaseNativeAfterTerminal = true;
      const notReadyFailure = failure('PREPARE', 'MINER_NOT_READY');
      this.#reportPrepareOutcome(generation, notReadyFailure);
      this.#terminalize(
        generation,
        'AMBIGUOUS',
        notReadyFailure,
      );
      return startResult('FAILED', generation);
    }
    this.#reportPrepareOutcome(generation, null);
    this.#releaseIdleLease(generation);

    this.#transition('READY');
    if (!this.#desiredMining) {
      this.#terminalize(generation, 'CANCELLED', null);
      await generation.completion.promise;
      return startResult('CANCELLED', generation);
    }

    try {
      await this.#startLimiter.waitForDispatch(
        this.walletId,
        generation.token,
        generation.prepareAbortController.signal,
      );
      generation.startDispatchOwned = true;
      generation.releaseIdleLease =
        await this.#submissionGuard.acquireIdleLease(
          'start',
          `${this.walletId}:${generation.token}`,
          generation.prepareAbortController.signal,
        );
      if (
        !this.#owns(generation) ||
        generation.terminalOutcome ||
        !this.#desiredMining ||
        this.#disposedRequested
      ) {
        this.#releaseIdleLease(generation);
        this.#reportStartOutcome(generation, null);
        if (!generation.terminalOutcome) {
          this.#terminalize(generation, 'CANCELLED', null);
        }
        await generation.completion.promise;
        return startResult('CANCELLED', generation);
      }
      if (!this.#admissionCurrent(miniEpoch)) {
        this.#releaseIdleLease(generation);
        this.#reportStartOutcome(generation, null);
        this.#terminalize(generation, 'CANCELLED', null);
        await generation.completion.promise;
        return startResult('CANCELLED', generation);
      }
      if (this.#lastNativeStartMiniEpoch === miniEpoch) {
        this.#releaseIdleLease(generation);
        const duplicateStartFailure = failure(
          'PREPARE',
          'DUPLICATE_PRODUCTIVE_SESSION_BLOCKED',
        );
        generation.releaseNativeAfterTerminal = true;
        this.#reportStartOutcome(generation, duplicateStartFailure);
        this.#terminalize(generation, 'CANCELLED', duplicateStartFailure);
        await generation.completion.promise;
        return startResult('FAILED', generation);
      }
      this.#transition('MINING');
      const durationMs = effectiveSessionDuration(
        this.#options.sessionDurationMs,
        this.dependencies.epochSource.snapshot().remainingMs,
        this.#options.epochEndSafetyMarginMs,
      );
      // A thrown native start is ambiguous. Claim the epoch before invoking it
      // so a retry cannot accidentally create two productive sessions.
      this.#lastNativeStartMiniEpoch = miniEpoch;
      await nativeMiner.start(durationMs, (callback) => {
        this.#handleNativeCallback(generation.token, callback);
      });
      generation.productiveStarted = true;
      this.#reportStartOutcome(generation, null);
      this.#releaseIdleLease(generation);
      this.#scheduleNativeSessionWatchdog(generation, durationMs);
      this.#clearPrepareRetry(true);
      this.#recordStage('NATIVE_MINING_START', generation);
      this.#reportProductiveOutcome(generation);
    } catch (error) {
      this.#releaseIdleLease(generation);
      if (generation.prepareAbortController.signal.aborted) {
        this.#reportStartOutcome(generation, null);
        if (!generation.terminalOutcome) {
          this.#terminalize(generation, 'CANCELLED', null);
        }
        await generation.completion.promise;
        return startResult('CANCELLED', generation);
      }
      generation.releaseNativeAfterTerminal = true;
      const startFailure = safeFailure(error, 'PREPARE', 'MINER_START_FAILED');
      this.#reportStartOutcome(generation, startFailure);
      this.#terminalize(
        generation,
        'NATIVE_ERROR',
        startFailure,
      );
      return startResult('FAILED', generation);
    }

    if (this.#state === 'MINING' && this.#owns(generation)) {
      if (this.#options.firstTapDelayMs === 0) void this.#queueNextTap(generation);
      else generation.tapTimer = this.#timer.setTimeout(() => {
        generation.tapTimer = null;
        void this.#queueNextTap(generation);
      }, this.#options.firstTapDelayMs);
    }
    return generation.terminalOutcome === 'CANCELLED'
      ? startResult('CANCELLED', generation)
      : startResult('STARTED', generation);
  }

  #admissionCurrent(miniEpoch: string): boolean {
    const current = this.dependencies.epochSource.snapshot();
    return current.miniEpoch === miniEpoch && (this.#options.minimumStartWindowMs === 0 ||
      (current.remainingMs !== null && Number.isFinite(current.remainingMs) &&
       current.remainingMs >= this.#options.minimumStartWindowMs));
  }

  async #readBaselineBestEffort(generation: GenerationOwnership): Promise<void> {
    const miner = generation.nativeMiner;
    if (!miner?.getMinerData) return;
    let data: Awaited<ReturnType<NonNullable<NativeMinerHandle['getMinerData']>>> | null =
      null;
    try {
      data = await miner.getMinerData();
      if (this.#owns(generation) && !generation.terminalOutcome) {
        generation.baselineTapSum = data.tapSum;
        this.#recordStage('BASELINE_TAP_SUM_READ', generation);
        this.#notify();
      }
    } catch {
      // Baseline is diagnostic evidence and cannot control the lifecycle.
    } finally {
      try {
        data?.free();
      } catch {
        // A diagnostic view cannot control native Miner ownership.
      }
    }
  }

  async #readLatestTapSumBestEffort(
    generation: GenerationOwnership,
  ): Promise<void> {
    const miner = generation.nativeMiner;
    if (!miner?.getMinerData) {
      this.#recordStage('LATEST_TAP_SUM_READ', generation);
      return;
    }
    let data: Awaited<ReturnType<NonNullable<NativeMinerHandle['getMinerData']>>> | null =
      null;
    try {
      data = await miner.getMinerData();
      if (this.#owns(generation)) {
        generation.latestTapSum = data.tapSum;
        generation.confirmedTapDelta =
          generation.baselineTapSum !== null &&
          data.tapSum >= generation.baselineTapSum
            ? data.tapSum - generation.baselineTapSum
            : null;
      }
    } catch {
      // Latest cumulative tap evidence cannot control terminal ownership.
    } finally {
      try {
        data?.free();
      } catch {
        // Diagnostic MinerData cleanup cannot control native Miner ownership.
      }
      this.#recordStage('LATEST_TAP_SUM_READ', generation);
      this.#notify();
    }
  }

  async #queueNextTap(
    generation: GenerationOwnership,
    workerLifecycleRetryAvailable = true,
  ): Promise<void> {
    if (
      !this.#owns(generation) ||
      this.#state !== 'MINING' ||
      generation.queuedLocalTaps >= this.#options.targetTaps
    ) {
      return;
    }
    const miner = generation.nativeMiner;
    if (!miner) return;
    const coordinates = this.#random.tapCoordinates(generation.queuedLocalTaps);

    try {
      await miner.addTap(coordinates.x, coordinates.y);
    } catch (error) {
      if (!this.#owns(generation) || generation.terminalOutcome) return;
      const tapFailure = safeFailure(
        error,
        'TAP_EXECUTION',
        'ADD_TAP_FAILED',
      );
      this.#record(
        'LIFECYCLE',
        generation,
        undefined,
        false,
        null,
        tapFailure,
      );
      if (
        workerLifecycleRetryAvailable &&
        isWorkerLifecycleFailure(tapFailure)
      ) {
        generation.tapTimer = this.#timer.setTimeout(() => {
          generation.tapTimer = null;
          if (!this.#owns(generation) || this.#state !== 'MINING') return;
          void this.#queueNextTap(generation, false);
        }, WORKER_LIFECYCLE_TAP_RETRY_MS);
        return;
      }
      generation.pendingFailure = tapFailure;
      generation.releaseNativeAfterTerminal = true;
      this.#clearTapScheduling(generation);
      this.#issueNativeStop(generation);
      return;
    }

    if (!this.#owns(generation) || generation.terminalOutcome) return;
    generation.queuedLocalTaps += 1;
    this.#record('TAP_QUEUED', generation);
    if (generation.queuedLocalTaps === 1) {
      this.#recordStage('FIRST_TAP', generation);
    }
    if (generation.queuedLocalTaps === 70) {
      this.#recordStage('TAP_70', generation);
    }
    this.#notify();

    if (generation.queuedLocalTaps >= this.#options.targetTaps) {
      this.#clearTapScheduling(generation);
      return;
    }

    this.#scheduleNextTap(generation);
  }

  #scheduleNextTap(generation: GenerationOwnership): void {
    if (
      !this.#owns(generation) ||
      this.#state !== 'MINING' ||
      generation.tapTimer !== null ||
      generation.queuedLocalTaps >= this.#options.targetTaps
    ) {
      return;
    }
    const jitter = clampInteger(
      this.#random.tapJitterMs(this.#options.tapJitterRangeMs),
      -this.#options.tapJitterRangeMs,
      this.#options.tapJitterRangeMs,
    );
    const delayMs = Math.max(0, this.#options.tapIntervalMs + jitter);
    generation.tapTimer = this.#timer.setTimeout(() => {
      generation.tapTimer = null;
      void this.#queueNextTap(generation);
    }, delayMs);
  }

  #issueNativeStop(generation: GenerationOwnership): void {
    if (
      !this.#owns(generation) ||
      generation.stopIssued ||
      generation.terminalOutcome ||
      !generation.nativeMiner
    ) {
      return;
    }
    generation.stopIssued = true;
    this.#clearTapScheduling(generation);
    this.#clearTimer(generation, 'nativeSessionWatchdogTimer');
    if (this.#state === 'MINING') {
      this.#transition('STOP_REQUESTED');
    }
    this.#dispatchNativeStop(generation);
  }

  #dispatchNativeStop(generation: GenerationOwnership): void {
    if (
      !this.#owns(generation) ||
      generation.terminalOutcome ||
      !generation.nativeMiner
    ) {
      return;
    }
    this.#startSettlementTimeout(generation);
    this.#recordStage('MINER_STOP_START', generation);
    try {
      const stopResult = generation.nativeMiner.stop();
      if (isPromiseLike(stopResult)) {
        void stopResult.then(
          () => {
            if (this.#owns(generation)) {
              this.#recordStage('MINER_STOP_RETURN', generation);
            }
          },
          (error: unknown) => this.#handleNativeStopFailure(generation, error),
        );
      } else {
        this.#recordStage('MINER_STOP_RETURN', generation);
      }
    } catch (error) {
      this.#handleNativeStopFailure(generation, error);
    }
  }

  #handleNativeStopFailure(
    generation: GenerationOwnership,
    error: unknown,
  ): void {
    if (!this.#owns(generation) || generation.terminalOutcome) return;
    const stopFailure = safeFailure(
      error,
      'NATIVE_COMPUTATION',
      'MINER_STOP_FAILED',
    );
    this.#recordStage(
      'MINER_STOP_RETURN',
      generation,
      undefined,
      stopFailure,
    );
    generation.releaseNativeAfterTerminal = true;
    this.#terminalize(generation, 'NATIVE_ERROR', stopFailure);
  }

  #handleNativeCallback(
    generationToken: string,
    callback: Readonly<SafeNativeCallback>,
  ): void {
    const generation = this.#generation;
    if (!generation || generation.token !== generationToken) {
      this.#recordExternalCallback('STALE_CALLBACK', callback, generationToken);
      return;
    }
    if (generation.callbackSequences.has(callback.sequence)) {
      this.#record('DUPLICATE_CALLBACK', generation, callback);
      return;
    }
    generation.callbackSequences.add(callback.sequence);
    this.#lastCallbackAction = callback.action;
    this.#lastCallbackSequence = callback.sequence;
    this.#record('CALLBACK', generation, callback);
    this.#notify();
    if (generation.terminalOutcome) return;

    const action = callback.action.trim().toLowerCase();
    const status = callback.status?.trim().toLowerCase() ?? '';

    if (action === 'session_accepted') {
      generation.pendingFailure = null;
      this.#terminalize(generation, 'ACCEPTED', null);
      return;
    }
    if (action === 'session_rejected') {
      this.#terminalize(
        generation,
        'REJECTED',
        callbackFailure(callback, 'WAITING_RESULT', 'SESSION_REJECTED'),
      );
      return;
    }
    if (action === 'tap_computed') {
      if (
        (this.#state === 'MINING' || this.#state === 'STOP_REQUESTED') &&
        generation.nativeComputedTaps < generation.queuedLocalTaps
      ) {
        generation.nativeComputedTaps += 1;
        this.#notify();
      }
      return;
    }
    if (action === 'computation_completed') {
      this.#clearTapScheduling(generation);
      this.#clearTimer(generation, 'nativeSessionWatchdogTimer');
      this.#enterSubmissionGuard(generation);
      const count = safeTapCount(callback.computationCompletedTaps);
      generation.computationCompletedTaps = count;
      generation.partialNativeSession =
        count === null || count < this.#options.targetTaps;
      if (
        this.#state === 'MINING' ||
        this.#state === 'STOP_REQUESTED'
      ) {
        this.#transition('SUBMITTING_ROOT');
      }
      this.#startSettlementTimeout(generation);
      this.#notify();
      return;
    }
    if (action === 'submit_session_root') {
      this.#enterSubmissionGuard(generation, true);
      if (
        this.#state === 'MINING' ||
        this.#state === 'STOP_REQUESTED'
      ) {
        this.#transition('SUBMITTING_ROOT', true);
      }
      if (callback.errorPresent) {
        generation.pendingFailure = callbackFailure(
          callback,
          'ROOT_SUBMIT',
          'ROOT_SUBMIT_FAILED',
        );
        this.#observeQueueFailure(generation, generation.pendingFailure);
        this.#transition('WAITING_RESULT', true);
      } else if (this.#state === 'SUBMITTING_ROOT') {
        this.#transition('WAITING_INTERVAL');
      }
      return;
    }
    if (action === 'submit_session_proof') {
      this.#enterSubmissionGuard(generation, true);
      if (this.#state === 'WAITING_INTERVAL') {
        this.#transition('SUBMITTING_PROOF', true);
      }
      if (callback.errorPresent) {
        generation.pendingFailure = callbackFailure(
          callback,
          'PROOF_SUBMIT',
          'PROOF_SUBMIT_FAILED',
        );
        this.#observeQueueFailure(generation, generation.pendingFailure);
        this.#transition('WAITING_RESULT', true);
      } else {
        if (this.#state === 'SUBMITTING_PROOF') {
          this.#transition('WAITING_RESULT');
        } else {
          this.#notify();
        }
      }
      return;
    }

    if (status === 'submitting') {
      this.#enterSubmissionGuard(generation, true);
      if (
        this.#state === 'MINING' ||
        this.#state === 'STOP_REQUESTED'
      ) {
        this.#transition('SUBMITTING_ROOT', true);
        this.#startSettlementTimeout(generation);
      }
      return;
    }

    if (
      action === 'finished' ||
      action === 'removed' ||
      status === 'finished' ||
      status === 'removed'
    ) {
      this.#clearTapScheduling(generation);
      if (
        generation.stopIssued &&
        generation.queuedLocalTaps === 0 &&
        generation.computationCompletedTaps === null &&
        !generation.pendingFailure
      ) {
        this.#terminalize(generation, 'CANCELLED', null);
      } else {
        this.#startTerminalCallbackGrace(generation);
      }
      return;
    }

    if (
      callback.errorPresent ||
      action === 'native_error' ||
      status === 'error' ||
      status === 'failed'
    ) {
      this.#terminalize(
        generation,
        'NATIVE_ERROR',
        callbackFailure(
          callback,
          callback.failureStage ?? 'WAITING_RESULT',
          'NATIVE_CALLBACK_ERROR',
        ),
      );
    }
  }

  #terminalize(
    generation: GenerationOwnership,
    requestedOutcome: WalletMiningTerminalOutcome,
    terminalFailure: Readonly<SafeMiningFailure> | null,
  ): void {
    if (!this.#owns(generation) || generation.terminalOutcome) return;
    let outcome = requestedOutcome;
    let resolvedFailure = terminalFailure;
    if (
      generation.pendingFailure &&
      (requestedOutcome === 'AMBIGUOUS' || requestedOutcome === 'TIMEOUT')
    ) {
      resolvedFailure = generation.pendingFailure;
    }
    if (
      generation.partialNativeSession &&
      requestedOutcome === 'AMBIGUOUS' &&
      !resolvedFailure
    ) {
      outcome = 'PARTIAL_NATIVE_SESSION';
      resolvedFailure = failure(
        'NATIVE_COMPUTATION',
        'PARTIAL_NATIVE_SESSION',
      );
    }
    generation.terminalOutcome = outcome;
    generation.terminalFailure = resolvedFailure;
    this.#observeQueueFailure(generation, resolvedFailure);
    this.#reportProductiveOutcome(generation);
    generation.prepareAbortController.abort();
    generation.postSubmissionPermit =
      this.#submissionGuard.transitionToPostSubmission(
        this.walletId,
        generation.token,
      );
    generation.releaseSubmissionGuard = null;
    this.#clearTapScheduling(generation);
    this.#clearTimer(generation, 'nativeSessionWatchdogTimer');
    this.#clearTimer(generation, 'terminalGraceTimer');
    this.#clearTimer(generation, 'settlementTimer');
    this.#transition('TERMINAL');
    this.#record('TERMINAL_OUTCOME', generation);
    if (!generation.completionStarted) {
      generation.completionStarted = true;
      void this.#completeTerminalGeneration(generation);
    }
  }

  async #completeTerminalGeneration(
    generation: GenerationOwnership,
  ): Promise<void> {
    // Let the Bee callback return before reward/disposal touches the WASM object.
    await Promise.resolve();
    await generation.allocationSettled.promise;
    const releasePostSubmission = await (
      generation.postSubmissionPermit ?? Promise.resolve(() => undefined)
    );
    try {
      if (!this.#owns(generation)) {
        generation.completion.resolve(undefined);
        return;
      }

      await this.#readLatestTapSumBestEffort(generation);

      if (generation.terminalOutcome === 'ACCEPTED' && generation.nativeMiner) {
        await this.#requestReward(generation);
      } else {
        this.#rewardStatus = 'SKIPPED';
      }

      if (this.#state === 'TERMINAL' || this.#state === 'REWARDING') {
        this.#transition('DISPOSING');
      }
      if (!this.#automaticContinuationEnabled) {
        this.#desiredMining = false;
        this.#identity = null;
      }

      const disposed = await this.#disposeNativeMiner(generation);
      if (!disposed) {
        generation.completion.resolve(undefined);
        return;
      }

      if (generation.disposeRequested || this.#disposedRequested) {
        this.#transition('DISPOSED');
      } else if (generation.backoffAfterDisposal && this.#desiredMining) {
        this.#transition('BACKOFF');
        const currentEpoch =
          this.#pendingMiniEpoch ??
          this.dependencies.epochSource.snapshot().miniEpoch;
        if (
          currentEpoch &&
          currentEpoch !== generation.miniEpoch &&
          this.#identity
        ) {
          this.#scheduleAutomaticEpochStart(currentEpoch);
        } else {
          this.#scheduleRecoverablePrepareRetry(generation);
        }
      } else if (this.#desiredMining) {
        this.#transition('WAITING_EPOCH');
        const currentEpoch =
          this.#pendingMiniEpoch ??
          this.dependencies.epochSource.snapshot().miniEpoch;
        if (
          currentEpoch &&
          currentEpoch !== generation.miniEpoch &&
          this.#identity
        ) {
          this.#scheduleAutomaticEpochStart(currentEpoch);
        }
      } else {
        this.#transition('IDLE');
      }
      generation.completion.resolve(undefined);
    } finally {
      releasePostSubmission();
    }
  }

  async #requestReward(generation: GenerationOwnership): Promise<void> {
    if (generation.rewardIssued || !generation.nativeMiner) return;
    generation.rewardIssued = true;
    this.#rewardStatus = 'PENDING';
    this.#transition('REWARDING');
    this.#recordStage('REWARD_START', generation);
    try {
      await this.#rewardLimiter.waitForDispatch(this.walletId, generation.token);
      if (!this.#owns(generation) || generation.terminalOutcome !== 'ACCEPTED') {
        this.#rewardStatus = 'SKIPPED';
        return;
      }
      const result = await this.#boundedOperation(
        generation.nativeMiner.getReward(),
        this.#options.rewardTimeoutMs,
      );
      this.#rewardStatus = result;
    } catch {
      this.#rewardStatus = 'FAILED';
    }
    this.#recordStage('REWARD_RESULT', generation);
    this.#record('REWARD_RESULT', generation);
    this.#notify();
  }

  async #disposeNativeMiner(
    generation: GenerationOwnership,
  ): Promise<boolean> {
    if (generation.freeIssued) {
      return this.#disposalStatus === 'SUCCEEDED';
    }
    generation.freeIssued = true;
    this.#disposalStatus = 'PENDING';
    this.#recordStage('NATIVE_FREE_START', generation);
    this.#notify();
    try {
      if (generation.nativeMiner) {
        await generation.nativeMiner.free();
      }
      generation.nativeMiner = null;
      this.#disposalStatus = 'SUCCEEDED';
      this.#recordStage('NATIVE_FREE_RESULT', generation);
      this.#record('DISPOSAL_RESULT', generation);
      this.#notify();
      return true;
    } catch {
      this.#disposalStatus = 'FAILED';
      this.#quarantined = true;
      generation.terminalFailure =
        generation.terminalFailure ?? failure('DISPOSAL', 'DISPOSAL_FAILED');
      this.#recordStage(
        'NATIVE_FREE_RESULT',
        generation,
        undefined,
        generation.terminalFailure,
      );
      this.#record('DISPOSAL_RESULT', generation);
      this.#notify();
      return false;
    }
  }

  #handleMiniEpochChange(): void {
    if (this.#state === 'DISPOSED' || this.#disposedRequested) return;
    const epochSnapshot = this.dependencies.epochSource.snapshot();
    const miniEpoch = epochSnapshot.miniEpoch;
    if (!miniEpoch) return;
    const generation = this.#generation;
    if (generation?.miniEpoch === miniEpoch) {
      return;
    }
    this.#pendingMiniEpoch = miniEpoch;

    if (!this.#desiredMining) return;
    if (
      generation &&
      (this.#state === 'PREPARING' || this.#state === 'READY')
    ) {
      this.#terminalize(generation, 'CANCELLED', null);
      return;
    }
    if (generation && this.#state === 'MINING') {
      generation.partialNativeSession =
        generation.queuedLocalTaps < this.#options.targetTaps;
      this.#issueNativeStop(generation);
      return;
    }
    if (
      (this.#state === 'WAITING_EPOCH' || this.#state === 'BACKOFF') &&
      this.#identity
    ) {
      this.#scheduleAutomaticEpochStart(miniEpoch);
    }
  }

  #scheduleAutomaticEpochStart(miniEpoch: string): void {
    if (
      this.#epochStartTimer !== null &&
      this.#epochStartMiniEpoch === miniEpoch
    ) {
      return;
    }

    this.#clearAutomaticEpochStart();
    this.#clearPrepareRetry(false);
    if (
      this.#disposedRequested ||
      !this.#desiredMining ||
      !this.#identity ||
      (this.#state !== 'WAITING_EPOCH' && this.#state !== 'BACKOFF')
    ) {
      return;
    }

    const identity = this.#identity;
    this.#epochStartMiniEpoch = miniEpoch;
    const startOrderDelayMs = rotatedFleetStartSlotIndex(
      this.#options.fleetStartSlotIndex,
      this.#options.fleetStartSlotCount,
      miniEpoch,
    ) * EPOCH_START_ORDER_STEP_MS;
    this.#epochStartTimer = this.#timer.setTimeout(() => {
      this.#epochStartTimer = null;
      this.#epochStartMiniEpoch = null;
      if (
        this.#disposedRequested ||
        !this.#desiredMining ||
        this.#identity !== identity ||
        (this.#state !== 'WAITING_EPOCH' && this.#state !== 'BACKOFF')
      ) {
        return;
      }

      const currentEpoch = this.dependencies.epochSource.snapshot().miniEpoch;
      if (!currentEpoch) return;
      if (currentEpoch !== miniEpoch) {
        this.#scheduleAutomaticEpochStart(currentEpoch);
        return;
      }
      void this.#beginGeneration(identity, miniEpoch);
    }, this.#options.epochStartDelayMs + startOrderDelayMs);
  }

  #clearAutomaticEpochStart(): void {
    if (this.#epochStartTimer !== null) {
      this.#timer.clearTimeout(this.#epochStartTimer);
      this.#epochStartTimer = null;
    }
    this.#epochStartMiniEpoch = null;
  }

  #scheduleRecoverablePrepareRetry(generation: GenerationOwnership): void {
    const retryKind = isQueueFailure(generation.terminalFailure)
      ? 'QUEUE'
      : 'ORDINARY';
    if (this.#prepareRetryKind !== retryKind) {
      this.#prepareRetryKind = retryKind;
      this.#prepareRetryCount = 0;
    }
    const retryDelays = retryKind === 'QUEUE'
      ? QUEUE_PREPARE_RETRY_DELAYS_MS
      : PREPARE_RETRY_DELAYS_MS;
    if (
      !this.#owns(generation) ||
      this.#state !== 'BACKOFF' ||
      !this.#desiredMining ||
      !this.#identity ||
      !isRecoverablePrepareFailure(generation.terminalFailure) ||
      this.#prepareRetryCount >= retryDelays.length
    ) {
      return;
    }

    const delayMs = retryDelays[this.#prepareRetryCount];
    this.#prepareRetryCount += 1;
    this.#prepareRetryMiniEpoch = generation.miniEpoch;
    const identity = this.#identity;

    this.#clearPrepareRetry(false);
    this.#prepareRetryTimer = this.#timer.setTimeout(() => {
      this.#prepareRetryTimer = null;
      if (
        !this.#owns(generation) ||
        this.#state !== 'BACKOFF' ||
        !this.#desiredMining ||
        this.#identity !== identity ||
        this.#disposedRequested
      ) {
        return;
      }

      const miniEpoch =
        this.#pendingMiniEpoch ??
        this.dependencies.epochSource.snapshot().miniEpoch ??
        generation.miniEpoch;
      void this.#beginGeneration(identity, miniEpoch);
    }, delayMs);
  }

  #clearPrepareRetry(reset: boolean): void {
    if (this.#prepareRetryTimer !== null) {
      this.#timer.clearTimeout(this.#prepareRetryTimer);
      this.#prepareRetryTimer = null;
    }
    if (reset) {
      this.#prepareRetryCount = 0;
      this.#prepareRetryMiniEpoch = null;
      this.#prepareRetryKind = null;
    }
  }

  #startSettlementTimeout(generation: GenerationOwnership): void {
    if (generation.settlementTimer !== null || generation.terminalOutcome) return;
    generation.settlementTimer = this.#timer.setTimeout(() => {
      generation.settlementTimer = null;
      generation.backoffAfterDisposal = true;
      generation.releaseNativeAfterTerminal = true;
      this.#terminalize(
        generation,
        'TIMEOUT',
        failure('WAITING_RESULT', 'SETTLEMENT_TIMEOUT'),
      );
    }, this.#options.settlementTimeoutMs);
  }

  #enterSubmissionGuard(
    generation: GenerationOwnership,
    renew = false,
  ): void {
    if (
      !this.#owns(generation) ||
      generation.terminalOutcome ||
      (generation.releaseSubmissionGuard && !renew)
    ) return;
    generation.releaseSubmissionGuard = this.#submissionGuard.enter(
      this.walletId,
      generation.token,
    );
  }

  #releaseIdleLease(generation: GenerationOwnership): void {
    generation.releaseIdleLease?.();
    generation.releaseIdleLease = null;
  }

  #reportPrepareOutcome(
    generation: GenerationOwnership,
    failure: Readonly<SafeMiningFailure> | null,
  ): void {
    if (!generation.prepareDispatchOwned) return;
    generation.prepareDispatchOwned = false;
    this.#prepareLimiter.reportOutcome(
      this.walletId,
      generation.token,
      failure,
    );
  }

  #reportStartOutcome(
    generation: GenerationOwnership,
    failure: Readonly<SafeMiningFailure> | null,
  ): void {
    if (!generation.startDispatchOwned) return;
    generation.startDispatchOwned = false;
    this.#startLimiter.reportOutcome(
      this.walletId,
      generation.token,
      failure,
    );
  }

  #observeQueueFailure(
    generation: GenerationOwnership,
    observedFailure: Readonly<SafeMiningFailure> | null,
  ): void {
    if (!observedFailure || !isQueueFailure(observedFailure)) return;
    if (generation.queueFailureObserved) return;
    generation.queueFailureObserved = observedFailure;
    this.#queuePressure.observeQueueFailure(
      this.walletId,
      generation.miniEpoch,
      generation.token,
      observedFailure,
    );
  }

  #reportProductiveOutcome(generation: GenerationOwnership): void {
    if (
      !generation.productiveStarted ||
      generation.pressureOutcomeReported ||
      !generation.terminalOutcome
    ) {
      return;
    }
    generation.pressureOutcomeReported = true;
    const terminalFailure =
      generation.queueFailureObserved ??
      generation.terminalFailure ??
      (generation.terminalOutcome === 'ACCEPTED'
        ? null
        : failure('WAITING_RESULT', `TERMINAL_${generation.terminalOutcome}`));
    this.#queuePressure.reportProductiveOutcome(
      this.walletId,
      generation.miniEpoch,
      terminalFailure,
    );
  }

  #scheduleNativeSessionWatchdog(
    generation: GenerationOwnership,
    durationMs: number,
  ): void {
    if (!this.#owns(generation) || generation.terminalOutcome) return;
    this.#clearTimer(generation, 'nativeSessionWatchdogTimer');
    generation.nativeSessionWatchdogTimer = this.#timer.setTimeout(() => {
      generation.nativeSessionWatchdogTimer = null;
      if (
        !this.#owns(generation) ||
        this.#state !== 'MINING' ||
        generation.terminalOutcome
      ) return;
      generation.releaseNativeAfterTerminal = true;
      this.#issueNativeStop(generation);
    }, durationMs + this.#options.terminalCallbackGraceMs);
  }

  #startTerminalCallbackGrace(generation: GenerationOwnership): void {
    if (generation.terminalGraceTimer !== null || generation.terminalOutcome) {
      return;
    }
    this.#clearTimer(generation, 'nativeSessionWatchdogTimer');
    if (this.#state !== 'WAITING_RESULT') {
      this.#transition('WAITING_RESULT', true);
    }
    this.#startSettlementTimeout(generation);
    generation.terminalGraceTimer = this.#timer.setTimeout(() => {
      generation.terminalGraceTimer = null;
      if (!this.#owns(generation) || generation.terminalOutcome) return;
      if (generation.pendingFailure) {
        this.#terminalize(
          generation,
          'AMBIGUOUS',
          generation.pendingFailure,
        );
      } else if (generation.partialNativeSession) {
        this.#terminalize(
          generation,
          'PARTIAL_NATIVE_SESSION',
          failure('NATIVE_COMPUTATION', 'PARTIAL_NATIVE_SESSION'),
        );
      } else {
        this.#terminalize(
          generation,
          'AMBIGUOUS',
          failure('WAITING_RESULT', 'TERMINAL_WITHOUT_PROTOCOL_OUTCOME'),
        );
      }
    }, this.#options.terminalCallbackGraceMs);
  }

  async #boundedOperation(
    operation: Promise<void>,
    timeoutMs: number,
  ): Promise<'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = this.#timer.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve('TIMED_OUT');
      }, timeoutMs);
      operation.then(
        () => {
          if (settled) return;
          settled = true;
          this.#timer.clearTimeout(timer);
          resolve('SUCCEEDED');
        },
        () => {
          if (settled) return;
          settled = true;
          this.#timer.clearTimeout(timer);
          resolve('FAILED');
        },
      );
    });
  }

  #clearTapScheduling(generation: GenerationOwnership): void {
    this.#clearTimer(generation, 'tapTimer');
  }

  #clearTimer(
    generation: GenerationOwnership,
    name:
      | 'tapTimer'
      | 'nativeSessionWatchdogTimer'
      | 'terminalGraceTimer'
      | 'settlementTimer',
  ): void {
    const handle = generation[name];
    if (handle === null) return;
    this.#timer.clearTimeout(handle);
    generation[name] = null;
  }

  #transition(
    next: WalletMiningWorkerState,
    observationDerived = false,
  ): void {
    if (this.#state === next) return;
    if (!LEGAL_TRANSITIONS[this.#state].has(next)) {
      throw new Error(`Illegal wallet mining transition ${this.#state} -> ${next}.`);
    }
    this.#state = next;
    this.#lastTransitionObservationDerived = observationDerived;
    this.#record('STATE_TRANSITION', this.#generation, undefined, observationDerived);
    this.#notify();
  }

  #owns(generation: GenerationOwnership): boolean {
    return this.#generation === generation;
  }

  #notify(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Presentation cannot control wallet lifecycle ownership.
      }
    }
  }

  #record(
    kind: WalletMiningDiagnosticEvent['kind'],
    generation: GenerationOwnership | null,
    callback?: Readonly<SafeNativeCallback>,
    observationDerived = false,
    stage: NonNullable<WalletMiningDiagnosticEvent['stage']> | null = null,
    failureOverride: Readonly<SafeMiningFailure> | null = null,
  ): void {
    const event = diagnosticEvent(
      this.#timer.nowMs(),
      kind,
      this.walletId,
      this.#state,
      generation,
      callback,
      observationDerived,
      stage,
      failureOverride,
      this.#rewardStatus,
      this.#disposalStatus,
      this.#quarantined,
    );
    try {
      this.#diagnostics.record(event);
    } catch {
      // Diagnostics cannot control state transitions.
    }
  }

  #recordStage(
    stage: NonNullable<WalletMiningDiagnosticEvent['stage']>,
    generation: GenerationOwnership | null,
    callback?: Readonly<SafeNativeCallback>,
    failureOverride: Readonly<SafeMiningFailure> | null = null,
  ): void {
    this.#record(
      'LIFECYCLE',
      generation,
      callback,
      false,
      stage,
      failureOverride,
    );
  }

  #recordExternalCallback(
    kind: 'STALE_CALLBACK',
    callback: Readonly<SafeNativeCallback>,
    generationToken: string,
  ): void {
    const event: WalletMiningDiagnosticEvent = Object.freeze({
      occurredAtMs: this.#timer.nowMs(),
      kind,
      walletId: this.walletId,
      sessionId: null,
      generationToken,
      miniEpoch: null,
      workerState: this.#state,
      queuedLocalTaps: 0,
      nativeComputedTaps: 0,
      computationCompletedTaps: null,
      stage: telemetryStageForCallback(callback),
      baselineTapSum: null,
      latestTapSum: null,
      confirmedTapDelta: null,
      submissionStaggerMs: null,
      callbackAction: callback.action,
      callbackSequence: callback.sequence,
      errorPresent: callback.errorPresent ?? null,
      nativeTopLevelMessage: callback.nativeTopLevelMessage ?? null,
      tvmCode: callback.tvmCode ?? null,
      tvmCodeName: callback.tvmCodeName ?? null,
      kitModule: callback.kitModule ?? null,
      kitCode: callback.kitCode ?? null,
      serverCode: callback.serverCode ?? null,
      nodeExtensionCode: callback.nodeExtensionCode ?? null,
      nodeExtensionMessage: callback.nodeExtensionMessage ?? null,
      tvmExitCode: callback.tvmExitCode ?? callback.exitCode ?? null,
      transactionAborted:
        callback.transactionAborted ?? callback.aborted ?? null,
      messageHash: callback.messageHash ?? null,
      transactionHash: callback.transactionHash ?? null,
      accountId: callback.accountId ?? null,
      dappId: callback.dappId ?? null,
      threadId: callback.threadId ?? null,
      producerFingerprint: callback.producerFingerprint ?? null,
      coreVersion: callback.coreVersion ?? null,
      failureStage: callback.errorPresent
        ? callbackFailureStage(callback)
        : null,
      errorCategory: callback.errorCategory ?? null,
      terminalOutcome: null,
      rewardStatus: this.#rewardStatus,
      disposalStatus: this.#disposalStatus,
      quarantined: this.#quarantined,
      failure: null,
      stale: true,
      observationDerived: false,
    });
    try {
      this.#diagnostics.record(event);
    } catch {
      // Diagnostics cannot control stale callback rejection.
    }
  }
}

function createGeneration(
  token: string,
  sessionId: string,
  miniEpoch: string,
): GenerationOwnership {
  return {
    token,
    sessionId,
    miniEpoch,
    allocationSettled: deferred<void>(),
    completion: deferred<void>(),
    callbackSequences: new Set(),
    prepareAbortController: new AbortController(),
    nativeMiner: null,
    queuedLocalTaps: 0,
    nativeComputedTaps: 0,
    computationCompletedTaps: null,
    baselineTapSum: null,
    latestTapSum: null,
    confirmedTapDelta: null,
    terminalOutcome: null,
    terminalFailure: null,
    pendingFailure: null,
    partialNativeSession: false,
    productiveStarted: false,
    pressureOutcomeReported: false,
    queueFailureObserved: null,
    stopIssued: false,
    freeIssued: false,
    rewardIssued: false,
    completionStarted: false,
    disposeRequested: false,
    backoffAfterDisposal: false,
    releaseNativeAfterTerminal: false,
    prepareDispatchOwned: false,
    startDispatchOwned: false,
    releaseIdleLease: null,
    releaseSubmissionGuard: null,
    postSubmissionPermit: null,
    tapTimer: null,
    nativeSessionWatchdogTimer: null,
    terminalGraceTimer: null,
    settlementTimer: null,
  };
}

function deferred<T>(): Deferred<T> {
  let completed = false;
  let resolver!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (completed) return;
      completed = true;
      resolver(value);
    },
  };
}

function freezeIdentity(
  input: Readonly<ValidatedMiningIdentity>,
): Readonly<ValidatedMiningIdentity> {
  return Object.freeze({
    walletId: input.walletId,
    endpoints: Object.freeze([...input.endpoints]),
    appId: input.appId,
    minerAddress: input.minerAddress,
    publicKey: input.publicKey,
    secretKey: input.secretKey,
  });
}

function startResult(
  status: WalletMiningStartResult['status'],
  generation: GenerationOwnership | null,
): Readonly<WalletMiningStartResult> {
  return Object.freeze({
    status,
    sessionId: generation?.sessionId ?? null,
    generationToken: generation?.token ?? null,
  });
}

function stopResult(
  status: WalletMiningStopResult['status'],
  generation: GenerationOwnership | null,
): Readonly<WalletMiningStopResult> {
  return Object.freeze({
    status,
    terminalOutcome: generation?.terminalOutcome ?? null,
  });
}

function safeTapCount(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : null;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return Boolean(value) && typeof (value as Promise<void>).then === 'function';
}

function failure(
  failureStage: SafeMiningFailure['failureStage'],
  errorCategory: string,
): Readonly<SafeMiningFailure> {
  return Object.freeze({ failureStage, errorCategory });
}

function safeFailure(
  error: unknown,
  stage: NonNullable<SafeMiningFailure['failureStage']>,
  fallbackCategory: string,
): Readonly<SafeMiningFailure> {
  if (error instanceof MiningNativeAdapterError) {
    return Object.freeze({
      ...error.safeFailure,
      failureStage: error.safeFailure.failureStage ?? stage,
    });
  }
  return failure(stage, fallbackCategory);
}

function isWorkerLifecycleFailure(
  failure: Readonly<SafeMiningFailure>,
): boolean {
  const detail = [
    failure.nativeTopLevelMessage,
    failure.nodeExtensionCode,
    failure.nodeExtensionMessage,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /(already running worker|mining worker is not running|no running workers)/i.test(
    detail,
  );
}

function isRecoverablePrepareFailure(
  failure: Readonly<SafeMiningFailure> | null,
): boolean {
  if (!failure || failure.failureStage !== 'PREPARE') return false;
  if (failure.errorCategory === 'NETWORK') return true;
  if (failure.errorCategory === 'MINER_NOT_READY') return true;
  if (String(failure.serverCode ?? '') === '621') return true;
  const detail = [
    failure.errorCategory,
    failure.nativeTopLevelMessage,
    failure.nodeExtensionCode,
    failure.nodeExtensionMessage,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /(queue_overflow|message queue is full|\bqueue\b)/i.test(detail);
}

function callbackFailure(
  callback: Readonly<SafeNativeCallback>,
  stage: NonNullable<SafeMiningFailure['failureStage']>,
  fallbackCategory: string,
): Readonly<SafeMiningFailure> {
  return Object.freeze({
    failureStage: stage,
    errorCategory: callback.errorCategory ?? fallbackCategory,
    nativeTopLevelMessage: callback.nativeTopLevelMessage ?? null,
    tvmCode: callback.tvmCode ?? null,
    tvmCodeName: callback.tvmCodeName ?? null,
    kitModule: callback.kitModule ?? null,
    kitCode: callback.kitCode ?? null,
    serverCode: callback.serverCode ?? null,
    nodeExtensionCode: callback.nodeExtensionCode ?? null,
    nodeExtensionMessage: callback.nodeExtensionMessage ?? null,
    tvmExitCode: callback.tvmExitCode ?? callback.exitCode ?? null,
    transactionAborted:
      callback.transactionAborted ?? callback.aborted ?? null,
    exitCode: callback.exitCode ?? callback.tvmExitCode ?? null,
    aborted: callback.aborted ?? callback.transactionAborted ?? null,
    messageHash: callback.messageHash ?? null,
    transactionHash: callback.transactionHash ?? null,
    accountId: callback.accountId ?? null,
    dappId: callback.dappId ?? null,
    threadId: callback.threadId ?? null,
    producerFingerprint: callback.producerFingerprint ?? null,
    coreVersion: callback.coreVersion ?? null,
  });
}

function diagnosticEvent(
  occurredAtMs: number,
  kind: WalletMiningDiagnosticEvent['kind'],
  walletId: string,
  workerState: WalletMiningWorkerState,
  generation: GenerationOwnership | null,
  callback?: Readonly<SafeNativeCallback>,
  observationDerived = false,
  explicitStage: NonNullable<WalletMiningDiagnosticEvent['stage']> | null = null,
  failureOverride: Readonly<SafeMiningFailure> | null = null,
  rewardStatus: WalletMiningRewardStatus = 'NOT_REQUESTED',
  disposalStatus: WalletMiningDisposalStatus = 'NOT_STARTED',
  quarantined = false,
): Readonly<WalletMiningDiagnosticEvent> {
  let observedFailure = failureOverride;
  if (!observedFailure && kind === 'TERMINAL_OUTCOME') {
    observedFailure = generation?.terminalFailure ?? null;
  }
  if (!observedFailure && callback?.errorPresent) {
    observedFailure = callbackFailure(
      callback,
      callbackFailureStage(callback) ?? 'WAITING_RESULT',
      'NATIVE_CALLBACK_ERROR',
    );
  }
  return Object.freeze({
    occurredAtMs,
    kind,
    walletId,
    sessionId: generation?.sessionId ?? null,
    generationToken: generation?.token ?? null,
    miniEpoch: generation?.miniEpoch ?? null,
    workerState,
    queuedLocalTaps: generation?.queuedLocalTaps ?? 0,
    nativeComputedTaps: generation?.nativeComputedTaps ?? 0,
    computationCompletedTaps:
      generation?.computationCompletedTaps ?? null,
    stage:
      explicitStage ??
      (kind === 'TERMINAL_OUTCOME'
        ? 'TERMINAL'
        : telemetryStageForCallback(callback)),
    baselineTapSum: generation?.baselineTapSum?.toString() ?? null,
    latestTapSum: generation?.latestTapSum?.toString() ?? null,
    confirmedTapDelta: generation?.confirmedTapDelta?.toString() ?? null,
    submissionStaggerMs: null,
    callbackAction: callback?.action ?? null,
    callbackSequence: callback?.sequence ?? null,
    errorPresent: callback?.errorPresent ?? null,
    nativeTopLevelMessage:
      callback?.nativeTopLevelMessage ?? observedFailure?.nativeTopLevelMessage ?? null,
    tvmCode: callback?.tvmCode ?? observedFailure?.tvmCode ?? null,
    tvmCodeName: callback?.tvmCodeName ?? observedFailure?.tvmCodeName ?? null,
    kitModule: callback?.kitModule ?? observedFailure?.kitModule ?? null,
    kitCode: callback?.kitCode ?? observedFailure?.kitCode ?? null,
    serverCode: callback?.serverCode ?? observedFailure?.serverCode ?? null,
    nodeExtensionCode:
      callback?.nodeExtensionCode ?? observedFailure?.nodeExtensionCode ?? null,
    nodeExtensionMessage:
      callback?.nodeExtensionMessage ??
      observedFailure?.nodeExtensionMessage ??
      null,
    tvmExitCode:
      callback?.tvmExitCode ??
      callback?.exitCode ??
      observedFailure?.tvmExitCode ??
      observedFailure?.exitCode ??
      null,
    transactionAborted:
      callback?.transactionAborted ??
      callback?.aborted ??
      observedFailure?.transactionAborted ??
      observedFailure?.aborted ??
      null,
    messageHash: callback?.messageHash ?? observedFailure?.messageHash ?? null,
    transactionHash:
      callback?.transactionHash ?? observedFailure?.transactionHash ?? null,
    accountId: callback?.accountId ?? observedFailure?.accountId ?? null,
    dappId: callback?.dappId ?? observedFailure?.dappId ?? null,
    threadId: callback?.threadId ?? observedFailure?.threadId ?? null,
    producerFingerprint:
      callback?.producerFingerprint ?? observedFailure?.producerFingerprint ?? null,
    coreVersion: callback?.coreVersion ?? observedFailure?.coreVersion ?? null,
    failureStage: observedFailure?.failureStage ?? null,
    errorCategory:
      callback?.errorCategory ?? observedFailure?.errorCategory ?? null,
    terminalOutcome: generation?.terminalOutcome ?? null,
    rewardStatus,
    disposalStatus,
    quarantined,
    failure: observedFailure,
    stale: false,
    observationDerived,
  });
}

function telemetryStageForCallback(
  callback: Readonly<SafeNativeCallback> | undefined,
): NonNullable<WalletMiningDiagnosticEvent['stage']> | null {
  const action = callback?.action.trim().toLowerCase();
  if (action === 'computation_completed') return 'COMPUTATION_COMPLETED';
  if (action === 'submit_session_root') return 'ROOT_CALLBACK';
  if (action === 'submit_session_proof') return 'PROOF_CALLBACK';
  if (action === 'session_accepted' || action === 'session_rejected') {
    return 'TERMINAL';
  }
  return null;
}

function callbackFailureStage(
  callback: Readonly<SafeNativeCallback> | undefined,
): SafeMiningFailure['failureStage'] {
  const action = callback?.action.trim().toLowerCase();
  if (action === 'submit_session_root') return 'ROOT_SUBMIT';
  if (action === 'submit_session_proof') return 'PROOF_SUBMIT';
  return callback?.failureStage ?? null;
}

function effectiveSessionDuration(
  maximumDurationMs: number,
  remainingMs: number | null,
  safetyMarginMs: number,
): number {
  if (remainingMs === null || !Number.isFinite(remainingMs)) {
    return maximumDurationMs;
  }
  return Math.max(
    1_000,
    Math.min(maximumDurationMs, Math.max(0, remainingMs - safetyMarginMs)),
  );
}

function rotatedFleetStartSlotIndex(
  baseSlotIndex: number,
  slotCount: number,
  miniEpoch: string,
): number {
  const normalizedSlotCount = Math.max(1, Math.floor(slotCount));
  let epochOffset = 0;
  try {
    const epochValue = BigInt(miniEpoch);
    const epochOrdinal = epochValue >= MINI_EPOCH_BLOCKS
      ? epochValue / MINI_EPOCH_BLOCKS
      : epochValue;
    epochOffset = Number(epochOrdinal % BigInt(normalizedSlotCount));
  } catch {
    for (const character of miniEpoch) {
      epochOffset = (epochOffset * 31 + character.charCodeAt(0)) %
        normalizedSlotCount;
    }
  }
  return (Math.max(0, Math.floor(baseSlotIndex)) + epochOffset) %
    normalizedSlotCount;
}

function validateOptions(options: Readonly<WalletMiningWorkerOptions>): void {
  const positive = [
    options.targetTaps,
    options.sessionDurationMs,
    options.tapIntervalMs,
    options.fleetStartSlotCount,
    options.terminalCallbackGraceMs,
    options.settlementTimeoutMs,
    options.rewardTimeoutMs,
  ];
  if (positive.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('Wallet mining worker options must be positive.');
  }
  if (options.sessionDurationMs < 1_000) {
    throw new RangeError('Wallet mining session duration must be at least 1000 ms.');
  }
  if (
    !Number.isFinite(options.firstTapDelayMs) || options.firstTapDelayMs < 0 ||
    !Number.isFinite(options.minimumStartWindowMs) || options.minimumStartWindowMs < 0 ||
    !Number.isFinite(options.epochEndSafetyMarginMs) ||
    options.epochEndSafetyMarginMs < 0 ||
    !Number.isFinite(options.fleetStartSlotIndex) ||
    options.fleetStartSlotIndex < 0 ||
    !Number.isFinite(options.fleetStartSlotCount) ||
    options.fleetStartSlotCount < 1 ||
    !Number.isFinite(options.epochStartDelayMs) ||
    options.epochStartDelayMs < 0 ||
    !Number.isFinite(options.tapJitterRangeMs) ||
    options.tapJitterRangeMs < 0
  ) {
    throw new RangeError(
      'Wallet mining boundary delays and jitter must be non-negative.',
    );
  }
}

function stateSet(
  ...states: readonly WalletMiningWorkerState[]
): ReadonlySet<WalletMiningWorkerState> {
  return new Set<WalletMiningWorkerState>(states);
}
