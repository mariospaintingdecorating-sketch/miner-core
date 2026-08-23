import { describe, expect, it, vi } from 'vitest';
import { CoreEventEmitter } from '../shared/events';
import type { RewardRecord } from '../shared/rewards';
import { MiningRewardIntegration } from './MiningRewardIntegration';
import { RewardLedger } from './RewardLedger';
import { WalletRegistry } from './WalletRegistry';

const reward: RewardRecord = {
  id: 'reward-a',
  walletId: 'wallet-a',
  amount: { value: '12', unit: 'ACKI' },
  recordedAt: Date.parse('2026-08-04T14:00:00.000Z'),
  sessionId: 'session-a',
  generation: 2,
};

describe('MiningRewardIntegration', () => {
  it('announces a concrete mining result before recording it in its wallet ledger', async () => {
    const calls: string[] = [];
    const events = new CoreEventEmitter();
    events.subscribe('reward-received', () => calls.push('reward-event'));
    const ledger = new RewardLedger(events, [], {
      appendReward: async () => {
        calls.push('storage');
      },
    });
    events.subscribe('reward-recorded', () => calls.push('recorded-event'));
    const integration = new MiningRewardIntegration(
      new WalletRegistry([{ id: 'wallet-a', name: 'Alpha' }]),
      ledger,
      events,
    );

    await integration.recordMiningResult(reward);

    expect(calls).toEqual([
      'reward-event',
      'storage',
      'recorded-event',
    ]);
    expect(ledger.rewardsForWallet('wallet-a')).toEqual([reward]);
  });

  it('rejects an unregistered wallet without recording or publishing', async () => {
    const events = new CoreEventEmitter();
    const listener = vi.fn();
    events.subscribe('reward-received', listener);
    const recordReward = vi.fn(async () => reward);
    const integration = new MiningRewardIntegration(
      new WalletRegistry(),
      { recordReward },
      events,
    );

    await expect(integration.recordMiningResult(reward)).rejects.toThrow(
      'Reward wallet wallet-a is not registered',
    );
    expect(recordReward).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect('startMining' in integration).toBe(false);
  });
});
