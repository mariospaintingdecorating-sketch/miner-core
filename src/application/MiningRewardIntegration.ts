import type { RewardLedgerContract, RewardRecord } from '../shared/rewards';
import type { CoreEvent, EventPublisher } from '../shared/events';
import type { WalletRegistryContract } from '../shared/wallets';

export class MiningRewardIntegration {
  constructor(
    private readonly walletRegistry: Pick<WalletRegistryContract, 'wallet'>,
    private readonly rewardLedger: Pick<RewardLedgerContract, 'recordReward'>,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async recordMiningResult(
    reward: RewardRecord,
  ): Promise<Readonly<RewardRecord> | null> {
    if (!this.walletRegistry.wallet(reward.walletId)) {
      throw new Error(`Reward wallet ${reward.walletId} is not registered.`);
    }

    this.#publishRewardReceived(reward);
    return this.rewardLedger.recordReward(reward);
  }

  #publishRewardReceived(reward: RewardRecord): void {
    const event: CoreEvent<'reward-received'> = {
      id: `reward-received:${reward.walletId}:${reward.id}`,
      occurredAt: new Date(reward.recordedAt).toISOString(),
      type: 'reward-received',
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
      // Notifications cannot control durable reward recording.
    }
  }
}
