import type {
  BoundaryTransitionStatus,
  MinerRuntimeStatus,
  RecoveryIssue,
  RecoveryState,
  SettlementState,
  MiningExecutionStatus,
  TapSchedulingStatus,
} from '../shared/miningRuntime';
import type { SessionSettlementOutcome } from './runtimeAnalytics';

export interface MiningTapProgressPresentation {
  readonly completedTapCount: number;
  readonly targetTapCount: number;
  readonly remainingTapCount: number;
}

export interface MiningExecutionPresentation {
  readonly sessionId: string;
  readonly generation: number;
  readonly status: MiningExecutionStatus;
  readonly sessionProgressPercent: number;
  readonly tapProgress: MiningTapProgressPresentation;
  readonly approximateIntervalMs: number;
  readonly jitterEnabled: boolean;
  readonly lastExecutionId: string | null;
}

export interface RuntimeHealthIssuePresentation {
  readonly occurredAt: string;
  readonly code: string | null;
  readonly message: string | null;
}

export interface RuntimeHealthPresentation {
  readonly uptimeMs: number | null;
  readonly lastError: RuntimeHealthIssuePresentation | null;
}

export type EpochPresentationStatus = 'synchronizing' | 'live' | 'waiting';

export interface EpochWindowPresentation {
  readonly status: EpochPresentationStatus;
  readonly id: string | null;
  readonly startBlock: string | null;
  readonly endBlock: string | null;
  readonly currentBlock: string | null;
  readonly progressPercent: number;
  readonly elapsedMs: number | null;
  readonly remainingMs: number | null;
  readonly remainingBlocks: number | null;
  readonly elapsedLabel: string;
  readonly remainingLabel: string;
  readonly startedAt: string | null;
  readonly expectedEndAt: string | null;
  readonly expectedEndLabel: string;
}

export interface EpochPresentation {
  readonly miniEpoch: Readonly<EpochWindowPresentation>;
  readonly mainEpoch: Readonly<EpochWindowPresentation>;
}

export interface RuntimePresentationState {
  readonly runtimeStatus: MinerRuntimeStatus;
  readonly miningExecution: MiningExecutionPresentation | null;
  readonly schedulerStatus: TapSchedulingStatus;
  readonly settlementStatus: SettlementState;
  readonly settlementOutcome?: SessionSettlementOutcome | null;
  readonly settlementSessionId?: string | null;
  readonly settlementGeneration?: number | null;
  readonly boundaryStatus: BoundaryTransitionStatus;
  readonly recoveryStatus: RecoveryState;
  readonly recoveryIssue: Readonly<RecoveryIssue> | null;
  readonly epochs: Readonly<EpochPresentation>;
  readonly health: RuntimeHealthPresentation;
}

export type WalletRuntimePresentationStates = ReadonlyMap<
  string,
  Readonly<RuntimePresentationState>
>;
