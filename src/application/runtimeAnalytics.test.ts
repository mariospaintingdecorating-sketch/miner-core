import { describe, expect, it } from 'vitest';
import {
  aggregateDailyNacklRewardRecords,
  aggregateDailyNacklRewards,
  aggregateWalletBalances,
  formatRawAmount,
  positiveLockedNacklDelta,
  type WalletBalanceSnapshot,
} from './runtimeAnalytics';

describe('runtime financial analytics', () => {
  it('detects mining reward only from a positive locked NACKL delta', () => {
    expect(positiveLockedNacklDelta('120500000000', '121100000000')).toBe(
      '600000000',
    );
    expect(formatRawAmount('600000000')).toBe('0.6');
    expect(formatRawAmount('23450000000', 9, 2, ',')).toBe('23,45');
    expect(formatRawAmount('4567340000000', 9, 2, ',')).toBe('4567,34');
    expect(formatRawAmount('12463000', 6, 2, ',')).toBe('12,46');
    expect(positiveLockedNacklDelta('121100000000', '121100000000')).toBeNull();
    expect(positiveLockedNacklDelta('121100000000', '120500000000')).toBeNull();
  });

  it('aggregates the four wallet-scoped assets without losing integer precision', () => {
    const snapshots: readonly WalletBalanceSnapshot[] = [
      snapshot('wallet-a', '1000000000', '2000000000', '3000000', '4000000000'),
      snapshot('wallet-b', '500000000', '600000000', '700000', '800000000'),
    ];

    const overview = aggregateWalletBalances(snapshots, 2);

    expect(overview.nacklLocked).toMatchObject({
      rawTotal: '1500000000',
      formattedTotal: '1.5',
      walletCount: 2,
      status: 'fresh',
    });
    expect(overview.nacklAvailable.formattedTotal).toBe('2.6');
    expect(overview.nacklTotal).toMatchObject({
      rawTotal: '4100000000',
      formattedTotal: '4.1',
      walletCount: 2,
      status: 'fresh',
    });
    expect(overview.usdc.formattedTotal).toBe('3.7');
    expect(overview.shell.formattedTotal).toBe('4.8');
  });

  it('reports partial and error coverage instead of fabricating missing balances', () => {
    expect(aggregateWalletBalances([snapshot('wallet-a', '1', '2', '3', '4')], 2)
      .nacklLocked.status).toBe('partial');
    expect(aggregateWalletBalances([], 2).nacklLocked).toMatchObject({
      rawTotal: null,
      formattedTotal: null,
      walletCount: 0,
      status: 'error',
    });
    expect(aggregateWalletBalances([], 2).nacklTotal).toMatchObject({
      rawTotal: null,
      formattedTotal: null,
      walletCount: 0,
      status: 'error',
    });
  });

  it('aggregates wallet-scoped mining rewards into operator-local calendar days', () => {
    const daily = aggregateDailyNacklRewards(
      [
        reward('wallet-a', new Date(2026, 7, 6, 8).toISOString(), '23450000000'),
        reward('wallet-b', new Date(2026, 7, 6, 21).toISOString(), '1100000000'),
        reward('wallet-a', new Date(2026, 7, 5, 12).toISOString(), '198200000000'),
        reward('wallet-a', new Date(2026, 7, 2, 12).toISOString(), '999000000000'),
      ],
      3,
      new Date(2026, 7, 6, 23),
    );

    expect(daily).toEqual([
      { date: '2026-08-06', amountRaw: '24550000000', rewardCount: 2 },
      { date: '2026-08-05', amountRaw: '198200000000', rewardCount: 1 },
      { date: '2026-08-04', amountRaw: '0', rewardCount: 0 },
    ]);
    expect(Object.isFrozen(daily)).toBe(true);
  });

  it('moves a reward after local midnight into the new operator day', () => {
    const daily = aggregateDailyNacklRewards(
      [
        reward('wallet-a', new Date(2026, 7, 7, 23, 59).toISOString(), '10'),
        reward('wallet-a', new Date(2026, 7, 8, 0, 1).toISOString(), '20'),
      ],
      2,
      new Date(2026, 7, 8, 12),
    );

    expect(daily).toEqual([
      { date: '2026-08-08', amountRaw: '20', rewardCount: 1 },
      { date: '2026-08-07', amountRaw: '10', rewardCount: 1 },
    ]);
  });

  it('aggregates ledger records with the same local-day semantics without delta projection', () => {
    const firstDay = new Date(2026, 7, 8, 23, 59);
    const secondDay = new Date(2026, 7, 9, 0, 1);
    const daily = aggregateDailyNacklRewardRecords(
      [[
        rewardRecord('wallet-a', firstDay.getTime(), '10'),
        rewardRecord('wallet-a', secondDay.getTime(), '20'),
        {
          ...rewardRecord('wallet-a', secondDay.getTime(), '999'),
          id: 'non-mining-reward',
          kind: 'confirmed-reward',
        },
      ]],
      2,
      new Date(2026, 7, 9, 12),
    );

    expect(daily).toEqual([
      { date: '2026-08-09', amountRaw: '20', rewardCount: 1 },
      { date: '2026-08-08', amountRaw: '10', rewardCount: 1 },
    ]);
  });
});

function rewardRecord(walletId: string, recordedAt: number, value: string) {
  return {
    id: `${walletId}:${recordedAt}:${value}`,
    walletId,
    amount: { value, unit: 'NACKL' },
    recordedAt,
    sessionId: 'session',
    generation: 1,
    kind: 'locked-nackl-delta' as const,
    lockedNacklBeforeRaw: '0',
    lockedNacklAfterRaw: value,
    detectionSource: 'reward-sync' as const,
  };
}

function reward(walletId: string, detectedAt: string, amountRaw: string) {
  return {
    id: `${walletId}:${detectedAt}`,
    walletId,
    amountRaw,
    detectedAt,
    sessionId: 'session',
    generation: 1,
    lockedNacklBeforeRaw: '0',
    lockedNacklAfterRaw: amountRaw,
    observedInCurrentRun: true,
    source: 'settlement' as const,
  };
}

function snapshot(
  walletId: string,
  nacklLockedRaw: string,
  nacklAvailableRaw: string,
  usdcRaw: string,
  shellRaw: string,
): WalletBalanceSnapshot {
  return {
    walletId,
    synchronizedAt: '2026-08-06T12:00:00.000Z',
    status: 'fresh',
    errorCode: null,
    values: { nacklLockedRaw, nacklAvailableRaw, usdcRaw, shellRaw },
  };
}
