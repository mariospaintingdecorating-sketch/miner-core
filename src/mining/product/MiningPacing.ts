export type TapPacingReadinessStatus =
  | 'ready'
  | 'not-configured'
  | 'unavailable';

export interface TapPacingReadiness {
  readonly status: TapPacingReadinessStatus;
  readonly code: string;
  readonly message: string;
}

export interface TapPacingSource {
  readiness(): Readonly<TapPacingReadiness>;
  random(): number;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export const PRODUCTION_TAP_PACING: TapPacingSource = Object.freeze({
  readiness: () => Object.freeze({
    status: 'ready' as const,
    code: 'tap-pacing-ready',
    message: 'Production tap pacing is ready.',
  }),
  random: Math.random,
  wait: waitForDelay,
});

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
