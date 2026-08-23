import type { BeeFailureClassification } from './beeFailures';

export interface DomainEvent<TType extends string, TPayload = undefined> {
  readonly id: string;
  readonly occurredAt: string;
  readonly type: TType;
  readonly payload: TPayload;
}

export const SESSION_EVENT_TYPES = [
  'session-created',
  'session-started',
  'session-finished',
] as const;

export const MINING_EVENT_TYPES = [
  'tap-progress',
  'tap-execution-failed',
  'boundary-reached',
  'settlement-started',
  'settlement-completed',
] as const;

export const RECOVERY_EVENT_TYPES = [
  'warning',
  'recovery-started',
  'recovery-completed',
] as const;

export const REWARD_EVENT_TYPES = [
  'reward-sync-started',
  'reward-received',
  'reward-recorded',
] as const;

export const SYSTEM_EVENT_TYPES = [
  'wallet-runtime-created',
  'wallet-runtime-start-stage',
  'runtime-error',
] as const;

export const EPOCH_EVENT_TYPES = ['epoch-changed'] as const;

export const BEE_OPERATION_EVENT_TYPES = [
  'bee-sdk-ready',
  'bee-sdk-failed',
  'bee-wallet-connection-started',
  'bee-wallet-connected',
  'bee-wallet-connection-failed',
  'bee-mining-started',
  'bee-mining-failed',
  'bee-graphql-pool-timeout',
  'bee-settlement-trace',
  'bee-settlement-outcome',
  'bee-reward-sync-completed',
  'wallet-mining-worker-diagnostic',
] as const;

export const CORE_EVENT_TYPES = [
  ...SYSTEM_EVENT_TYPES,
  ...SESSION_EVENT_TYPES,
  ...MINING_EVENT_TYPES,
  ...EPOCH_EVENT_TYPES,
  ...RECOVERY_EVENT_TYPES,
  ...REWARD_EVENT_TYPES,
  ...BEE_OPERATION_EVENT_TYPES,
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];
export type MiningEventType = (typeof MINING_EVENT_TYPES)[number];
export type RecoveryEventType = (typeof RECOVERY_EVENT_TYPES)[number];
export type RewardEventType = (typeof REWARD_EVENT_TYPES)[number];
export type SystemEventType = (typeof SYSTEM_EVENT_TYPES)[number];
export type EpochEventType = (typeof EPOCH_EVENT_TYPES)[number];
export type BeeOperationEventType =
  (typeof BEE_OPERATION_EVENT_TYPES)[number];
export type CoreEventType = (typeof CORE_EVENT_TYPES)[number];

export interface SessionEventPayload {
  readonly walletId?: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly miniEpoch?: string | null;
}

export interface WalletRuntimeCreatedEventPayload {
  readonly walletId: string | null;
}

export interface WalletRuntimeStartStageEventPayload {
  readonly walletId: string;
  readonly stage: 'requested' | 'prepare-started' | 'running-reached';
}

export interface RuntimeErrorEventPayload {
  readonly walletId?: string | null;
  readonly code: string;
  readonly message: string;
}

export interface EpochChangedEventPayload {
  readonly previousMiniEpoch: string | null;
  readonly miniEpoch: string;
  readonly mainEpoch: string | null;
  readonly currentBlock: string | null;
  readonly confidence: 'canonical' | 'estimated';
  readonly lastFailureCode: string | null;
}

export interface TapProgressEventPayload extends SessionEventPayload {
  readonly completedTapCount: number;
}

export interface TapExecutionFailedEventPayload extends SessionEventPayload {
  readonly executionId: string;
  readonly code: string;
  readonly message: string;
}

export interface RecoveryEventPayload {
  readonly walletId?: string;
  readonly code: string;
  readonly message: string;
  readonly severity?: 'warning' | 'error';
  readonly operation?: string;
  readonly attempt?: number;
  readonly maximumAttempts?: number;
  readonly delayMs?: number;
  readonly errorType?: string;
  readonly classification?: BeeFailureClassification | null;
  readonly messageHash?: string | null;
}

export interface RewardRecordedEventPayload {
  readonly rewardId: string;
  readonly walletId: string;
  readonly amount: string;
  readonly unit: string;
  readonly sessionId: string | null;
  readonly generation: number | null;
}

export interface BeeSdkEventPayload {
  readonly version: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

export interface BeeWalletConnectionEventPayload {
  readonly state: 'awaiting-approval' | 'connected' | 'failed';
  readonly walletName: string | null;
  readonly walletAddress: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

export interface BeeMiningOperationEventPayload {
  readonly walletId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly miniEpoch?: string | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly classification?: BeeFailureClassification | null;
  readonly messageHash?: string | null;
}

export interface BeeSettlementOutcomeEventPayload
  extends BeeMiningOperationEventPayload {
  readonly outcome:
    | 'accepted'
    | 'completed'
    | 'rejected'
    | 'timeout'
    | 'native_error'
    | 'unknown';
  readonly submissionReference: string | null;
  readonly confirmedTaps: number | null;
}

export type WalletMiningTelemetryStage =
  | 'NATIVE_PREPARE_START'
  | 'NATIVE_PREPARE_RESULT'
  | 'BASELINE_TAP_SUM_READ'
  | 'NATIVE_MINING_START'
  | 'FIRST_TAP'
  | 'TAP_70'
  | 'MINER_STOP_START'
  | 'MINER_STOP_RETURN'
  | 'COMPUTATION_COMPLETED'
  | 'ROOT_CALLBACK'
  | 'PROOF_CALLBACK'
  | 'TERMINAL'
  | 'LATEST_TAP_SUM_READ'
  | 'REWARD_START'
  | 'REWARD_RESULT'
  | 'NATIVE_FREE_START'
  | 'NATIVE_FREE_RESULT'
  | 'PRODUCT_SESSION_CLOSE';

/** Allowlisted new-worker evidence. Raw native callback data is never carried. */
export interface WalletMiningWorkerDiagnosticEventPayload {
  readonly engine: 'NEW_WALLET_WORKER';
  readonly stage: WalletMiningTelemetryStage | null;
  readonly walletId: string;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly miniEpoch: string | null;
  readonly workerState: string;
  readonly queuedLocalTaps: number;
  readonly nativeComputedTaps: number;
  readonly computationCompletedTaps: number | null;
  readonly baselineTapSum: string | null;
  readonly latestTapSum: string | null;
  readonly confirmedTapDelta: string | null;
  readonly submissionStaggerMs: number | null;
  readonly callbackAction: string | null;
  readonly callbackSequence: number | null;
  readonly errorPresent: boolean | null;
  readonly nativeTopLevelMessage: string | null;
  readonly tvmCode: number | null;
  readonly tvmCodeName: string | null;
  readonly kitModule: string | null;
  readonly kitCode: number | string | null;
  readonly serverCode: number | string | null;
  readonly nodeExtensionCode: string | null;
  readonly nodeExtensionMessage: string | null;
  readonly tvmExitCode: number | null;
  readonly transactionAborted: boolean | null;
  readonly messageHash: string | null;
  readonly transactionHash: string | null;
  readonly accountId: string | null;
  readonly dappId: string | null;
  readonly threadId: string | null;
  readonly producerFingerprint: string | null;
  readonly coreVersion: string | null;
  readonly failureStage: string | null;
  readonly errorCategory: string | null;
  readonly terminalOutcome: string | null;
  readonly rewardStatus: string | null;
  readonly disposalStatus: string | null;
  readonly quarantined: boolean;
  readonly stale: boolean;
  readonly observationDerived: boolean;
}

export interface BeeGraphqlPoolTimeoutEventPayload {
  readonly walletId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly operation: 'miner-events-query';
  readonly code: string | null;
  readonly category: 'graphql-pool-timeout';
}

export type BeeSettlementTraceStage =
  | 'prepare-started'
  | 'native-mining-started'
  | 'adapter-settlement-started'
  | 'submission-stagger-selected'
  | 'miner-stop-started'
  | 'miner-stop-returned'
  | 'miner-stop-threw'
  | 'native-callback'
  | 'latest-tap-sum-read'
  | 'terminal-result'
  | 'reward-sync-entered'
  | 'dispose-requested'
  | 'native-free-started'
  | 'native-free-completed'
  | 'native-free-failed'
  | 'computation_completed'
  | 'root_prepare_started'
  | 'root_message_submit_started'
  | 'root_message_submit_returned'
  | 'root_wait_started'
  | 'root_event_observed'
  | 'root_success'
  | 'root_failure'
  | 'terminal';

export type BeeRootFailureCategory =
  | 'NETWORK'
  | 'GRAPHQL'
  | 'MESSAGE_BUILD'
  | 'MESSAGE_SEND'
  | 'QUEUE'
  | 'CONTRACT_EXECUTION'
  | 'PROOF'
  | 'TIMEOUT'
  | 'UNKNOWN';

export type BeeSubmissionFailureStage =
  | 'ROOT_SUBMIT'
  | 'PROOF_SUBMIT'
  | 'EVENT_QUERY'
  | 'UNKNOWN_NATIVE_STAGE';

/**
 * Development-only settlement timing evidence. Values are deliberately
 * limited to public lifecycle identity, counters and timing metadata.
 */
export interface BeeSettlementTraceEventPayload {
  readonly walletId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly stage: BeeSettlementTraceStage;
  readonly completedTapCount: number | null;
  readonly baselineTapSum: string | null;
  readonly latestTapSum: string | null;
  readonly submissionStaggerMs: number | null;
  readonly callbackAction: string | null;
  readonly callbackStatus: string | null;
  readonly callbackErrorPresent: boolean | null;
  readonly errorPresent: boolean | null;
  readonly callbackSequence: number | null;
  readonly submitSessionProofCount: number | null;
  readonly terminalStatus: BeeSettlementOutcomeEventPayload['outcome'] | null;
  readonly classification: BeeFailureClassification | null;
  readonly stopToCallbackMs: number | null;
  readonly settlementToTerminalMs: number | null;
  readonly errorCode: string | null;
  readonly errorCategory: BeeRootFailureCategory | null;
  readonly nativeTopLevelMessage: string | null;
  readonly tvmCode: number | null;
  readonly tvmCodeName: string | null;
  readonly kitModule: string | null;
  readonly kitCode: number | null;
  readonly serverCode: number | null;
  readonly nodeExtensionCode: string | null;
  readonly nodeExtensionMessage: string | null;
  readonly tvmExitCode: number | null;
  readonly transactionAborted: boolean | null;
  readonly messageHash: string | null;
  readonly transactionHash: string | null;
  readonly accountId: string | null;
  readonly dappId: string | null;
  readonly threadId: string | null;
  readonly producerFingerprint: string | null;
  readonly coreVersion: string | null;
  readonly failureStage: BeeSubmissionFailureStage | null;
  readonly durationMs: number | null;
}

export interface BeeRewardSyncEventPayload {
  readonly walletId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly confirmedRewardCount: number;
  readonly code: string | null;
  readonly message: string | null;
}

export interface CoreEventPayloads {
  readonly 'wallet-runtime-created': WalletRuntimeCreatedEventPayload;
  readonly 'wallet-runtime-start-stage': WalletRuntimeStartStageEventPayload;
  readonly 'runtime-error': RuntimeErrorEventPayload;
  readonly 'session-created': SessionEventPayload;
  readonly 'session-started': SessionEventPayload;
  readonly 'session-finished': SessionEventPayload;
  readonly 'tap-progress': TapProgressEventPayload;
  readonly 'tap-execution-failed': TapExecutionFailedEventPayload;
  readonly 'boundary-reached': SessionEventPayload;
  readonly 'settlement-started': SessionEventPayload;
  readonly 'settlement-completed': SessionEventPayload;
  readonly 'epoch-changed': EpochChangedEventPayload;
  readonly warning: RecoveryEventPayload;
  readonly 'recovery-started': RecoveryEventPayload;
  readonly 'recovery-completed': RecoveryEventPayload;
  readonly 'reward-sync-started': SessionEventPayload;
  readonly 'reward-received': RewardRecordedEventPayload;
  readonly 'reward-recorded': RewardRecordedEventPayload;
  readonly 'bee-sdk-ready': BeeSdkEventPayload;
  readonly 'bee-sdk-failed': BeeSdkEventPayload;
  readonly 'bee-wallet-connection-started': BeeWalletConnectionEventPayload;
  readonly 'bee-wallet-connected': BeeWalletConnectionEventPayload;
  readonly 'bee-wallet-connection-failed': BeeWalletConnectionEventPayload;
  readonly 'bee-mining-started': BeeMiningOperationEventPayload;
  readonly 'bee-mining-failed': BeeMiningOperationEventPayload;
  readonly 'bee-graphql-pool-timeout': BeeGraphqlPoolTimeoutEventPayload;
  readonly 'bee-settlement-trace': BeeSettlementTraceEventPayload;
  readonly 'bee-settlement-outcome': BeeSettlementOutcomeEventPayload;
  readonly 'bee-reward-sync-completed': BeeRewardSyncEventPayload;
  readonly 'wallet-mining-worker-diagnostic': WalletMiningWorkerDiagnosticEventPayload;
}

export type CoreEvent<TType extends CoreEventType = CoreEventType> = {
  [Type in TType]: DomainEvent<Type, CoreEventPayloads[Type]>;
}[TType];

export type CoreEventListener<TType extends CoreEventType> = (
  event: CoreEvent<TType>,
) => void;

export interface EventPublisher {
  publish<TType extends CoreEventType>(event: CoreEvent<TType>): void;
}

export interface EventObserver {
  subscribe<TType extends CoreEventType>(
    type: TType,
    listener: CoreEventListener<TType>,
  ): () => void;
}

type AnyCoreEventListener = (event: CoreEvent) => void;
export type CoreEventListenerErrorHandler = (
  error: unknown,
  event: CoreEvent,
) => void;

export class CoreEventEmitter implements EventPublisher, EventObserver {
  private readonly listeners = new Map<CoreEventType, Set<AnyCoreEventListener>>();
  private reportingListenerError = false;

  constructor(
    private readonly onListenerError: CoreEventListenerErrorHandler = () =>
      undefined,
  ) {}

  publish<TType extends CoreEventType>(event: CoreEvent<TType>): void {
    const listeners = this.listeners.get(event.type);

    if (!listeners) {
      return;
    }

    for (const listener of [...listeners]) {
      try {
        listener(event as CoreEvent);
      } catch (error) {
        if (this.reportingListenerError) {
          continue;
        }

        this.reportingListenerError = true;
        try {
          this.onListenerError(error, event as CoreEvent);
        } catch {
          // Error reporting is isolated from event delivery and never emits a
          // second Core event implicitly.
        } finally {
          this.reportingListenerError = false;
        }
      }
    }
  }

  subscribe<TType extends CoreEventType>(
    type: TType,
    listener: CoreEventListener<TType>,
  ): () => void {
    const listeners = this.listeners.get(type) ?? new Set<AnyCoreEventListener>();
    const storedListener = listener as AnyCoreEventListener;

    listeners.add(storedListener);
    this.listeners.set(type, listeners);

    return () => {
      listeners.delete(storedListener);

      if (listeners.size === 0) {
        this.listeners.delete(type);
      }
    };
  }
}
