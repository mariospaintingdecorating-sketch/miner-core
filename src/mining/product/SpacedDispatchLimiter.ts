import type { SafeMiningFailure } from '../WalletMiningRuntime';

/**
 * A FIFO lifecycle gate with spacing between completed slots. A caller may
 * select a different short spacing after a classified outcome; per-wallet
 * retry ownership remains outside this gate.
 */
export class SpacedDispatchLimiter {
  #nextDispatchAtMs = 0;
  #queue: Promise<void> = Promise.resolve();
  readonly #activeSlots = new Map<string, () => void>();

  constructor(
    private readonly spacingMs: number | (() => number),
    private readonly now: () => number = Date.now,
    private readonly wait: (delayMs: number) => Promise<void> = waitFor,
    private readonly abortMessage = 'Fleet lifecycle dispatch was cancelled.',
    private readonly outcomeSpacingMs?: (
      failure: Readonly<SafeMiningFailure> | null,
      defaultSpacingMs: number,
    ) => number,
  ) {}

  waitForDispatch(
    walletId: string,
    generationToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = slotKey(walletId, generationToken);
    let releaseSlot = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    const previous = this.#queue.catch(() => undefined);
    this.#queue = previous.then(() => completion);

    return (async () => {
      try {
        await waitWithAbort(previous, signal, this.abortMessage);
      } catch (error) {
        releaseSlot();
        throw error;
      }
      try {
        throwIfAborted(signal, this.abortMessage);
        const delayMs = Math.max(0, this.#nextDispatchAtMs - this.now());
        if (delayMs > 0) {
          await waitWithAbort(this.wait(delayMs), signal, this.abortMessage);
        }
        throwIfAborted(signal, this.abortMessage);
      } catch (error) {
        releaseSlot();
        throw error;
      }
      this.#activeSlots.set(key, releaseSlot);
    })();
  }

  reportOutcome(
    walletId: string,
    generationToken: string,
    failure: Readonly<SafeMiningFailure> | null,
  ): void {
    const key = slotKey(walletId, generationToken);
    const releaseSlot = this.#activeSlots.get(key);
    if (!releaseSlot) return;
    const defaultSpacingMs = this.#currentSpacingMs();
    const requestedSpacingMs = this.outcomeSpacingMs?.(
      failure,
      defaultSpacingMs,
    ) ?? defaultSpacingMs;
    const spacingMs =
      Number.isFinite(requestedSpacingMs) && requestedSpacingMs >= 0
        ? requestedSpacingMs
        : defaultSpacingMs;
    this.#nextDispatchAtMs = Math.max(
      this.#nextDispatchAtMs,
      this.now() + spacingMs,
    );
    this.#activeSlots.delete(key);
    releaseSlot();
  }

  #currentSpacingMs(): number {
    const value = typeof this.spacingMs === 'function'
      ? this.spacingMs()
      : this.spacingMs;
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }
}

function slotKey(walletId: string, generationToken: string): string {
  return `${walletId}\u0000${generationToken}`;
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function waitWithAbort(
  wait: Promise<void>,
  signal: AbortSignal | undefined,
  abortMessage: string,
): Promise<void> {
  if (!signal) return wait;
  throwIfAborted(signal, abortMessage);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortError(abortMessage));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    wait.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  abortMessage: string,
): void {
  if (signal?.aborted) throw abortError(abortMessage);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
