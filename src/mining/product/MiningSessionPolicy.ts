import type { WalletMiningWorkerOptions } from '../WalletMiningRuntime';

/** Production controller policy, separate from the SDK's proof/transport code.
 * Late sessions wait for a new confirmed epoch; taps are never caught up in a burst.
 */
export const PRODUCTION_MINING_SESSION_POLICY: Partial<WalletMiningWorkerOptions> = Object.freeze({
  targetTaps: 70,
  sessionDurationMs: 126_000,
  epochEndSafetyMarginMs: 19_000,
  minimumStartWindowMs: 145_000,
  firstTapDelayMs: 1_720,
  tapIntervalMs: 1_720,
  tapJitterRangeMs: 0,
  requireFreshClock: true,
});
