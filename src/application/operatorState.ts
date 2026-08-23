import type {
  RuntimeDiagnosticCategory,
  RuntimeDiagnosticLevel,
} from './RuntimeDiagnostics';
import type { RuntimePresentationState } from './runtimeState';
import type {
  MiningPreflightResult,
  TapPacingReadinessStatus,
} from './RuntimePreflight';
import type { ProductionConfigurationSnapshot } from './productionConfiguration';
import type {
  BeeNativeSessionPhase,
  BeeSdkGatewayStatus,
} from '../services/bee/contracts';
import type { WalletConnectionPresentation } from './walletState';
import type { CanonicalChainStateSnapshot } from './CanonicalChainState';
import type { GlobalMiningUptimeSnapshot } from './GlobalMiningUptime';

export interface OperatorDiagnosticSummary {
  readonly id: string;
  readonly timestamp: string;
  readonly eventType: string;
  readonly level: RuntimeDiagnosticLevel;
  readonly category: RuntimeDiagnosticCategory;
  readonly walletId?: string | null;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly miniEpoch: string | null;
  readonly code: string | null;
}

export interface RewardSynchronizationSnapshot {
  readonly status: 'idle' | 'synchronizing' | 'completed' | 'failed';
  readonly walletId: string | null;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly confirmedRewardCount: number;
  readonly code: string | null;
}

export type TimedMiningStatus =
  | 'inactive'
  | 'running'
  | 'stopping'
  | 'failed';

export interface TimedMiningSnapshot {
  readonly status: TimedMiningStatus;
  readonly startedAt: number | null;
  readonly durationMs: number | null;
  readonly targetEndAt: number | null;
  readonly shutdownAfterCompletion: boolean;
  readonly failureCode:
    | 'terminal-state-timeout'
    | 'computer-shutdown-unsupported'
    | 'computer-shutdown-failed'
    | null;
}

export type MainEpochStartStatus =
  | 'inactive'
  | 'waiting-for-main-epoch'
  | 'waiting-for-delay'
  | 'starting'
  | 'completed'
  | 'failed';

export interface MainEpochStartSnapshot {
  readonly status: MainEpochStartStatus;
  readonly armedAt: number | null;
  readonly baselineMainEpoch: string | null;
  readonly delayHours: number | null;
  readonly detectedMainEpoch: string | null;
  readonly epochDetectedAt: number | null;
  readonly targetStartAt: number | null;
  readonly failureCode: 'start-failed' | null;
}

export interface MinerOperatorState {
  readonly configuration: Readonly<ProductionConfigurationSnapshot>;
  readonly beeSdk: Readonly<{
    status: BeeSdkGatewayStatus;
    version: string | null;
    failureCode: string | null;
  }>;
  readonly selectedWalletId: string | null;
  readonly walletReadiness: Readonly<{
    registered: boolean;
    onboardingStatus: string | null;
    connectionReferencePresent: boolean;
    miningCredentialReferencePresent: boolean;
  }>;
  readonly walletConnection: Readonly<WalletConnectionPresentation> | null;
  readonly runtime: Readonly<RuntimePresentationState>;
  readonly nativeSession: Readonly<{
    walletId: string;
    sessionId: string;
    generation: number;
    phase: BeeNativeSessionPhase;
  }> | null;
  readonly rewardSynchronization: Readonly<RewardSynchronizationSnapshot>;
  readonly tapPacingStatus: TapPacingReadinessStatus;
  readonly canonicalChainState: Readonly<CanonicalChainStateSnapshot>;
  readonly globalMiningUptime: Readonly<GlobalMiningUptimeSnapshot>;
  readonly timedMining: Readonly<TimedMiningSnapshot>;
  readonly mainEpochStart: Readonly<MainEpochStartSnapshot>;
  readonly diagnostics: readonly Readonly<OperatorDiagnosticSummary>[];
  readonly blockers: readonly Readonly<MiningPreflightResult>[];
}
