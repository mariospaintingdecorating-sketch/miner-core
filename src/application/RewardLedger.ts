import type { RewardId, RewardLedgerContract, RewardRecord } from '../shared/rewards';
import type { CoreEvent, EventPublisher } from '../shared/events';
import { CoreEventEmitter } from '../shared/events';
import type { WalletId } from '../shared/wallets';
import type { RewardHistoryStorageContract } from '../storage/contracts';

export const REWARD_HOT_HISTORY_LIMIT_PER_WALLET = 2_000;

export class RewardLedger implements RewardLedgerContract {
  private readonly rewardsById = new Map<RewardId, Readonly<RewardRecord>>();
  private readonly rewardsByWallet = new Map<
    WalletId,
    readonly Readonly<RewardRecord>[]
  >();
  private readonly pendingRewardIds = new Set<RewardId>();
  private readonly walletVersions = new Map<WalletId, number>();
  private readonly pendingWritesByWallet = new Map<WalletId, number>();

  constructor(
    private readonly eventPublisher: EventPublisher = new CoreEventEmitter(),
    initialRewards: readonly RewardRecord[] = [],
    private readonly storage?: Pick<RewardHistoryStorageContract, 'appendReward'>,
  ) {
    const hydratedByWallet = new Map<
      WalletId,
      Readonly<RewardRecord>[]
    >();
    const retainedById = new Map<RewardId, Readonly<RewardRecord>>();

    for (const reward of initialRewards) {
      const storedReward = this.#rewardSnapshot(reward);
      if (retainedById.has(storedReward.id)) {
        continue;
      }
      const walletRewards = hydratedByWallet.get(storedReward.walletId) ?? [];
      walletRewards.push(storedReward);
      retainedById.set(storedReward.id, storedReward);
      if (walletRewards.length > REWARD_HOT_HISTORY_LIMIT_PER_WALLET) {
        const removed = walletRewards.shift();
        if (removed) {
          retainedById.delete(removed.id);
        }
      }
      hydratedByWallet.set(storedReward.walletId, walletRewards);
    }

    for (const [walletId, rewards] of hydratedByWallet) {
      this.rewardsByWallet.set(walletId, Object.freeze([...rewards]));
    }
    for (const [rewardId, reward] of retainedById) {
      this.rewardsById.set(rewardId, reward);
    }
  }

  async recordReward(
    reward: RewardRecord,
  ): Promise<Readonly<RewardRecord> | null> {
    if (this.rewardsById.has(reward.id) || this.pendingRewardIds.has(reward.id)) {
      return null;
    }

    const storedReward = this.#rewardSnapshot(reward);
    const walletVersion = this.walletVersions.get(storedReward.walletId) ?? 0;
    this.pendingRewardIds.add(storedReward.id);
    this.pendingWritesByWallet.set(
      storedReward.walletId,
      (this.pendingWritesByWallet.get(storedReward.walletId) ?? 0) + 1,
    );

    try {
      await this.storage?.appendReward(storedReward);
      if (
        (this.walletVersions.get(storedReward.walletId) ?? 0) !== walletVersion
      ) {
        return null;
      }
      this.#storeReward(storedReward);
      this.#publishRewardRecorded(storedReward);
      return storedReward;
    } finally {
      this.pendingRewardIds.delete(storedReward.id);
      const pendingWrites =
        (this.pendingWritesByWallet.get(storedReward.walletId) ?? 1) - 1;
      if (pendingWrites > 0) {
        this.pendingWritesByWallet.set(storedReward.walletId, pendingWrites);
      } else {
        this.pendingWritesByWallet.delete(storedReward.walletId);
        this.walletVersions.delete(storedReward.walletId);
      }
    }
  }

  #rewardSnapshot(reward: RewardRecord): Readonly<RewardRecord> {
    if (
      reward.id.trim().length === 0 ||
      reward.walletId.trim().length === 0 ||
      reward.amount.value.trim().length === 0 ||
      reward.amount.unit.trim().length === 0 ||
      !Number.isFinite(reward.recordedAt) ||
      Number.isNaN(new Date(reward.recordedAt).getTime())
    ) {
      throw new TypeError('Reward identity, wallet, amount, and timestamp are required.');
    }

    return Object.freeze({
      ...reward,
      amount: Object.freeze({ ...reward.amount }),
    });
  }

  #storeReward(storedReward: Readonly<RewardRecord>): void {
    const previous = this.rewardsByWallet.get(storedReward.walletId) ?? [];
    const next = [...previous, storedReward].slice(
      -REWARD_HOT_HISTORY_LIMIT_PER_WALLET,
    );
    const retainedIds = new Set(next.map((reward) => reward.id));

    for (const reward of previous) {
      if (!retainedIds.has(reward.id)) {
        this.rewardsById.delete(reward.id);
      }
    }

    this.rewardsById.set(storedReward.id, storedReward);
    this.rewardsByWallet.set(
      storedReward.walletId,
      Object.freeze(next),
    );
  }

  reward(rewardId: RewardId): Readonly<RewardRecord> | null {
    return this.rewardsById.get(rewardId) ?? null;
  }

  rewardsForWallet(walletId: WalletId): readonly Readonly<RewardRecord>[] {
    return this.rewardsByWallet.get(walletId) ?? Object.freeze([]);
  }

  forgetWallet(walletId: WalletId): void {
    this.walletVersions.set(walletId, (this.walletVersions.get(walletId) ?? 0) + 1);
    const rewards = this.rewardsByWallet.get(walletId) ?? [];
    for (const reward of rewards) {
      this.rewardsById.delete(reward.id);
      this.pendingRewardIds.delete(reward.id);
    }
    this.rewardsByWallet.delete(walletId);
    if (!this.pendingWritesByWallet.has(walletId)) {
      this.walletVersions.delete(walletId);
    }
  }

  #publishRewardRecorded(reward: Readonly<RewardRecord>): void {
    const event: CoreEvent<'reward-recorded'> = {
      id: `reward-recorded:${reward.walletId}:${reward.id}`,
      occurredAt: new Date(reward.recordedAt).toISOString(),
      type: 'reward-recorded',
      payload: {
        rewardId: reward.id,
        walletId: reward.walletId,
        amount: reward.amount.value,
        unit: reward.amount.unit,
        sessionId: reward.sessionId,
        generation: reward.generation,
      },
    };

    try {
      this.eventPublisher.publish(event);
    } catch {
      // Reward notifications cannot control reward ownership.
    }
  }
}
