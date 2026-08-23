export const DEFAULT_BACKGROUND_READ_SPACING_MS = 350;

type Delay = (delayMs: number) => Promise<void>;

const SYSTEM_DELAY: Delay = (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

/**
 * Serializes read-only Bee wallet operations that share one native Wallet.
 * The caller receives its result immediately; only the next queued read waits
 * for the cooldown. A failed read cannot break or permanently block the queue.
 */
export class SpacedBackgroundReadDispatcher {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly spacingMs = DEFAULT_BACKGROUND_READ_SPACING_MS,
    private readonly delay: Delay = SYSTEM_DELAY,
  ) {
    if (!Number.isFinite(spacingMs) || spacingMs < 0) {
      throw new RangeError('Background read spacing must be non-negative.');
    }
  }

  async dispatch<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const previous = this.#tail.catch(() => undefined);
    let release!: () => void;
    const turnComplete = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tail = previous.then(() => turnComplete);

    await previous;
    try {
      return await operation();
    } finally {
      if (this.spacingMs === 0) {
        release();
      } else {
        void this.delay(this.spacingMs).then(release, release);
      }
    }
  }
}
