import { describe, expect, it, vi } from 'vitest';
import { CoreEventEmitter } from '../shared/events';
import type { RewardRecord } from '../shared/rewards';
import {
  REWARD_HOT_HISTORY_LIMIT_PER_WALLET,
  RewardLedger,
} from './RewardLedger';

function reward(
  id: string,
  walletId: string,
  value: string,
): RewardRecord {
  return {
    id,
    walletId,
    amount: { value, unit: 'ACKI' },
    recordedAt: Date.parse('2026-08-04T14:00:00.000Z'),
    sessionId: `${walletId}-session`,
    generation: 1,
  };
}

describe('RewardLedger', () => {
  it('keeps reward ownership separated by wallet context', async () => {
    const ledger = new RewardLedger();
    await ledger.recordReward(reward('reward-a', 'wallet-a', '12'));
    await ledger.recordReward(reward('reward-b', 'wallet-b', '7'));

    expect(ledger.rewardsForWallet('wallet-a')).toEqual([
      reward('reward-a', 'wallet-a', '12'),
    ]);
    expect(ledger.rewardsForWallet('wallet-b')).toEqual([
      reward('reward-b', 'wallet-b', '7'),
    ]);
    expect(ledger.rewardsForWallet('wallet-c')).toEqual([]);
    expect('totalRewards' in ledger).toBe(false);
  });

  it('rejects duplicate reward identity without changing wallet history', async () => {
    const ledger = new RewardLedger();
    const first = await ledger.recordReward(reward('reward-1', 'wallet-a', '12'));
    const duplicate = await ledger.recordReward(
      reward('reward-1', 'wallet-b', '99'),
    );

    expect(first).not.toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.amount)).toBe(true);
    expect(duplicate).toBeNull();
    expect(ledger.rewardsForWallet('wallet-a')).toHaveLength(1);
    expect(ledger.rewardsForWallet('wallet-b')).toHaveLength(0);
  });

  it('publishes a wallet-scoped reward event without lifecycle control', async () => {
    const events = new CoreEventEmitter();
    const listener = vi.fn();
    events.subscribe('reward-recorded', listener);
    const ledger = new RewardLedger(events);

    await ledger.recordReward(reward('reward-a', 'wallet-a', '12'));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toEqual({
      id: 'reward-recorded:wallet-a:reward-a',
      occurredAt: '2026-08-04T14:00:00.000Z',
      type: 'reward-recorded',
      payload: {
        rewardId: 'reward-a',
        walletId: 'wallet-a',
        amount: '12',
        unit: 'ACKI',
        sessionId: 'wallet-a-session',
        generation: 1,
      },
    });
    expect('start' in ledger).toBe(false);
    expect('stop' in ledger).toBe(false);
    expect('restart' in ledger).toBe(false);
  });

  it('persists a mining reward before publishing it for presentation', async () => {
    const calls: string[] = [];
    const events = new CoreEventEmitter();
    events.subscribe('reward-recorded', () => calls.push('event'));
    const ledger = new RewardLedger(events, [], {
      appendReward: async () => {
        calls.push('storage');
      },
    });

    await ledger.recordReward(reward('reward-a', 'wallet-a', '12'));

    expect(calls).toEqual(['storage', 'event']);
    expect(ledger.rewardsForWallet('wallet-a')).toHaveLength(1);
  });

  it('does not publish or retain a reward when persistence fails', async () => {
    const events = new CoreEventEmitter();
    const listener = vi.fn();
    events.subscribe('reward-recorded', listener);
    const ledger = new RewardLedger(events, [], {
      appendReward: async () => {
        throw new Error('Storage unavailable');
      },
    });

    await expect(
      ledger.recordReward(reward('reward-a', 'wallet-a', '12')),
    ).rejects.toThrow('Storage unavailable');
    expect(ledger.rewardsForWallet('wallet-a')).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps only a bounded hot history while persisting every new reward', async () => {
    const appendReward = vi.fn(async () => undefined);
    const ledger = new RewardLedger(new CoreEventEmitter(), [], { appendReward });

    for (
      let index = 0;
      index < REWARD_HOT_HISTORY_LIMIT_PER_WALLET + 2;
      index += 1
    ) {
      await ledger.recordReward(
        reward(`reward-${index}`, 'wallet-a', String(index)),
      );
    }
    await ledger.recordReward(reward('wallet-b-reward', 'wallet-b', '7'));

    expect(appendReward).toHaveBeenCalledTimes(
      REWARD_HOT_HISTORY_LIMIT_PER_WALLET + 3,
    );
    expect(ledger.rewardsForWallet('wallet-a')).toHaveLength(
      REWARD_HOT_HISTORY_LIMIT_PER_WALLET,
    );
    expect(ledger.rewardsForWallet('wallet-a')[0]?.id).toBe('reward-2');
    expect(ledger.reward('reward-0')).toBeNull();
    expect(ledger.rewardsForWallet('wallet-b')).toHaveLength(1);
  });

  it('forgets only one wallet and ignores its in-flight stale persistence result', async () => {
    let release: () => void = () => {
      throw new Error('Persistence gate was not initialized.');
    };
    const appendReward = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const ledger = new RewardLedger(
      new CoreEventEmitter(),
      [reward('reward-b', 'wallet-b', '7')],
      { appendReward },
    );
    const pending = ledger.recordReward(reward('reward-a', 'wallet-a', '3'));
    await Promise.resolve();

    ledger.forgetWallet('wallet-a');
    release();

    await expect(pending).resolves.toBeNull();
    expect(ledger.rewardsForWallet('wallet-a')).toEqual([]);
    expect(ledger.rewardsForWallet('wallet-b')).toHaveLength(1);
  });

  it('releases wallet tombstones after every older write reaches a terminal state', async () => {
    const releases = new Map<string, () => void>();
    const ledger = new RewardLedger(new CoreEventEmitter(), [], {
      appendReward: (entry) =>
        new Promise<void>((resolve) => {
          releases.set(entry.walletId, resolve);
        }),
    });
    const pending = Array.from({ length: 64 }, (_, index) => {
      const walletId = `wallet-${index}`;
      const operation = ledger.recordReward(
        reward(`reward-${index}`, walletId, '1'),
      );
      ledger.forgetWallet(walletId);
      return operation;
    });
    const tracking = ledger as unknown as {
      walletVersions: Map<string, number>;
      pendingWritesByWallet: Map<string, number>;
    };

    expect(tracking.walletVersions.size).toBe(64);
    expect(tracking.pendingWritesByWallet.size).toBe(64);
    for (const release of releases.values()) {
      release();
    }

    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 64 }, () => null),
    );
    expect(tracking.walletVersions.size).toBe(0);
    expect(tracking.pendingWritesByWallet.size).toBe(0);
    for (let index = 0; index < 256; index += 1) {
      ledger.forgetWallet(`unused-wallet-${index}`);
    }
    expect(tracking.walletVersions.size).toBe(0);
  });
});
