export type MinerRuntimeStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'waiting'
  | 'disposed';

export type TapSchedulingStatus = 'idle' | 'running' | 'stopped';
export type SettlementState = 'idle' | 'pending' | 'completed';
export type BoundaryTransitionStatus = 'idle' | 'transitioning' | 'completed';
export type RecoveryState = 'idle' | 'pending' | 'completed';
export type MiningExecutionStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'stopped';

export interface RecoveryIssue {
  readonly code: string;
  readonly message: string;
  readonly severity?: 'warning' | 'error';
}

export interface MiningEpochSnapshot {
  readonly status: 'not-configured' | 'synchronizing' | 'live';
  readonly miniEpochStart: string | null;
  readonly miniEpochRemainingMs: number | null;
}

export type MiningEpochListener = () => void;

export interface MiningEpochSourceContract {
  snapshot(): Readonly<MiningEpochSnapshot>;
  synchronize(): Promise<Readonly<MiningEpochSnapshot>>;
  subscribe(listener: MiningEpochListener): () => void;
}

export type SessionId = string;
export type SessionGeneration = number;
export type TapExecutionId = string;

export interface TapExecutionFailure {
  readonly code: string;
  readonly message: string;
}
