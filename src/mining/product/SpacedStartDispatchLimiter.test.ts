import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_START_DISPATCH_SPACING_MS,
  SpacedStartDispatchLimiter,
  startDispatchSpacingMs,
} from './SpacedStartDispatchLimiter';

describe('SpacedStartDispatchLimiter', () => {
  it('spaces native start calls independently from preparation', async () => {
    let now = 1_000;
    const waits: number[] = [];
    const limiter = new SpacedStartDispatchLimiter(
      DEFAULT_START_DISPATCH_SPACING_MS,
      () => now,
      vi.fn(async (delayMs: number) => {
        waits.push(delayMs);
        now += delayMs;
      }),
    );

    await limiter.waitForDispatch('wallet-1', 'generation-1');
    const second = limiter.waitForDispatch('wallet-2', 'generation-1');
    limiter.reportOutcome('wallet-1', 'generation-1', null);
    await second;
    limiter.reportOutcome('wallet-2', 'generation-1', null);

    expect(waits).toEqual([5_000]);
    expect(now).toBe(6_000);
  });

  it('keeps the start burst within the adaptive fleet spread', () => {
    expect(startDispatchSpacingMs(9)).toBe(5_000);
    expect(startDispatchSpacingMs(13)).toBe(5_000);
    expect(startDispatchSpacingMs(25)).toBe(2_500);
    expect(startDispatchSpacingMs(49)).toBe(1_250);
    expect(startDispatchSpacingMs(100)).toBe(606);
    expect(startDispatchSpacingMs(13, 1)).toBe(6_500);
    expect(startDispatchSpacingMs(13, 2)).toBe(8_000);
    expect(startDispatchSpacingMs(22, 2)).toBe(4_571);
    expect(startDispatchSpacingMs(32, 2)).toBe(3_096);
  });
});
