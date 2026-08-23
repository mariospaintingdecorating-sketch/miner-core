import {
  isQueueFailure,
  type SafeMiningFailure,
  type WalletMiningQueuePressureController,
} from '../WalletMiningRuntime';
import {
  startDispatchSpacingMs,
  type QueuePressureLevel,
} from './SpacedStartDispatchLimiter';

interface EpochPressureRecord {
  readonly ordinal: number;
  readonly queueFailures: Set<string>;
  readonly outcomes: Set<string>;
  anyFailure: boolean;
  finalized: boolean;
}

/**
 * Raises spacing as soon as classified queue pressure is observed. Pressure
 * decays only after a complete, failure-free productive fleet epoch.
 */
export class AdaptiveQueuePressureController
  implements WalletMiningQueuePressureController
{
  readonly #epochs = new Map<string, EpochPressureRecord>();
  #pressureLevel: QueuePressureLevel = 0;
  #nextOrdinal = 0;

  constructor(
    private readonly fleetSize: () => number,
    private readonly retainedEpochs = 8,
  ) {}

  pressureLevel(): QueuePressureLevel {
    return this.#pressureLevel;
  }

  startSpacingMs(fleetSize: number): number {
    return startDispatchSpacingMs(fleetSize, this.#pressureLevel);
  }

  observeQueueFailure(
    walletId: string,
    miniEpoch: string,
    generationToken: string,
    failure: Readonly<SafeMiningFailure>,
  ): void {
    if (!isQueueFailure(failure)) return;
    const record = this.#record(miniEpoch);
    record.queueFailures.add(`${walletId}\u0000${generationToken}`);
    this.#pressureLevel = (record.queueFailures.size >= 3
      ? 2
      : Math.max(this.#pressureLevel, 1)) as QueuePressureLevel;
  }

  reportProductiveOutcome(
    walletId: string,
    miniEpoch: string,
    failure: Readonly<SafeMiningFailure> | null,
  ): void {
    const record = this.#record(miniEpoch);
    if (record.outcomes.has(walletId)) return;
    record.outcomes.add(walletId);
    if (failure) record.anyFailure = true;
    const expectedFleetSize = Math.max(1, Math.floor(this.fleetSize()));
    if (record.finalized || record.outcomes.size < expectedFleetSize) return;
    record.finalized = true;
    if (!record.anyFailure && record.queueFailures.size === 0) {
      this.#pressureLevel = Math.max(
        0,
        this.#pressureLevel - 1,
      ) as QueuePressureLevel;
    }
    this.#trim();
  }

  #record(miniEpoch: string): EpochPressureRecord {
    const existing = this.#epochs.get(miniEpoch);
    if (existing) return existing;
    const created: EpochPressureRecord = {
      ordinal: ++this.#nextOrdinal,
      queueFailures: new Set(),
      outcomes: new Set(),
      anyFailure: false,
      finalized: false,
    };
    this.#epochs.set(miniEpoch, created);
    this.#trim();
    return created;
  }

  #trim(): void {
    const maximum = Math.max(2, Math.floor(this.retainedEpochs));
    if (this.#epochs.size <= maximum) return;
    const oldest = [...this.#epochs.entries()]
      .sort((left, right) => left[1].ordinal - right[1].ordinal)
      .slice(0, this.#epochs.size - maximum);
    for (const [miniEpoch] of oldest) this.#epochs.delete(miniEpoch);
  }
}
