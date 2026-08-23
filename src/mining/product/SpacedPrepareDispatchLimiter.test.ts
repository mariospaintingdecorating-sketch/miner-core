import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREPARE_DISPATCH_SPACING_MS,
  SpacedPrepareDispatchLimiter,
} from './SpacedPrepareDispatchLimiter';

describe('SpacedPrepareDispatchLimiter', () => {
  it('spaces fleet native preparation starts by the production interval', async () => {
    let now = 1_000;
    const waits: number[] = [];
    const limiter = new SpacedPrepareDispatchLimiter(
      DEFAULT_PREPARE_DISPATCH_SPACING_MS,
      () => now,
      vi.fn(async (delayMs: number) => {
        waits.push(delayMs);
        now += delayMs;
      }),
    );

    await limiter.waitForDispatch('wallet-1', 'generation-1');
    let secondResolved = false;
    const second = limiter
      .waitForDispatch('wallet-2', 'generation-1')
      .then(() => { secondResolved = true; });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    limiter.reportOutcome('wallet-1', 'generation-1', null);
    await second;
    const third = limiter.waitForDispatch('wallet-3', 'generation-1');
    limiter.reportOutcome('wallet-2', 'generation-1', null);
    await third;
    limiter.reportOutcome('wallet-3', 'generation-1', null);

    expect(waits).toEqual([1_000, 1_000]);
    expect(now).toBe(3_000);
  });

  it('releases later preparation slots after one wait fails', async () => {
    let calls = 0;
    const limiter = new SpacedPrepareDispatchLimiter(
      300,
      () => 0,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('controlled wait failure');
      },
    );

    await expect(limiter.waitForDispatch('wallet-1', 'generation-1')).resolves.toBeUndefined();
    limiter.reportOutcome('wallet-1', 'generation-1', null);
    await expect(limiter.waitForDispatch('wallet-2', 'generation-1')).rejects.toThrow();
    await expect(limiter.waitForDispatch('wallet-3', 'generation-1')).resolves.toBeUndefined();
    limiter.reportOutcome('wallet-3', 'generation-1', null);
  });

  it('uses a short fleet cooldown only after classified queue pressure', async () => {
    let now = 1_000;
    const waits: number[] = [];
    const limiter = new SpacedPrepareDispatchLimiter(
      300,
      () => now,
      async (delayMs) => {
        waits.push(delayMs);
        now += delayMs;
      },
    );

    await limiter.waitForDispatch('wallet-1', 'generation-1');
    limiter.reportOutcome('wallet-1', 'generation-1', {
      failureStage: 'PREPARE',
      errorCategory: 'NETWORK',
    });
    await limiter.waitForDispatch('wallet-2', 'generation-1');
    limiter.reportOutcome('wallet-2', 'generation-1', {
      failureStage: 'PREPARE',
      errorCategory: 'QUEUE',
      serverCode: 621,
    });
    await limiter.waitForDispatch('wallet-3', 'generation-1');

    expect(waits).toEqual([300, 5_000]);
    expect(now).toBe(6_300);
  });

  it('releases a cancelled wallet immediately while spacing is active', async () => {
    const controller = new AbortController();
    const limiter = new SpacedPrepareDispatchLimiter(
      300,
      () => 1_000,
      () => new Promise<void>(() => undefined),
    );
    await limiter.waitForDispatch('wallet-1', 'generation-1');
    limiter.reportOutcome('wallet-1', 'generation-1', null);

    const pending = limiter.waitForDispatch(
      'wallet-2',
      'generation-1',
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
