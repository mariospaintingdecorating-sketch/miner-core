import type { WalletMiningTelemetryStage } from '../shared/events';

export type WalletMiningWorkerState =
  | 'IDLE'
  | 'PREPARING'
  | 'READY'
  | 'MINING'
  | 'STOP_REQUESTED'
  | 'SUBMITTING_ROOT'
  | 'WAITING_INTERVAL'
  | 'SUBMITTING_PROOF'
  | 'WAITING_RESULT'
  | 'TERMINAL'
  | 'REWARDING'
  | 'DISPOSING'
  | 'WAITING_EPOCH'
  | 'BACKOFF'
  | 'DISPOSED';

export type WalletMiningTerminalOutcome =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'NATIVE_ERROR'
  | 'TIMEOUT'
  | 'PARTIAL_NATIVE_SESSION'
  | 'CANCELLED'
  | 'AMBIGUOUS';

export type WalletMiningFailureStage =
  | 'PREPARE'
  | 'TAP_EXECUTION'
  | 'NATIVE_COMPUTATION'
  | 'ROOT_SUBMIT'
  | 'PROOF_SUBMIT'
  | 'WAITING_RESULT'
  | 'REWARD'
  | 'DISPOSAL'
  | null;

export type WalletMiningRewardStatus =
  | 'NOT_REQUESTED'
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'SKIPPED';

export type WalletMiningDisposalStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED';

export interface ValidatedMiningIdentity {
  readonly walletId: string;
  readonly endpoints: readonly string[];
  readonly appId: string;
  readonly minerAddress: string;
  readonly publicKey: string;
  readonly secretKey: string;
}

export interface NativeMinerCreationInput {
  readonly endpoints: readonly string[];
  readonly appId: string;
  readonly minerAddress: string;
  readonly publicKey: string;
  readonly secretKey: string;
}

export interface NativeMinerData {
  readonly tapSum: bigint;
  free(): void;
}

export interface SafeNativeCallback {
  readonly action: string;
  readonly sequence: number;
  readonly status?: string | null;
  readonly computationCompletedTaps?: number | null;
  readonly errorPresent?: boolean;
  readonly failureStage?: WalletMiningFailureStage;
  readonly errorCategory?: string | null;
  readonly nativeTopLevelMessage?: string | null;
  readonly tvmCode?: number | null;
  readonly tvmCodeName?: string | null;
  readonly kitModule?: string | null;
  readonly kitCode?: number | string | null;
  readonly serverCode?: number | string | null;
  readonly nodeExtensionCode?: string | null;
  readonly nodeExtensionMessage?: string | null;
  readonly tvmExitCode?: number | null;
  readonly transactionAborted?: boolean | null;
  readonly exitCode?: number | null;
  readonly aborted?: boolean | null;
  readonly messageHash?: string | null;
  readonly transactionHash?: string | null;
  readonly accountId?: string | null;
  readonly dappId?: string | null;
  readonly threadId?: string | null;
  readonly producerFingerprint?: string | null;
  readonly coreVersion?: string | null;
}

export type SafeNativeCallbackListener = (
  callback: Readonly<SafeNativeCallback>,
) => void;

export interface NativeMinerHandle {
  canStart(): boolean | Promise<boolean>;
  start(
    durationMs: number,
    listener: SafeNativeCallbackListener,
  ): void | Promise<void>;
  addTap(x: number, y: number): void | Promise<void>;
  stop(): void | Promise<void>;
  getMinerData?(): Promise<NativeMinerData>;
  getReward(): Promise<void>;
  free(): void | Promise<void>;
}

export interface MiningNativeAdapter {
  createMiner(
    input: Readonly<NativeMinerCreationInput>,
  ): Promise<NativeMinerHandle>;
}

export interface CanonicalMiniEpochSnapshot {
  readonly miniEpoch: string | null;
  readonly remainingMs: number | null;
}

export interface CanonicalMiniEpochSource {
  snapshot(): Readonly<CanonicalMiniEpochSnapshot>;
  subscribe(listener: () => void): () => void;
}

export interface WalletMiningTimerSource {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TapCoordinates {
  readonly x: number;
  readonly y: number;
}

export interface WalletMiningRandomSource {
  tapCoordinates(index?: number): Readonly<TapCoordinates>;
  tapJitterMs(rangeMs: number): number;
}

export interface WalletMiningIdentitySource {
  nextGenerationToken(walletId: string): string;
  nextSessionId(walletId: string): string;
}

export interface WalletMiningRewardDispatchLimiter {
  waitForDispatch(walletId: string, generationToken: string): Promise<void>;
}

export interface WalletMiningPrepareDispatchLimiter {
  waitForDispatch(
    walletId: string,
    generationToken: string,
    signal?: AbortSignal,
  ): Promise<void>;
  reportOutcome(
    walletId: string,
    generationToken: string,
    failure: Readonly<SafeMiningFailure> | null,
  ): void;
}

export interface WalletMiningStartDispatchLimiter
  extends WalletMiningPrepareDispatchLimiter {}

/**
 * Fleet-wide feedback from native queue pressure. Workers only report safe,
 * classified outcomes; the controller never owns a wallet lifecycle.
 */
export interface WalletMiningQueuePressureController {
  startSpacingMs(fleetSize: number): number;
  observeQueueFailure(
    walletId: string,
    miniEpoch: string,
    generationToken: string,
    failure: Readonly<SafeMiningFailure>,
  ): void;
  reportProductiveOutcome(
    walletId: string,
    miniEpoch: string,
    failure: Readonly<SafeMiningFailure> | null,
  ): void;
}

export interface WalletMiningSubmissionGuard {
  enter(walletId: string, generationToken: string): () => void;
  transitionToPostSubmission(
    walletId: string,
    generationToken: string,
  ): Promise<() => void>;
  acquireIdleLease(
    scope: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<() => void>;
  waitUntilIdle(signal?: AbortSignal): Promise<void>;
}

export interface SafeMiningFailure {
  readonly failureStage: WalletMiningFailureStage;
  readonly errorCategory: string;
  readonly nativeTopLevelMessage?: string | null;
  readonly tvmCode?: number | null;
  readonly tvmCodeName?: string | null;
  readonly kitModule?: string | null;
  readonly kitCode?: number | string | null;
  readonly serverCode?: number | string | null;
  readonly nodeExtensionCode?: string | null;
  readonly nodeExtensionMessage?: string | null;
  readonly tvmExitCode?: number | null;
  readonly transactionAborted?: boolean | null;
  readonly exitCode?: number | null;
  readonly aborted?: boolean | null;
  readonly messageHash?: string | null;
  readonly transactionHash?: string | null;
  readonly accountId?: string | null;
  readonly dappId?: string | null;
  readonly threadId?: string | null;
  readonly producerFingerprint?: string | null;
  readonly coreVersion?: string | null;
}

export class MiningNativeAdapterError extends Error {
  constructor(readonly safeFailure: Readonly<SafeMiningFailure>) {
    super('Mining native adapter operation failed.');
    this.name = 'MiningNativeAdapterError';
  }
}

export interface WalletMiningSnapshot {
  readonly walletId: string;
  readonly state: WalletMiningWorkerState;
  readonly sessionId: string | null;
  readonly generationToken: string | null;
  readonly miniEpoch: string | null;
  readonly desiredMining: boolean;
  readonly queuedLocalTaps: number;
  readonly nativeComputedTaps: number;
  readonly computationCompletedTaps: number | null;
  readonly baselineTapSum: string | null;
  readonly latestTapSum: string | null;
  readonly confirmedTapDelta: string | null;
  readonly submissionStaggerMs: number | null;
  readonly terminalOutcome: WalletMiningTerminalOutcome | null;
  readonly failureStage: WalletMiningFailureStage;
  readonly errorCategory: string | null;
  readonly rewardStatus: WalletMiningRewardStatus;
  readonly disposalStatus: WalletMiningDisposalStatus;
  readonly quarantined: boolean;
  readonly lastCallbackAction: string | null;
  readonly lastCallbackSequence: number | null;
  readonly transitionObservationDerived: boolean;
}

export interface WalletMiningDiagnosticEvent {
  readonly occurredAtMs: number;
  readonly kind:
    | 'STATE_TRANSITION'
    | 'CALLBACK'
    | 'STALE_CALLBACK'
    | 'DUPLICATE_CALLBACK'
    | 'TAP_QUEUED'
    | 'LIFECYCLE'
    | 'TERMINAL_OUTCOME'
    | 'REWARD_RESULT'
    | 'DISPOSAL_RESULT';
  readonly walletId: string;
  readonly sessionId: string | null;
  readonly generationToken: string | null;
  readonly miniEpoch: string | null;
  readonly workerState: WalletMiningWorkerState;
  readonly queuedLocalTaps: number;
  readonly nativeComputedTaps: number;
  readonly computationCompletedTaps: number | null;
  readonly stage?: WalletMiningTelemetryStage | null;
  readonly baselineTapSum?: string | null;
  readonly latestTapSum?: string | null;
  readonly confirmedTapDelta?: string | null;
  readonly submissionStaggerMs?: number | null;
  readonly callbackAction?: string | null;
  readonly callbackSequence?: number | null;
  readonly errorPresent?: boolean | null;
  readonly nativeTopLevelMessage?: string | null;
  readonly tvmCode?: number | null;
  readonly tvmCodeName?: string | null;
  readonly kitModule?: string | null;
  readonly kitCode?: number | string | null;
  readonly serverCode?: number | string | null;
  readonly nodeExtensionCode?: string | null;
  readonly nodeExtensionMessage?: string | null;
  readonly tvmExitCode?: number | null;
  readonly transactionAborted?: boolean | null;
  readonly messageHash?: string | null;
  readonly transactionHash?: string | null;
  readonly accountId?: string | null;
  readonly dappId?: string | null;
  readonly threadId?: string | null;
  readonly producerFingerprint?: string | null;
  readonly coreVersion?: string | null;
  readonly failureStage?: WalletMiningFailureStage;
  readonly errorCategory?: string | null;
  readonly terminalOutcome?: WalletMiningTerminalOutcome | null;
  readonly rewardStatus?: WalletMiningRewardStatus | null;
  readonly disposalStatus?: WalletMiningDisposalStatus | null;
  readonly quarantined?: boolean;
  readonly failure?: Readonly<SafeMiningFailure> | null;
  readonly stale?: boolean;
  readonly observationDerived?: boolean;
}

export interface WalletMiningDiagnosticSink {
  record(event: Readonly<WalletMiningDiagnosticEvent>): void;
}

export type WalletMiningStopReason =
  | 'OPERATOR'
  | 'STOP_ALL'
  | 'TIMED_COMPLETION'
  | 'EPOCH_BOUNDARY'
  | 'APPLICATION_DISPOSAL';

export type WalletMiningStartResult = Readonly<{
  status: 'STARTED' | 'ALREADY_ACTIVE' | 'WAITING_EPOCH' | 'CANCELLED' | 'FAILED';
  sessionId: string | null;
  generationToken: string | null;
}>;

export type WalletMiningStopResult = Readonly<{
  status: 'STOPPED' | 'ALREADY_STOPPED' | 'QUARANTINED';
  terminalOutcome: WalletMiningTerminalOutcome | null;
}>;

export interface WalletMiningRuntime {
  start(
    input: Readonly<ValidatedMiningIdentity>,
  ): Promise<Readonly<WalletMiningStartResult>>;
  stop(
    reason: WalletMiningStopReason,
  ): Promise<Readonly<WalletMiningStopResult>>;
  snapshot(): Readonly<WalletMiningSnapshot>;
  subscribe(
    listener: (snapshot: Readonly<WalletMiningSnapshot>) => void,
  ): () => void;
  dispose(): Promise<void>;
}

export interface WalletMiningWorkerOptions {
  readonly targetTaps: number;
  readonly firstTapDelayMs: number;
  readonly minimumStartWindowMs: number;
  readonly sessionDurationMs: number;
  readonly epochEndSafetyMarginMs: number;
  readonly fleetStartSlotIndex: number;
  readonly fleetStartSlotCount: number;
  readonly epochStartDelayMs: number;
  readonly tapIntervalMs: number;
  readonly tapJitterRangeMs: number;
  readonly terminalCallbackGraceMs: number;
  readonly settlementTimeoutMs: number;
  readonly rewardTimeoutMs: number;
}

export const DEFAULT_WALLET_MINING_WORKER_OPTIONS: Readonly<WalletMiningWorkerOptions> =
  Object.freeze({
    targetTaps: 70,
    firstTapDelayMs: 1_720,
    minimumStartWindowMs: 145_000,
    sessionDurationMs: 126_000,
    epochEndSafetyMarginMs: 19_000,
    fleetStartSlotIndex: 0,
    fleetStartSlotCount: 1,
    epochStartDelayMs: 5_000,
    tapIntervalMs: 1_720,
    tapJitterRangeMs: 0,
    terminalCallbackGraceMs: 30_000,
    settlementTimeoutMs: 600_000,
    rewardTimeoutMs: 65_000,
  });

export const SYSTEM_WALLET_MINING_TIMER: WalletMiningTimerSource = Object.freeze({
  nowMs: Date.now,
  setTimeout: (callback: () => void, delayMs: number) =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

export const SYSTEM_WALLET_MINING_RANDOM: WalletMiningRandomSource = Object.freeze({
  tapCoordinates: (index = 0) => {
    const points = [[120,120],[180,135],[230,160],[275,190],[245,225],[195,245],[145,220],[105,185]] as const;
    const point = points[Math.max(0, Math.trunc(index)) % points.length];
    return Object.freeze({ x: point[0], y: point[1] });
  },
  tapJitterMs: (rangeMs: number) => Math.round((Math.random() * 2 - 1) * rangeMs),
});

export const NOOP_MINING_DIAGNOSTIC_SINK: WalletMiningDiagnosticSink =
  Object.freeze({ record: () => undefined });

export const NOOP_REWARD_DISPATCH_LIMITER: WalletMiningRewardDispatchLimiter =
  Object.freeze({ waitForDispatch: async () => undefined });

export const NOOP_PREPARE_DISPATCH_LIMITER: WalletMiningPrepareDispatchLimiter =
  Object.freeze({
    waitForDispatch: async () => undefined,
    reportOutcome: () => undefined,
  });

export const NOOP_START_DISPATCH_LIMITER: WalletMiningStartDispatchLimiter =
  NOOP_PREPARE_DISPATCH_LIMITER;

export const NOOP_QUEUE_PRESSURE_CONTROLLER: WalletMiningQueuePressureController =
  Object.freeze({
    startSpacingMs: () => 0,
    observeQueueFailure: () => undefined,
    reportProductiveOutcome: () => undefined,
  });

export const NOOP_SUBMISSION_GUARD: WalletMiningSubmissionGuard =
  Object.freeze({
    enter: () => () => undefined,
    transitionToPostSubmission: async () => () => undefined,
    acquireIdleLease: async () => () => undefined,
    waitUntilIdle: async () => undefined,
  });

export function isQueueFailure(
  failure: Readonly<SafeMiningFailure> | null,
): boolean {
  if (!failure) return false;
  const category = failure.errorCategory.trim().toUpperCase();
  const extension = failure.nodeExtensionCode?.trim().toUpperCase() ?? '';
  return (
    category === 'QUEUE' ||
    category === 'QUEUE_OVERFLOW' ||
    extension === 'QUEUE_OVERFLOW'
  );
}
