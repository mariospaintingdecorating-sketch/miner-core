import type { WalletMiningRewardDispatchLimiter } from '../WalletMiningRuntime';

/**
 * Fleet-wide dispatch gate. It spaces only native get_reward start times;
 * requests may remain in flight concurrently after their slot is released.
 */
export class SpacedRewardDispatchLimiter
  implements WalletMiningRewardDispatchLimiter
{
  #nextDispatchAtMs = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly spacingMs = 500,
    private readonly now: () => number = Date.now,
    private readonly wait: (delayMs: number) => Promise<void> = waitFor,
  ) {}

  waitForDispatch(
    _walletId: string,
    _generationToken: string,
  ): Promise<void> {
    const slot = this.#queue.then(async () => {
      const delayMs = Math.max(0, this.#nextDispatchAtMs - this.now());
      if (delayMs > 0) await this.wait(delayMs);
      this.#nextDispatchAtMs = this.now() + this.spacingMs;
    });
    this.#queue = slot.catch(() => undefined);
    return slot;
  }
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
