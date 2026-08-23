import type { WalletId } from './wallets';

export type RewardId = string;

export interface RewardAmount {
  readonly value: string;
  readonly unit: string;
}

export interface RewardRecord {
  readonly id: RewardId;
  readonly walletId: WalletId;
  readonly amount: Readonly<RewardAmount>;
  readonly recordedAt: number;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly kind?: 'confirmed-reward' | 'locked-nackl-delta';
  readonly lockedNacklBeforeRaw?: string | null;
  readonly lockedNacklAfterRaw?: string | null;
  readonly detectionSource?:
    | 'settlement'
    | 'reward-sync'
    | 'epoch'
    | 'manual'
    | 'monitoring';
}

export interface RewardLedgerContract {
  recordReward(
    reward: RewardRecord,
  ): Promise<Readonly<RewardRecord> | null>;
  reward(rewardId: RewardId): Readonly<RewardRecord> | null;
  rewardsForWallet(walletId: WalletId): readonly Readonly<RewardRecord>[];
  /** Releases only the hot-memory projection for a removed wallet. */
  forgetWallet?(walletId: WalletId): void;
}
