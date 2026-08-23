import type { WalletMiningStartDispatchLimiter } from '../WalletMiningRuntime';
import { SpacedDispatchLimiter } from './SpacedDispatchLimiter';

export const DEFAULT_START_DISPATCH_SPACING_MS = 5_000;
export const DEFAULT_START_FLEET_SPREAD_MS = 60_000;
export type QueuePressureLevel = 0 | 1 | 2;

const MAX_SPACING_BY_PRESSURE = Object.freeze([5_000, 6_500, 8_000] as const);
const FLEET_SPREAD_BY_PRESSURE = Object.freeze([60_000, 78_000, 96_000] as const);

/**
 * Separate gate for native Miner.start calls. Preparation may continue while
 * this queue spaces the start burst across the active fleet.
 */
export class SpacedStartDispatchLimiter
  extends SpacedDispatchLimiter
  implements WalletMiningStartDispatchLimiter
{
  constructor(
    spacingMs: number | (() => number) = DEFAULT_START_DISPATCH_SPACING_MS,
    now: () => number = Date.now,
    wait: (delayMs: number) => Promise<void> = waitFor,
  ) {
    super(spacingMs, now, wait, 'Fleet native start dispatch was cancelled.');
  }
}

export function startDispatchSpacingMs(
  fleetSize: number,
  pressureLevel: QueuePressureLevel = 0,
): number {
  const normalizedFleetSize = Number.isFinite(fleetSize)
    ? Math.max(1, Math.floor(fleetSize))
    : 1;
  const normalizedPressure = normalizePressureLevel(pressureLevel);
  const maximumSpacingMs = MAX_SPACING_BY_PRESSURE[normalizedPressure];
  const fleetSpreadMs = FLEET_SPREAD_BY_PRESSURE[normalizedPressure];
  if (normalizedFleetSize <= 1) return maximumSpacingMs;
  return Math.min(
    maximumSpacingMs,
    Math.max(
      500,
      Math.floor(fleetSpreadMs / (normalizedFleetSize - 1)),
    ),
  );
}

function normalizePressureLevel(value: number): QueuePressureLevel {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 2 ? 2 : 1;
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
