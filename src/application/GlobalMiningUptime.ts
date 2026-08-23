import type {
  GlobalMiningUptimeHistoryEntry,
  GlobalMiningUptimePersistenceSnapshot,
  GlobalMiningUptimeStorageContract,
} from '../storage/contracts';

export interface GlobalMiningUptimeSnapshot {
  readonly active: boolean;
  readonly activeStartedAt: number | null;
  readonly todayMs: number;
  readonly history: readonly Readonly<GlobalMiningUptimeHistoryEntry>[];
  readonly measuredAt: number;
}

export const GLOBAL_MINING_UPTIME_HEARTBEAT_MS = 60_000;

/** Observes global operator mining intent without controlling mining lifecycle. */
export class GlobalMiningUptime {
  readonly #storage: GlobalMiningUptimeStorageContract | null;
  readonly #clock: () => number;
  #dayStart: number;
  #completedTodayMs: number;
  #activeStartedAt: number | null;
  #lastHeartbeatAt: number | null;
  #history: readonly Readonly<GlobalMiningUptimeHistoryEntry>[];
  #persistence: Promise<void> = Promise.resolve();

  private constructor(
    storage: GlobalMiningUptimeStorageContract | null,
    persisted: Readonly<GlobalMiningUptimePersistenceSnapshot>,
    clock: () => number,
    initializedAt: number,
  ) {
    this.#storage = storage;
    this.#clock = clock;
    this.#dayStart = localDayStart(initializedAt);
    this.#completedTodayMs = nonNegativeDuration(persisted.completedTodayMs);
    this.#activeStartedAt = persisted.activeStartedAt;
    this.#lastHeartbeatAt = persisted.activeStartedAt;
    this.#history = historyForPreviousDays(
      initializedAt,
      persisted.history,
      persisted.activeStartedAt,
    );
  }

  static async hydrate(
    storage: GlobalMiningUptimeStorageContract,
    clock: () => number = Date.now,
  ): Promise<GlobalMiningUptime> {
    const initializedAt = clock();
    const persisted = await storage.globalMiningUptimeSnapshot(initializedAt);
    return new GlobalMiningUptime(storage, persisted, clock, initializedAt);
  }

  static transient(clock: () => number = Date.now): GlobalMiningUptime {
    const initializedAt = clock();
    return new GlobalMiningUptime(
      null,
      emptyPersistedUptime(initializedAt),
      clock,
      initializedAt,
    );
  }

  start(at = this.#clock()): boolean {
    this.#rollDay(at);
    if (this.#activeStartedAt !== null) return false;
    this.#activeStartedAt = at;
    this.#lastHeartbeatAt = at;
    this.#enqueue(() => this.#storage?.startGlobalMiningUptime(at));
    return true;
  }

  heartbeat(at = this.#clock()): boolean {
    const startedAt = this.#activeStartedAt;
    const lastHeartbeatAt = this.#lastHeartbeatAt;
    if (
      startedAt === null ||
      (lastHeartbeatAt !== null && at - lastHeartbeatAt < GLOBAL_MINING_UPTIME_HEARTBEAT_MS)
    ) {
      return false;
    }

    const activeAt = Math.max(startedAt, at);
    this.#lastHeartbeatAt = activeAt;
    this.#enqueue(() => this.#storage?.heartbeatGlobalMiningUptime(activeAt));
    return true;
  }

  stop(at = this.#clock()): boolean {
    this.#rollDay(at);
    const startedAt = this.#activeStartedAt;
    if (startedAt === null) return false;
    const endedAt = Math.max(startedAt, at);
    this.#completedTodayMs += overlapDuration(
      startedAt,
      endedAt,
      this.#dayStart,
      nextLocalDayStart(this.#dayStart),
    );
    this.#activeStartedAt = null;
    this.#lastHeartbeatAt = null;
    this.#enqueue(() => this.#storage?.stopGlobalMiningUptime(endedAt));
    return true;
  }

  snapshot(at = this.#clock()): Readonly<GlobalMiningUptimeSnapshot> {
    this.#rollDay(at);
    const activeDuration = this.#activeStartedAt === null
      ? 0
      : overlapDuration(
          this.#activeStartedAt,
          Math.max(this.#activeStartedAt, at),
          this.#dayStart,
          nextLocalDayStart(this.#dayStart),
        );
    return Object.freeze({
      active: this.#activeStartedAt !== null,
      activeStartedAt: this.#activeStartedAt,
      todayMs: this.#completedTodayMs + activeDuration,
      history: this.#history,
      measuredAt: at,
    });
  }

  async dispose(at = this.#clock()): Promise<void> {
    this.stop(at);
    await this.#persistence;
  }

  async settled(): Promise<void> {
    await this.#persistence;
  }

  #rollDay(at: number): void {
    const targetDayStart = localDayStart(at);
    if (targetDayStart === this.#dayStart) return;
    if (targetDayStart < this.#dayStart) {
      this.#dayStart = targetDayStart;
      this.#completedTodayMs = 0;
      this.#history = historyForPreviousDays(at, this.#history, null);
      return;
    }

    while (this.#dayStart < targetDayStart) {
      const dayEnd = nextLocalDayStart(this.#dayStart);
      const activeDuration = this.#activeStartedAt === null
        ? 0
        : overlapDuration(
            this.#activeStartedAt,
            Math.max(this.#activeStartedAt, dayEnd),
            this.#dayStart,
            dayEnd,
          );
      const completedDay = Object.freeze({
        date: localDateKey(this.#dayStart),
        durationMs: this.#completedTodayMs + activeDuration,
      });
      this.#history = Object.freeze([
        completedDay,
        ...this.#history.filter((entry) => entry.date !== completedDay.date),
      ].slice(0, 3));
      this.#dayStart = dayEnd;
      this.#completedTodayMs = 0;
    }
  }

  #enqueue(operation: () => Promise<void> | void): void {
    if (!this.#storage) return;
    this.#persistence = this.#persistence
      .then(() => operation())
      .catch(() => undefined);
  }
}

function localDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function nextLocalDayStart(dayStart: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

function previousLocalDayStart(dayStart: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() - 1);
  return date.getTime();
}

function localDateKey(dayStart: number): string {
  const date = new Date(dayStart);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyPersistedUptime(at: number): GlobalMiningUptimePersistenceSnapshot {
  return Object.freeze({
    completedTodayMs: 0,
    activeStartedAt: null,
    history: historyForPreviousDays(at, [], null),
  });
}

function historyForPreviousDays(
  at: number,
  persisted: readonly Readonly<GlobalMiningUptimeHistoryEntry>[],
  activeStartedAt: number | null,
): readonly Readonly<GlobalMiningUptimeHistoryEntry>[] {
  const persistedByDate = new Map(
    persisted.map((entry) => [entry.date, nonNegativeDuration(entry.durationMs)]),
  );
  const history: Readonly<GlobalMiningUptimeHistoryEntry>[] = [];
  let dayEnd = localDayStart(at);
  for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
    const dayStart = previousLocalDayStart(dayEnd);
    const date = localDateKey(dayStart);
    const activeDuration = activeStartedAt === null
      ? 0
      : overlapDuration(activeStartedAt, at, dayStart, dayEnd);
    history.push(Object.freeze({
      date,
      durationMs: (persistedByDate.get(date) ?? 0) + activeDuration,
    }));
    dayEnd = dayStart;
  }
  return Object.freeze(history);
}

function overlapDuration(
  startedAt: number,
  endedAt: number,
  rangeStart: number,
  rangeEnd: number,
): number {
  return Math.max(0, Math.min(endedAt, rangeEnd) - Math.max(startedAt, rangeStart));
}

function nonNegativeDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
