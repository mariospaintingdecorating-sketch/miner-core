import type { WalletMiningSubmissionGuard } from '../WalletMiningRuntime';

export const DEFAULT_SUBMISSION_GUARD_TIMEOUT_MS = 90_000;

interface IdleWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface ExclusiveWaiter {
  readonly id: symbol;
  readonly resolve: (release: () => void) => void;
  readonly reject?: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/**
 * Fleet-wide coordinator for Bee-sensitive work. Native root/proof callbacks
 * remain wallet-owned and concurrent, while terminal reads/reward/free are
 * serialized before background reads and new preparation may resume.
 */
export class SubmissionCriticalSection implements WalletMiningSubmissionGuard {
  readonly #leases = new Map<
    string,
    Readonly<{
      id: symbol;
      handle: ReturnType<typeof setTimeout>;
    }>
  >();
  readonly #waiters = new Set<IdleWaiter>();
  readonly #postSubmissionQueue: ExclusiveWaiter[] = [];
  readonly #idleLeaseQueue: ExclusiveWaiter[] = [];
  #activePostSubmission: symbol | null = null;
  #activeIdleLease: symbol | null = null;

  constructor(
    private readonly timeoutMs = DEFAULT_SUBMISSION_GUARD_TIMEOUT_MS,
    private readonly schedule: (
      callback: () => void,
      delayMs: number,
    ) => ReturnType<typeof setTimeout> = globalThis.setTimeout,
    private readonly cancel: (
      handle: ReturnType<typeof setTimeout>,
    ) => void = globalThis.clearTimeout,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('Submission guard timeout must be positive.');
    }
  }

  enter(walletId: string, generationToken: string): () => void {
    const key = leaseKey(walletId, generationToken);
    const previous = this.#leases.get(key);
    if (previous) this.cancel(previous.handle);

    let released = false;
    const id = Symbol(key);
    const release = (): void => {
      if (released) return;
      released = true;
      const current = this.#leases.get(key);
      if (current?.id === id) {
        this.cancel(current.handle);
        this.#leases.delete(key);
      }
      this.#dispatch();
    };
    const handle = this.schedule(release, this.timeoutMs);
    this.#leases.set(key, Object.freeze({ id, handle }));
    return release;
  }

  transitionToPostSubmission(
    walletId: string,
    generationToken: string,
  ): Promise<() => void> {
    const key = leaseKey(walletId, generationToken);
    const lease = this.#leases.get(key);
    if (lease) {
      this.cancel(lease.handle);
      this.#leases.delete(key);
    }

    return new Promise<() => void>((resolve) => {
      this.#postSubmissionQueue.push({
        id: Symbol(`post:${key}`),
        resolve,
      });
      this.#dispatch();
    });
  }

  acquireIdleLease(
    scope: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<() => void>((resolve, reject) => {
      const waiter: ExclusiveWaiter = {
        id: Symbol(`${scope}:${ownerId}`),
        resolve,
        reject,
        ...(signal
          ? {
              signal,
              onAbort: () => {
                const index = this.#idleLeaseQueue.indexOf(waiter);
                if (index >= 0) this.#idleLeaseQueue.splice(index, 1);
                reject(abortError());
                this.#dispatch();
              },
            }
          : {}),
      };
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#idleLeaseQueue.push(waiter);
      this.#dispatch();
    });
  }

  waitUntilIdle(signal?: AbortSignal): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<void>((resolve, reject) => {
      const waiter: IdleWaiter = {
        resolve,
        reject,
        ...(signal
          ? {
              signal,
              onAbort: () => {
                this.#waiters.delete(waiter);
                reject(abortError());
              },
            }
          : {}),
      };
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#waiters.add(waiter);
    });
  }

  #releaseIdleWaiters(): void {
    if (!this.#isIdle()) return;
    for (const waiter of this.#waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve();
    }
    this.#waiters.clear();
  }

  #dispatch(): void {
    if (
      this.#leases.size > 0 ||
      this.#activePostSubmission !== null ||
      this.#activeIdleLease !== null
    ) return;

    const postSubmission = this.#postSubmissionQueue.shift();
    if (postSubmission) {
      this.#activePostSubmission = postSubmission.id;
      postSubmission.resolve(
        once(() => {
          if (this.#activePostSubmission === postSubmission.id) {
            this.#activePostSubmission = null;
          }
          this.#dispatch();
        }),
      );
      return;
    }

    const idleLease = this.#idleLeaseQueue.shift();
    if (idleLease) {
      if (idleLease.signal && idleLease.onAbort) {
        idleLease.signal.removeEventListener('abort', idleLease.onAbort);
      }
      this.#activeIdleLease = idleLease.id;
      idleLease.resolve(
        once(() => {
          if (this.#activeIdleLease === idleLease.id) {
            this.#activeIdleLease = null;
          }
          this.#dispatch();
        }),
      );
      return;
    }

    this.#releaseIdleWaiters();
  }

  #isIdle(): boolean {
    return (
      this.#leases.size === 0 &&
      this.#postSubmissionQueue.length === 0 &&
      this.#idleLeaseQueue.length === 0 &&
      this.#activePostSubmission === null &&
      this.#activeIdleLease === null
    );
  }
}

function leaseKey(walletId: string, generationToken: string): string {
  return `${walletId}\u0000${generationToken}`;
}

function abortError(): Error {
  const error = new Error('Submission guard wait was cancelled.');
  error.name = 'AbortError';
  return error;
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
