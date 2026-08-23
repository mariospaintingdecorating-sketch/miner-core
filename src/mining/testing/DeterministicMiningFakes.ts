import {
  MiningNativeAdapterError,
  type CanonicalMiniEpochSnapshot,
  type CanonicalMiniEpochSource,
  type MiningNativeAdapter,
  type NativeMinerCreationInput,
  type NativeMinerData,
  type NativeMinerHandle,
  type SafeMiningFailure,
  type SafeNativeCallback,
  type SafeNativeCallbackListener,
  type TapCoordinates,
  type WalletMiningDiagnosticEvent,
  type WalletMiningDiagnosticSink,
  type WalletMiningIdentitySource,
  type WalletMiningPrepareDispatchLimiter,
  type WalletMiningStartDispatchLimiter,
  type WalletMiningRandomSource,
  type WalletMiningRewardDispatchLimiter,
  type WalletMiningTimerSource,
} from '../WalletMiningRuntime';

interface ScheduledTask {
  readonly id: number;
  readonly atMs: number;
  readonly callback: () => void;
  cancelled: boolean;
}

export class DeterministicTimerSource implements WalletMiningTimerSource {
  readonly #tasks: ScheduledTask[] = [];
  #nowMs = 0;
  #sequence = 0;

  nowMs(): number {
    return this.#nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const task: ScheduledTask = {
      id: ++this.#sequence,
      atMs: this.#nowMs + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.#tasks.push(task);
    return task.id;
  }

  clearTimeout(handle: unknown): void {
    const task = this.#tasks.find((candidate) => candidate.id === handle);
    if (task) task.cancelled = true;
  }

  nextDelayMs(): number | null {
    const task = this.#nextTask();
    return task ? Math.max(0, task.atMs - this.#nowMs) : null;
  }

  pendingCount(): number {
    return this.#tasks.filter((task) => !task.cancelled).length;
  }

  scheduledCount(): number {
    return this.#tasks.length;
  }

  runNext(): boolean {
    const task = this.#nextTask();
    if (!task) return false;
    task.cancelled = true;
    this.#nowMs = Math.max(this.#nowMs, task.atMs);
    task.callback();
    return true;
  }

  advanceBy(delayMs: number): void {
    const target = this.#nowMs + Math.max(0, delayMs);
    while (true) {
      const task = this.#nextTask();
      if (!task || task.atMs > target) break;
      task.cancelled = true;
      this.#nowMs = Math.max(this.#nowMs, task.atMs);
      task.callback();
    }
    this.#nowMs = target;
  }

  runAll(maximumTasks = 10_000): void {
    let count = 0;
    while (this.runNext()) {
      count += 1;
      if (count > maximumTasks) {
        throw new Error('Deterministic timer exceeded its task limit.');
      }
    }
  }

  #nextTask(): ScheduledTask | null {
    return (
      this.#tasks
        .filter((task) => !task.cancelled)
        .sort((left, right) => left.atMs - right.atMs || left.id - right.id)[0] ??
      null
    );
  }
}

export class DeterministicRandomSource implements WalletMiningRandomSource {
  constructor(
    readonly coordinates: Readonly<TapCoordinates> = Object.freeze({ x: 200, y: 360 }),
    readonly jitterMs = 0,
  ) {}

  tapCoordinates(): Readonly<TapCoordinates> {
    return this.coordinates;
  }

  tapJitterMs(): number {
    return this.jitterMs;
  }
}

export class DeterministicMiniEpochSource implements CanonicalMiniEpochSource {
  readonly #listeners = new Set<() => void>();
  #snapshot: Readonly<CanonicalMiniEpochSnapshot>;

  constructor(
    miniEpoch: string | null = 'epoch-1',
    remainingMs: number | null = 330_000,
  ) {
    this.#snapshot = Object.freeze({ miniEpoch, remainingMs });
  }

  snapshot(): Readonly<CanonicalMiniEpochSnapshot> {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  update(
    miniEpoch: string | null,
    remainingMs: number | null = this.#snapshot.remainingMs,
  ): void {
    this.#snapshot = Object.freeze({ miniEpoch, remainingMs });
    for (const listener of [...this.#listeners]) listener();
  }
}

export class DeterministicPrepareLimiter
  implements WalletMiningPrepareDispatchLimiter
{
  readonly requests: { walletId: string; generationToken: string }[] = [];
  readonly #wait: Promise<void>;

  constructor(wait: Promise<void> = Promise.resolve()) {
    this.#wait = wait;
  }

  async waitForDispatch(
    walletId: string,
    generationToken: string,
  ): Promise<void> {
    this.requests.push({ walletId, generationToken });
    await this.#wait;
  }

  reportOutcome(): void {}
}

export class DeterministicStartLimiter
  extends DeterministicPrepareLimiter
  implements WalletMiningStartDispatchLimiter {}

export class DeterministicIdentitySource implements WalletMiningIdentitySource {
  #generation = 0;
  #session = 0;

  nextGenerationToken(walletId: string): string {
    return `${walletId}:generation:${++this.#generation}`;
  }

  nextSessionId(walletId: string): string {
    return `${walletId}:session:${++this.#session}`;
  }
}

export class MiningDiagnosticRecorder implements WalletMiningDiagnosticSink {
  readonly events: Readonly<WalletMiningDiagnosticEvent>[] = [];

  record(event: Readonly<WalletMiningDiagnosticEvent>): void {
    this.events.push(event);
  }
}

export class DeterministicRewardLimiter
  implements WalletMiningRewardDispatchLimiter
{
  readonly requests: { walletId: string; generationToken: string }[] = [];
  readonly #wait: Promise<void>;

  constructor(wait: Promise<void> = Promise.resolve()) {
    this.#wait = wait;
  }

  async waitForDispatch(
    walletId: string,
    generationToken: string,
  ): Promise<void> {
    this.requests.push({ walletId, generationToken });
    await this.#wait;
  }
}

export interface FakeNativeMinerOptions {
  readonly canStart?: boolean;
  readonly startFailure?: boolean;
  readonly addTapFailureAt?: number | null;
  readonly addTapFailures?: readonly (Readonly<SafeMiningFailure> | null)[];
  readonly stopFailure?: boolean;
  readonly stop?: Promise<void>;
  readonly reward?: Promise<void>;
  readonly free?: Promise<void>;
  readonly freeFailure?: boolean;
  readonly tapSum?: bigint;
}

export class FakeNativeMiner implements NativeMinerHandle {
  callback: SafeNativeCallbackListener | null = null;
  readonly callbacks: SafeNativeCallbackListener[] = [];
  startCalls = 0;
  addTapCalls = 0;
  stopCalls = 0;
  rewardCalls = 0;
  freeCalls = 0;
  dataFreeCalls = 0;
  readonly coordinates: TapCoordinates[] = [];
  readonly durations: number[] = [];

  constructor(readonly options: Readonly<FakeNativeMinerOptions> = {}) {}

  canStart(): boolean {
    return this.options.canStart ?? true;
  }

  start(durationMs: number, listener: SafeNativeCallbackListener): void {
    this.startCalls += 1;
    this.durations.push(durationMs);
    if (this.options.startFailure) {
      throw new MiningNativeAdapterError({
        failureStage: 'PREPARE',
        errorCategory: 'START_FAILED',
      });
    }
    this.callback = listener;
    this.callbacks.push(listener);
  }

  addTap(x: number, y: number): void {
    this.addTapCalls += 1;
    this.coordinates.push({ x, y });
    const sequencedFailure = this.options.addTapFailures?.[
      this.addTapCalls - 1
    ];
    if (sequencedFailure) {
      throw new MiningNativeAdapterError(sequencedFailure);
    }
    if (this.options.addTapFailureAt === this.addTapCalls) {
      throw new MiningNativeAdapterError({
        failureStage: 'TAP_EXECUTION',
        errorCategory: 'ADD_TAP_FAILED',
      });
    }
  }

  stop(): void | Promise<void> {
    this.stopCalls += 1;
    if (this.options.stopFailure) {
      throw new MiningNativeAdapterError({
        failureStage: 'NATIVE_COMPUTATION',
        errorCategory: 'STOP_FAILED',
      });
    }
    return this.options.stop;
  }

  async getMinerData(): Promise<NativeMinerData> {
    return {
      tapSum: this.options.tapSum ?? 0n,
      free: () => {
        this.dataFreeCalls += 1;
      },
    };
  }

  async getReward(): Promise<void> {
    this.rewardCalls += 1;
    await (this.options.reward ?? Promise.resolve());
  }

  free(): void | Promise<void> {
    this.freeCalls += 1;
    if (this.options.freeFailure) {
      throw new MiningNativeAdapterError({
        failureStage: 'DISPOSAL',
        errorCategory: 'FREE_FAILED',
      });
    }
    return this.options.free;
  }

  emit(callback: Readonly<SafeNativeCallback>): void {
    this.callback?.(callback);
  }

  emitForStart(
    startIndex: number,
    callback: Readonly<SafeNativeCallback>,
  ): void {
    this.callbacks[startIndex]?.(callback);
  }
}

export class FakeMiningNativeAdapter implements MiningNativeAdapter {
  readonly inputs: Readonly<NativeMinerCreationInput>[] = [];
  readonly #results: Promise<NativeMinerHandle>[] = [];

  constructor(results: readonly Promise<NativeMinerHandle>[] = []) {
    this.#results.push(...results);
  }

  enqueueMiner(miner: NativeMinerHandle): void {
    this.#results.push(Promise.resolve(miner));
  }

  enqueueResult(result: Promise<NativeMinerHandle>): void {
    this.#results.push(result);
  }

  enqueueFailure(safeFailure: Readonly<SafeMiningFailure>): void {
    this.#results.push(Promise.reject(new MiningNativeAdapterError(safeFailure)));
  }

  async createMiner(
    input: Readonly<NativeMinerCreationInput>,
  ): Promise<NativeMinerHandle> {
    this.inputs.push(Object.freeze({ ...input, endpoints: [...input.endpoints] }));
    const result = this.#results.shift();
    if (!result) throw new Error('No deterministic native Miner was queued.');
    return result;
  }
}

export interface DeferredValue<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfilled, rejected) => {
    resolve = fulfilled;
    reject = rejected;
  });
  return { promise, resolve, reject };
}

export function nativeFailure(
  failureStage: SafeMiningFailure['failureStage'],
  errorCategory: string,
): MiningNativeAdapterError {
  return new MiningNativeAdapterError({ failureStage, errorCategory });
}

export async function flushMiningMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}
