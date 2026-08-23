import { describe, expect, it, vi } from 'vitest';
import { SpacedRewardDispatchLimiter } from './SpacedRewardDispatchLimiter';

describe('SpacedRewardDispatchLimiter', () => {
  it('spaces fleet reward dispatch starts without serializing the requests', async () => {
    let now = 1_000;
    const waits: number[] = [];
    const limiter = new SpacedRewardDispatchLimiter(
      500,
      () => now,
      vi.fn(async (delayMs: number) => {
        waits.push(delayMs);
        now += delayMs;
      }),
    );

    await Promise.all([
      limiter.waitForDispatch('wallet-1', 'generation-1'),
      limiter.waitForDispatch('wallet-2', 'generation-1'),
      limiter.waitForDispatch('wallet-3', 'generation-1'),
    ]);

    expect(waits).toEqual([500, 500]);
    expect(now).toBe(2_000);
  });

  it('lets a failed wait release later dispatch slots', async () => {
    let calls = 0;
    const limiter = new SpacedRewardDispatchLimiter(
      500,
      () => 0,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('controlled wait failure');
      },
    );

    await expect(limiter.waitForDispatch('wallet-1', 'generation-1')).resolves.toBeUndefined();
    await expect(limiter.waitForDispatch('wallet-2', 'generation-1')).rejects.toThrow();
    await expect(limiter.waitForDispatch('wallet-3', 'generation-1')).resolves.toBeUndefined();
  });
});
