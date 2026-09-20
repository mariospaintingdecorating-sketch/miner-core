/** A deadline cancels local observation, never claims to cancel a chain write. */
export class WalletAuthorizationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WalletAuthorizationError'; }
}
export function assertAuthorizationActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WalletAuthorizationError('bee-wallet-authorization-cancelled', 'Verification paused. The same QR and key can be used again.');
}
export function authorizationRead<T>(operation: Promise<T>, deadlineMs: number,
  signal?: AbortSignal, disposeLate?: (value: T) => void, now: () => number = Date.now): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn();
    };
    const abort = () => finish(() => reject(new WalletAuthorizationError('bee-wallet-authorization-cancelled', 'Verification paused. The same QR and key can be used again.')));
    const timer = setTimeout(() => finish(() => reject(new WalletAuthorizationError('bee-wallet-read-timeout', 'The network read timed out. No replacement key was generated.'))), Math.max(0, deadlineMs - now()));
    signal?.addEventListener('abort', abort, { once: true });
    operation.then(value => {
      if (done) { try { disposeLate?.(value); } catch { /* No stale result can commit state. */ } return; }
      finish(() => resolve(value));
    }, error => finish(() => reject(error)));
    if (signal?.aborted) abort();
  });
}
export function authorizationDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new WalletAuthorizationError('bee-wallet-authorization-cancelled', 'Verification paused.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
