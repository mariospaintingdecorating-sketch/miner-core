import type {
  WalletOnboardingStatus,
  WalletStatus,
} from '../shared/wallets';
import type {
  MinerRuntimeStatus,
  SettlementState,
  TapSchedulingStatus,
} from '../shared/miningRuntime';
import type {
  WalletBalanceSnapshot,
  WalletRecoveryPresentation,
  WalletRewardDelta,
} from './runtimeAnalytics';

export type WalletConnectionPhase =
  | 'disconnected'
  | 'awaiting-approval'
  | 'connected'
  | 'failed';

export type WalletConnectionReasonCode =
  | 'wallet-approved'
  | 'mining-credential-approval-pending'
  | 'mining-credential-ready'
  | 'disconnected'
  | 'state-refreshed'
  | 'wallet-not-found'
  | 'wallet-not-selected'
  | 'production-configuration-missing'
  | 'production-configuration-invalid'
  | 'secure-storage-unavailable'
  | 'wallet-connection-unavailable'
  | 'wallet-operation-conflict'
  | 'wallet-has-active-session'
  | 'wallet-approval-required'
  | 'wallet-already-connected'
  | 'wallet-state-persistence-failed'
  | 'wallet-connection-start-failed'
  | 'wallet-approval-failed'
  | 'wallet-hello-read-failed'
  | 'mining-credential-preparation-failed'
  | 'mining-credential-propagation-failed'
  | 'wallet-disconnect-failed'
  | 'wallet-state-refresh-failed'
  | 'wallet-operation-stale'
  | 'application-disposed';

export interface WalletApprovalPresentation {
  readonly deepLink: string;
  readonly expiresAt: number;
  readonly waiting: true;
}

export interface WalletConnectionCommandResult {
  readonly accepted: boolean;
  readonly walletId: string;
  readonly reasonCode: WalletConnectionReasonCode;
  readonly message: string;
  readonly connection: Readonly<WalletConnectionPresentation> | null;
  readonly approval: Readonly<WalletApprovalPresentation> | null;
}

export interface WalletSecureState {
  readonly connectionStateStored: boolean | null;
  readonly miningCredentialStored: boolean | null;
}

export type WalletConnectionOperationStep =
  | 'begin-connection'
  | 'prepare-mining-credential'
  | 'verify-mining-credential'
  | 'disconnect'
  | 'refresh-state';

export type WalletConnectionAvailability =
  | 'available'
  | 'configuration-missing'
  | 'configuration-invalid'
  | 'secure-storage-unavailable'
  | 'adapter-unavailable'
  | 'application-disposed';

export interface WalletConnectionPresentation {
  /** Complete public onboarding state owned by WalletRegistry. */
  readonly onboardingStatus: WalletOnboardingStatus;
  /** Existing UI projection; it is derived from onboardingStatus. */
  readonly phase: WalletConnectionPhase;
  readonly availability: WalletConnectionAvailability;
  readonly approvalPending: boolean;
  /** Transient approval data; never persisted with wallet state. */
  readonly approval: Readonly<WalletApprovalPresentation> | null;
  readonly connectionStateStored: boolean | null;
  readonly miningCredentialStored: boolean | null;
  readonly miningReady: boolean;
  readonly operationPending: boolean;
  readonly operationStep: WalletConnectionOperationStep | null;
  readonly lastFailureCode: string | null;
}

export interface WalletRewardPresentation {
  readonly id: string;
  readonly amountLabel: string;
  readonly recordedAtLabel: string;
  readonly sessionId: string | null;
  readonly generation: number | null;
}

export interface WalletPresentation {
  readonly id: string;
  readonly name: string;
  readonly status: WalletStatus;
  readonly walletAddress: string | null;
  readonly mamaBoardLevel: number | null;
  /** Compatibility projection of `connection.phase`; both derive from WalletRegistry. */
  readonly connectionStatus: WalletConnectionPhase;
  readonly connection: Readonly<WalletConnectionPresentation>;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly runtimeStatus: MinerRuntimeStatus;
  readonly schedulerStatus: TapSchedulingStatus;
  readonly settlementStatus: SettlementState;
  readonly progressPercent: number | null;
  readonly completedTaps: number | null;
  readonly tapTarget: number | null;
  readonly latestReward: WalletRewardPresentation | null;
  readonly balance: Readonly<WalletBalanceSnapshot> | null;
  readonly recovery: Readonly<WalletRecoveryPresentation>;
  readonly latestMiningReward: Readonly<WalletRewardDelta> | null;
  readonly miningRewards: readonly Readonly<WalletRewardDelta>[];
}
