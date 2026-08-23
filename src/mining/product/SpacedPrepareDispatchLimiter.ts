import {
  isQueueFailure,
  type WalletMiningPrepareDispatchLimiter,
} from '../WalletMiningRuntime';
import { SpacedDispatchLimiter } from './SpacedDispatchLimiter';

export const DEFAULT_PREPARE_DISPATCH_SPACING_MS = 1_000;
export const QUEUE_FAILURE_PREPARE_COOLDOWN_MS = 5_000;

/**
 * Short FIFO for native Miner allocation and preflight. Queue pressure adds a
 * bounded fleet cooldown; the failing wallet still owns its longer retry.
 */
export class SpacedPrepareDispatchLimiter
  extends SpacedDispatchLimiter
  implements WalletMiningPrepareDispatchLimiter
{
  constructor(
    spacingMs: number | (() => number) =
      DEFAULT_PREPARE_DISPATCH_SPACING_MS,
    now: () => number = Date.now,
    wait: (delayMs: number) => Promise<void> = waitFor,
    queueFailureCooldownMs = QUEUE_FAILURE_PREPARE_COOLDOWN_MS,
  ) {
    super(
      spacingMs,
      now,
      wait,
      'Fleet preparation dispatch was cancelled.',
      (failure, defaultSpacingMs) =>
        isQueueFailure(failure)
          ? Math.max(defaultSpacingMs, queueFailureCooldownMs)
          : defaultSpacingMs,
    );
  }
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
