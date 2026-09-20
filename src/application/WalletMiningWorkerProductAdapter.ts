import type {
  MinerRuntimeStatus,
  SettlementState,
  TapSchedulingStatus,
} from '../shared/miningRuntime';
import {
  DEFAULT_WALLET_MINING_WORKER_OPTIONS,
  type WalletMiningDiagnosticEvent,
  type WalletMiningDiagnosticSink,
  type WalletMiningRewardStatus,
  type WalletMiningSnapshot,
  type WalletMiningStopReason,
  type WalletMiningTerminalOutcome,
  type WalletMiningWorkerState,
} from '../mining/WalletMiningRuntime';
import type {
  CoreEvent,
  CoreEventType,
  EventPublisher,
  WalletMiningWorkerDiagnosticEventPayload,
} from '../shared/events';
import type { WalletRegistryContract } from '../shared/wallets';
import type { RewardSynchronizationSnapshot } from './operatorState';
import type { RuntimePresentationState } from './runtimeState';

interface SessionProjection {
  readonly generationToken: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly miniEpoch: string | null;
  sessionCreated: boolean;
  sessionStarted: boolean;
  settlementStarted: boolean;
  terminalPublished: boolean;
  rewardStarted: boolean;
  rewardResultPublished: boolean;
  sessionClosed: boolean;
  lastQueuedLocalTaps: number;
}

const RETAINED_COMPLETED_GENERATIONS = 8;

export interface WalletMiningWorkerProductAdapterDependencies {
  readonly eventPublisher: EventPublisher;
  readonly walletRegistry: Pick<
    WalletRegistryContract,
    'associateSession' | 'clearSession' | 'updateStatus'
  >;
  readonly initialGeneration?: number;
  readonly now?: () => number;
}

type ObservableWalletMiningRuntime = Pick<
  import('../mining/WalletMiningRuntime').WalletMiningRuntime,
  'snapshot' | 'subscribe'
>;

/**
 * Presentation and event translation only. WalletMiningWorker remains the sole
 * lifecycle, native Miner, settlement, reward and disposal owner.
 */
export class WalletMiningWorkerProductAdapter {
  readonly #generationByToken = new Map<string, number>();
  readonly #sessions = new Map<string, SessionProjection>();
  readonly #unsubscribe: () => void;
  readonly #now: () => number;
  #snapshot: Readonly<WalletMiningSnapshot>;
  #nextGeneration: number;
  #eventSequence = 0;
  #disposed = false;

  constructor(
    readonly runtime: Readonly<ObservableWalletMiningRuntime>,
    private readonly dependencies: Readonly<WalletMiningWorkerProductAdapterDependencies>,
  ) {
    this.#snapshot = runtime.snapshot();
    this.#nextGeneration = Math.max(0, dependencies.initialGeneration ?? 0);
    this.#now = dependencies.now ?? (() => Date.now());
    this.#unsubscribe = runtime.subscribe((snapshot) => this.#observe(snapshot));
  }

  snapshot(): Readonly<WalletMiningSnapshot> {
    return this.#snapshot;
  }

  generationForToken(generationToken: string | null): number | null {
    if (!generationToken) return null;
    const existing = this.#generationByToken.get(generationToken);
    if (existing !== undefined) return existing;
    this.#pruneCompletedGenerations(generationToken);
    const generation = ++this.#nextGeneration;
    this.#generationByToken.set(generationToken, generation);
    return generation;
  }

  activeSessionIdentity(): Readonly<{
    sessionId: string;
    generation: number;
  }> | null {
    const token = this.#snapshot.generationToken;
    if (!token) return null;
    const session = this.#sessions.get(token);
    return session && !session.sessionClosed
      ? Object.freeze({
          sessionId: session.sessionId,
          generation: session.generation,
        })
      : null;
  }

  presentation(
    base: Readonly<RuntimePresentationState>,
  ): Readonly<RuntimePresentationState> {
    const snapshot = this.#snapshot;
    const token = snapshot.generationToken;
    const session = token ? this.#sessions.get(token) : null;
    const executionVisible = Boolean(session && !session.sessionClosed);
    const completedTapCount = snapshot.queuedLocalTaps;
    const targetTapCount = snapshot.configuredTargetTaps ?? DEFAULT_WALLET_MINING_WORKER_OPTIONS.targetTaps;
    const errorCode = snapshot.errorCategory ?? snapshot.failureStage;

    return Object.freeze({
      ...base,
      runtimeStatus: runtimeStatusFromWorker(snapshot),
      miningExecution: executionVisible && session
        ? Object.freeze({
            sessionId: session.sessionId,
            generation: session.generation,
            status: executionStatusFromWorker(snapshot),
            sessionProgressPercent: Math.min(
              100,
              (completedTapCount / targetTapCount) * 100,
            ),
            tapProgress: Object.freeze({
              completedTapCount,
              targetTapCount,
              remainingTapCount: Math.max(0, targetTapCount - completedTapCount),
            }),
            approximateIntervalMs: snapshot.configuredTapIntervalMs ??
              DEFAULT_WALLET_MINING_WORKER_OPTIONS.tapIntervalMs,
            jitterEnabled:
              DEFAULT_WALLET_MINING_WORKER_OPTIONS.tapJitterRangeMs > 0,
            lastExecutionId:
              completedTapCount > 0
                ? `new-worker:${session.sessionId}:tap:${completedTapCount}`
                : null,
          })
        : null,
      schedulerStatus: schedulerStatusFromWorker(snapshot),
      settlementStatus: settlementStatusFromWorker(snapshot),
      settlementOutcome: snapshot.terminalOutcome
        ? productSettlementOutcome(snapshot.terminalOutcome)
        : null,
      settlementSessionId:
        snapshot.terminalOutcome && session ? session.sessionId : null,
      settlementGeneration:
        snapshot.terminalOutcome && session ? session.generation : null,
      boundaryStatus:
        snapshot.state === 'WAITING_EPOCH' ? 'completed' : 'idle',
      recoveryStatus:
        snapshot.state === 'BACKOFF' || snapshot.quarantined
          ? 'pending'
          : 'idle',
      recoveryIssue: errorCode
        ? Object.freeze({
            code: errorCode,
            message: 'The new wallet mining worker reported a safe diagnostic failure.',
            severity: 'error' as const,
          })
        : null,
      health: Object.freeze({
        ...base.health,
        lastError: errorCode
          ? Object.freeze({
              occurredAt: new Date(this.#now()).toISOString(),
              code: errorCode,
              message: 'The new wallet mining worker reported a safe diagnostic failure.',
            })
          : base.health.lastError,
      }),
    });
  }

  rewardSynchronization(): Readonly<RewardSynchronizationSnapshot> {
    const snapshot = this.#snapshot;
    const generation = this.generationForToken(snapshot.generationToken);
    return Object.freeze({
      status: rewardPresentationStatus(snapshot.rewardStatus),
      walletId: snapshot.sessionId ? snapshot.walletId : null,
      sessionId: snapshot.sessionId,
      generation,
      confirmedRewardCount: 0,
      code:
        snapshot.rewardStatus === 'FAILED'
          ? 'NEW_WORKER_REWARD_FAILED'
          : snapshot.rewardStatus === 'TIMED_OUT'
            ? 'NEW_WORKER_REWARD_TIMEOUT'
            : null,
    });
  }

  isTerminal(): boolean {
    const snapshot = this.#snapshot;
    return (
      snapshot.state === 'IDLE' ||
      snapshot.state === 'DISPOSED' ||
      (snapshot.quarantined && snapshot.disposalStatus === 'FAILED')
    );
  }

  noteStopReason(_reason: WalletMiningStopReason): void {
    // The existing product marks explicit stop reasons before delegating STOP.
  }

  detach(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#generationByToken.clear();
    this.#sessions.clear();
  }

  #pruneCompletedGenerations(nextGenerationToken: string): void {
    if (this.#generationByToken.size < RETAINED_COMPLETED_GENERATIONS) return;
    for (const token of this.#generationByToken.keys()) {
      if (this.#generationByToken.size < RETAINED_COMPLETED_GENERATIONS) break;
      if (token === nextGenerationToken) continue;
      const session = this.#sessions.get(token);
      if (session && !session.sessionClosed) continue;
      this.#generationByToken.delete(token);
      this.#sessions.delete(token);
    }
  }

  #observe(snapshot: Readonly<WalletMiningSnapshot>): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    const projection = this.#projection(snapshot);
    if (!projection) return;

    if (!projection.sessionCreated) {
      projection.sessionCreated = true;
      const associated = this.dependencies.walletRegistry.associateSession(
        snapshot.walletId,
        {
          sessionId: projection.sessionId,
          generation: projection.generation,
        },
      );
      this.#publish('session-created', projection);
      if (!associated) {
        this.#publishRuntimeError(
          snapshot.walletId,
          'new-worker-session-association-conflict',
          'The product wallet session could not be associated with the new worker.',
        );
      }
    }

    if (snapshot.state === 'MINING' && !projection.sessionStarted) {
      projection.sessionStarted = true;
      this.dependencies.walletRegistry.updateStatus(snapshot.walletId, 'running');
      this.#publish('session-started', projection);
    }

    if (snapshot.queuedLocalTaps > projection.lastQueuedLocalTaps) {
      projection.lastQueuedLocalTaps = snapshot.queuedLocalTaps;
      this.#publishTapProgress(projection, snapshot.queuedLocalTaps);
    }

    if (
      !projection.settlementStarted &&
      isSettlementState(snapshot.state)
    ) {
      projection.settlementStarted = true;
      this.#publish('settlement-started', projection);
    }

    if (snapshot.terminalOutcome && !projection.terminalPublished) {
      projection.terminalPublished = true;
      this.#publishTerminal(projection, snapshot);
    }

    if (snapshot.rewardStatus === 'PENDING' && !projection.rewardStarted) {
      projection.rewardStarted = true;
      this.#publish('reward-sync-started', projection);
    }

    if (
      projection.rewardStarted &&
      !projection.rewardResultPublished &&
      isResolvedRewardStatus(snapshot.rewardStatus)
    ) {
      projection.rewardResultPublished = true;
      this.#publishRewardResult(projection, snapshot.rewardStatus);
    }

    if (
      projection.terminalPublished &&
      !projection.sessionClosed &&
      sessionCleanupComplete(snapshot)
    ) {
      projection.sessionClosed = true;
      this.dependencies.walletRegistry.clearSession(snapshot.walletId, {
        sessionId: projection.sessionId,
        generation: projection.generation,
      });
      this.dependencies.walletRegistry.updateStatus(
        snapshot.walletId,
        snapshot.quarantined ? 'error' : 'idle',
      );
      this.#publish('session-finished', projection);
      this.#publishProductCloseDiagnostic(projection, snapshot);
    }
  }

  #projection(
    snapshot: Readonly<WalletMiningSnapshot>,
  ): SessionProjection | null {
    const token = snapshot.generationToken;
    const sessionId = snapshot.sessionId;
    if (!token || !sessionId) return null;
    const existing = this.#sessions.get(token);
    if (existing) return existing;
    const projection: SessionProjection = {
      generationToken: token,
      sessionId,
      generation: this.generationForToken(token)!,
      miniEpoch: snapshot.miniEpoch,
      sessionCreated: false,
      sessionStarted: false,
      settlementStarted: false,
      terminalPublished: false,
      rewardStarted: false,
      rewardResultPublished: false,
      sessionClosed: false,
      lastQueuedLocalTaps: 0,
    };
    this.#sessions.set(token, projection);
    return projection;
  }

  #publish<TType extends 'session-created' | 'session-started' | 'settlement-started' | 'reward-sync-started' | 'session-finished'>(
    type: TType,
    session: Readonly<SessionProjection>,
  ): void {
    this.#safePublish({
      id: this.#eventId(type, session),
      occurredAt: new Date(this.#now()).toISOString(),
      type,
      payload: {
        walletId: this.#snapshot.walletId,
        sessionId: session.sessionId,
        generation: session.generation,
        miniEpoch: session.miniEpoch,
      },
    } as CoreEvent<TType>);
  }

  #publishTapProgress(
    session: Readonly<SessionProjection>,
    completedTapCount: number,
  ): void {
    this.#safePublish({
      id: this.#eventId('tap-progress', session),
      occurredAt: new Date(this.#now()).toISOString(),
      type: 'tap-progress',
      payload: {
        walletId: this.#snapshot.walletId,
        sessionId: session.sessionId,
        generation: session.generation,
        miniEpoch: session.miniEpoch,
        completedTapCount,
      },
    });
  }

  #publishTerminal(
    session: Readonly<SessionProjection>,
    snapshot: Readonly<WalletMiningSnapshot>,
  ): void {
    const outcome = productSettlementOutcome(snapshot.terminalOutcome!);
    this.#safePublish({
      id: this.#eventId('bee-settlement-outcome', session),
      occurredAt: new Date(this.#now()).toISOString(),
      type: 'bee-settlement-outcome',
      payload: {
        walletId: snapshot.walletId,
        sessionId: session.sessionId,
        generation: session.generation,
        miniEpoch: session.miniEpoch,
        operationId: `new-worker:${snapshot.failureStage ?? 'terminal'}:${session.sessionId}`,
        code: snapshot.failureStage ?? snapshot.errorCategory,
        message:
          outcome === 'accepted'
            ? null
            : `New wallet worker terminal outcome: ${snapshot.terminalOutcome}.`,
        classification: null,
        messageHash: null,
        outcome,
        submissionReference: null,
        confirmedTaps: confirmedTapDeltaAsNumber(snapshot.confirmedTapDelta),
      },
    });
  }

  #publishRewardResult(
    session: Readonly<SessionProjection>,
    status: WalletMiningRewardStatus,
  ): void {
    const failed = status === 'FAILED' || status === 'TIMED_OUT';
    this.#safePublish({
      id: this.#eventId('bee-reward-sync-completed', session),
      occurredAt: new Date(this.#now()).toISOString(),
      type: 'bee-reward-sync-completed',
      payload: {
        walletId: this.#snapshot.walletId,
        sessionId: session.sessionId,
        generation: session.generation,
        confirmedRewardCount: 0,
        code: failed ? `NEW_WORKER_REWARD_${status}` : null,
        message: failed ? `New wallet worker reward result: ${status}.` : null,
      },
    });
  }

  #publishRuntimeError(walletId: string, code: string, message: string): void {
    this.#safePublish({
      id: `new-worker-runtime-error:${walletId}:${++this.#eventSequence}`,
      occurredAt: new Date(this.#now()).toISOString(),
      type: 'runtime-error',
      payload: { walletId, code, message },
    });
  }

  #publishProductCloseDiagnostic(
    session: Readonly<SessionProjection>,
    snapshot: Readonly<WalletMiningSnapshot>,
  ): void {
    this.#safePublish({
      id: this.#eventId('wallet-mining-worker-diagnostic', session),
      occurredAt: new Date(this.#now()).toISOString(),
      type: 'wallet-mining-worker-diagnostic',
      payload: diagnosticPayload(snapshot, session.generation, 'PRODUCT_SESSION_CLOSE'),
    });
  }

  #eventId(type: string, session: Readonly<SessionProjection>): string {
    return `new-worker:${type}:${session.sessionId}:${session.generation}:${++this.#eventSequence}`;
  }

  #safePublish<TType extends CoreEventType>(event: CoreEvent<TType>): void {
    try {
      this.dependencies.eventPublisher.publish(event);
    } catch {
      // Product observation cannot control WalletMiningWorker ownership.
    }
  }
}

export class WalletMiningWorkerDiagnosticBridge
  implements WalletMiningDiagnosticSink
{
  #sequence = 0;

  constructor(
    private readonly eventPublisher: EventPublisher,
    private readonly generationForToken: (
      walletId: string,
      generationToken: string | null,
    ) => number | null,
  ) {}

  record(event: Readonly<WalletMiningDiagnosticEvent>): void {
    if (
      event.kind === 'TAP_QUEUED' ||
      (event.kind === 'CALLBACK' &&
        event.callbackAction?.trim().toLowerCase() === 'tap_computed')
    ) {
      return;
    }
    const generation = this.generationForToken(
      event.walletId,
      event.generationToken,
    );
    try {
      this.eventPublisher.publish({
        id: `new-worker-diagnostic:${event.walletId}:${++this.#sequence}`,
        occurredAt: new Date(event.occurredAtMs).toISOString(),
        type: 'wallet-mining-worker-diagnostic',
        payload: diagnosticEventPayload(event, generation),
      });
    } catch {
      // Diagnostics cannot control WalletMiningWorker ownership.
    }
  }
}

export function productSettlementOutcome(
  outcome: WalletMiningTerminalOutcome,
): 'accepted' | 'rejected' | 'timeout' | 'native_error' | 'unknown' {
  switch (outcome) {
    case 'ACCEPTED':
      return 'accepted';
    case 'REJECTED':
      return 'rejected';
    case 'TIMEOUT':
      return 'timeout';
    case 'NATIVE_ERROR':
    case 'PARTIAL_NATIVE_SESSION':
      return 'native_error';
    case 'CANCELLED':
    case 'AMBIGUOUS':
      return 'unknown';
  }
}

/** Existing completedTaps compatibility means locally queued, never confirmed. */
export function confirmedTapDeltaAsNumber(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function runtimeStatusFromWorker(
  snapshot: Readonly<WalletMiningSnapshot>,
): MinerRuntimeStatus {
  switch (snapshot.state) {
    case 'IDLE':
      return 'idle';
    case 'PREPARING':
    case 'READY':
      return 'starting';
    case 'MINING':
      return 'running';
    case 'WAITING_EPOCH':
    case 'BACKOFF':
      return 'waiting';
    case 'DISPOSED':
      return 'disposed';
    default:
      return 'stopping';
  }
}

function schedulerStatusFromWorker(
  snapshot: Readonly<WalletMiningSnapshot>,
): TapSchedulingStatus {
  if (snapshot.state === 'MINING') return 'running';
  if (snapshot.sessionId && snapshot.state !== 'PREPARING' && snapshot.state !== 'READY') {
    return 'stopped';
  }
  return 'idle';
}

function settlementStatusFromWorker(
  snapshot: Readonly<WalletMiningSnapshot>,
): SettlementState {
  if (snapshot.terminalOutcome) return 'completed';
  return isSettlementState(snapshot.state) ? 'pending' : 'idle';
}

function executionStatusFromWorker(
  snapshot: Readonly<WalletMiningSnapshot>,
): 'idle' | 'running' | 'completed' | 'stopped' {
  if (snapshot.state === 'MINING') return 'running';
  if (
    snapshot.queuedLocalTaps >=
    DEFAULT_WALLET_MINING_WORKER_OPTIONS.targetTaps
  ) {
    return 'completed';
  }
  return snapshot.sessionId ? 'stopped' : 'idle';
}

function isSettlementState(state: WalletMiningWorkerState): boolean {
  return (
    state === 'STOP_REQUESTED' ||
    state === 'SUBMITTING_ROOT' ||
    state === 'WAITING_INTERVAL' ||
    state === 'SUBMITTING_PROOF' ||
    state === 'WAITING_RESULT'
  );
}

function sessionCleanupComplete(snapshot: Readonly<WalletMiningSnapshot>): boolean {
  return (
    (snapshot.disposalStatus === 'SUCCEEDED' &&
      (snapshot.state === 'IDLE' ||
        snapshot.state === 'WAITING_EPOCH' ||
        snapshot.state === 'BACKOFF' ||
        snapshot.state === 'DISPOSED')) ||
    (snapshot.quarantined && snapshot.disposalStatus === 'FAILED')
  );
}

function isResolvedRewardStatus(status: WalletMiningRewardStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'TIMED_OUT';
}

function rewardPresentationStatus(
  status: WalletMiningRewardStatus,
): RewardSynchronizationSnapshot['status'] {
  switch (status) {
    case 'PENDING':
      return 'synchronizing';
    case 'SUCCEEDED':
      return 'completed';
    case 'FAILED':
    case 'TIMED_OUT':
      return 'failed';
    case 'NOT_REQUESTED':
    case 'SKIPPED':
      return 'idle';
  }
}

function diagnosticEventPayload(
  event: Readonly<WalletMiningDiagnosticEvent>,
  generation: number | null,
): Readonly<WalletMiningWorkerDiagnosticEventPayload> {
  return Object.freeze({
    engine: 'NEW_WALLET_WORKER',
    stage: event.stage ?? null,
    walletId: event.walletId,
    sessionId: event.sessionId,
    generation,
    miniEpoch: event.miniEpoch,
    workerState: event.workerState,
    queuedLocalTaps: event.queuedLocalTaps,
    nativeComputedTaps: event.nativeComputedTaps,
    computationCompletedTaps: event.computationCompletedTaps,
    baselineTapSum: event.baselineTapSum ?? null,
    latestTapSum: event.latestTapSum ?? null,
    confirmedTapDelta: event.confirmedTapDelta ?? null,
    submissionStaggerMs: event.submissionStaggerMs ?? null,
    callbackAction: event.callbackAction ?? null,
    callbackSequence: event.callbackSequence ?? null,
    errorPresent: event.errorPresent ?? null,
    nativeTopLevelMessage: event.nativeTopLevelMessage ?? null,
    tvmCode: event.tvmCode ?? null,
    tvmCodeName: event.tvmCodeName ?? null,
    kitModule: event.kitModule ?? null,
    kitCode: event.kitCode ?? null,
    serverCode: event.serverCode ?? null,
    nodeExtensionCode: event.nodeExtensionCode ?? null,
    nodeExtensionMessage: event.nodeExtensionMessage ?? null,
    tvmExitCode: event.tvmExitCode ?? null,
    transactionAborted: event.transactionAborted ?? null,
    messageHash: event.messageHash ?? null,
    transactionHash: event.transactionHash ?? null,
    accountId: event.accountId ?? null,
    dappId: event.dappId ?? null,
    threadId: event.threadId ?? null,
    producerFingerprint: event.producerFingerprint ?? null,
    coreVersion: event.coreVersion ?? null,
    failureStage: event.failureStage ?? event.failure?.failureStage ?? null,
    errorCategory: event.errorCategory ?? event.failure?.errorCategory ?? null,
    terminalOutcome: event.terminalOutcome ?? null,
    rewardStatus: event.rewardStatus ?? null,
    disposalStatus: event.disposalStatus ?? null,
    quarantined: event.quarantined ?? false,
    stale: event.stale ?? false,
    observationDerived: event.observationDerived ?? false,
  });
}

function diagnosticPayload(
  snapshot: Readonly<WalletMiningSnapshot>,
  generation: number,
  stage: WalletMiningWorkerDiagnosticEventPayload['stage'],
): Readonly<WalletMiningWorkerDiagnosticEventPayload> {
  return Object.freeze({
    engine: 'NEW_WALLET_WORKER',
    stage,
    walletId: snapshot.walletId,
    sessionId: snapshot.sessionId,
    generation,
    miniEpoch: snapshot.miniEpoch,
    workerState: snapshot.state,
    queuedLocalTaps: snapshot.queuedLocalTaps,
    nativeComputedTaps: snapshot.nativeComputedTaps,
    computationCompletedTaps: snapshot.computationCompletedTaps,
    baselineTapSum: snapshot.baselineTapSum,
    latestTapSum: snapshot.latestTapSum,
    confirmedTapDelta: snapshot.confirmedTapDelta,
    submissionStaggerMs: snapshot.submissionStaggerMs,
    callbackAction: snapshot.lastCallbackAction,
    callbackSequence: snapshot.lastCallbackSequence,
    errorPresent: null,
    nativeTopLevelMessage: null,
    tvmCode: null,
    tvmCodeName: null,
    kitModule: null,
    kitCode: null,
    serverCode: null,
    nodeExtensionCode: null,
    nodeExtensionMessage: null,
    tvmExitCode: null,
    transactionAborted: null,
    messageHash: null,
    transactionHash: null,
    accountId: null,
    dappId: null,
    threadId: null,
    producerFingerprint: null,
    coreVersion: null,
    failureStage: null,
    errorCategory: null,
    terminalOutcome: snapshot.terminalOutcome,
    rewardStatus: snapshot.rewardStatus,
    disposalStatus: snapshot.disposalStatus,
    quarantined: snapshot.quarantined,
    stale: false,
    observationDerived: snapshot.transitionObservationDerived,
  });
}
