import type {
  CanonicalMiniEpochSource,
  MiningNativeAdapter,
  WalletMiningDiagnosticSink,
  WalletMiningIdentitySource,
  WalletMiningPrepareDispatchLimiter,
  WalletMiningQueuePressureController,
  WalletMiningRandomSource,
  WalletMiningRewardDispatchLimiter,
  WalletMiningStartDispatchLimiter,
  WalletMiningSubmissionGuard,
  WalletMiningTimerSource,
  WalletMiningWorkerOptions,
} from '../WalletMiningRuntime';
import type { MiningIdentitySource } from '../product/MiningIdentityAdapter';
import {
  createWalletMiningRuntime,
  type ComposedWalletMiningRuntime,
  type CreateWalletMiningRuntimeInput,
} from './createWalletMiningRuntime';
import { inspectWalletMiningRuntimeConstructibility } from './WalletMiningRuntimeConstructibility';
export {
  inspectWalletMiningRuntimeConstructibility,
  WALLET_MINING_RUNTIME_CONSTRUCTIBILITY_INSPECTOR,
  type WalletMiningRuntimeConstructibilityInspector,
} from './WalletMiningRuntimeConstructibility';

export type WalletMiningRuntimeBuilder = (
  input: Readonly<CreateWalletMiningRuntimeInput>,
) => Readonly<ComposedWalletMiningRuntime>;

export interface WalletMiningRuntimeFactoryDependencies {
  readonly miningIdentity: MiningIdentitySource;
  readonly nativeAdapter: MiningNativeAdapter;
  readonly canonicalEpochSource: CanonicalMiniEpochSource;
  readonly diagnostics: WalletMiningDiagnosticSink;
  readonly prepareLimiter: WalletMiningPrepareDispatchLimiter;
  readonly startLimiter: WalletMiningStartDispatchLimiter;
  readonly queuePressureController?: WalletMiningQueuePressureController;
  readonly rewardLimiter: WalletMiningRewardDispatchLimiter;
  readonly submissionGuard?: WalletMiningSubmissionGuard;
  readonly automaticContinuationEnabled?: boolean;
  readonly identitySourceFactory?: (
    walletId: string,
  ) => WalletMiningIdentitySource;
  readonly timerSourceFactory?: (
    walletId: string,
  ) => WalletMiningTimerSource | undefined;
  readonly randomSourceFactory?: (
    walletId: string,
  ) => WalletMiningRandomSource | undefined;
  readonly pacingPolicy?: Partial<WalletMiningWorkerOptions>;
  readonly fleetSize: () => number;
  readonly runtimeBuilder?: WalletMiningRuntimeBuilder;
}

export class WalletMiningRuntimeFactoryError extends Error {
  constructor(
    readonly code:
      | 'WALLET_RUNTIME_ALREADY_EXISTS'
      | 'WALLET_RUNTIME_FACTORY_DISPOSED',
  ) {
    super(`Wallet mining runtime factory failed (${code}).`);
    this.name = 'WalletMiningRuntimeFactoryError';
  }
}

/**
 * Tracks constructed resources only. Mining generation, stop, settlement and
 * reward lifecycles remain entirely inside each wallet worker.
 */
export class WalletMiningRuntimeFactory {
  readonly #runtimes = new Map<string, Readonly<ComposedWalletMiningRuntime>>();
  readonly #pending = new Map<
    string,
    Promise<Readonly<ComposedWalletMiningRuntime>>
  >();
  readonly #startSlotByWallet = new Map<string, number>();
  readonly #availableStartSlots: number[] = [];
  #nextStartSlot = 0;
  #disposeRequested = false;
  #disposal: Promise<void> | null = null;

  constructor(
    private readonly dependencies: Readonly<WalletMiningRuntimeFactoryDependencies>,
  ) {}

  create(walletId: string): Promise<Readonly<ComposedWalletMiningRuntime>> {
    const normalizedWalletId = walletId.trim();
    if (this.#disposeRequested) {
      return Promise.reject(new WalletMiningRuntimeFactoryError(
        'WALLET_RUNTIME_FACTORY_DISPOSED',
      ));
    }
    if (
      this.#runtimes.has(normalizedWalletId) ||
      this.#pending.has(normalizedWalletId)
    ) {
      return Promise.reject(new WalletMiningRuntimeFactoryError(
        'WALLET_RUNTIME_ALREADY_EXISTS',
      ));
    }

    const creation = this.#create(normalizedWalletId);
    this.#pending.set(normalizedWalletId, creation);
    void creation.finally(() => {
      if (this.#pending.get(normalizedWalletId) === creation) {
        this.#pending.delete(normalizedWalletId);
      }
    }).catch(() => undefined);
    return creation;
  }

  runtime(walletId: string): Readonly<ComposedWalletMiningRuntime> | null {
    return this.#runtimes.get(walletId) ?? null;
  }

  walletIds(): readonly string[] {
    return Object.freeze([...this.#runtimes.keys()]);
  }

  async release(walletId: string): Promise<void> {
    const pending = this.#pending.get(walletId);
    if (pending) {
      try {
        await pending;
      } catch {
        return;
      }
    }
    const runtime = this.#runtimes.get(walletId);
    if (!runtime) return;
    await runtime.dispose();
    const snapshot = runtime.snapshot();
    if (snapshot.quarantined || snapshot.disposalStatus === 'FAILED') {
      throw new Error('Wallet mining runtime disposal is quarantined.');
    }
    if (this.#runtimes.get(walletId) === runtime) {
      this.#runtimes.delete(walletId);
      this.#releaseStartSlot(walletId);
    }
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposeRequested = true;
    this.#disposal = this.#dispose();
    return this.#disposal;
  }

  async #dispose(): Promise<void> {
    await Promise.allSettled([...this.#pending.values()]);
    const walletIds = [...this.#runtimes.keys()];
    const results = await Promise.allSettled(
      walletIds.map((walletId) => this.release(walletId)),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult =>
        result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'One or more wallet mining runtimes failed to dispose.',
      );
    }
  }

  async #create(
    walletId: string,
  ): Promise<Readonly<ComposedWalletMiningRuntime>> {
    const identity = await this.dependencies.miningIdentity.resolve(walletId);
    if (!inspectWalletMiningRuntimeConstructibility(identity).constructible) {
      throw new Error('Validated mining identity is not constructible.');
    }
    if (this.#disposeRequested) {
      throw new WalletMiningRuntimeFactoryError(
        'WALLET_RUNTIME_FACTORY_DISPOSED',
      );
    }
    const runtimeBuilder =
      this.dependencies.runtimeBuilder ?? createWalletMiningRuntime;
    const fleetStartSlotIndex = this.#allocateStartSlot(walletId);
    const fleetStartSlotCount = Math.max(
      1,
      Math.floor(this.dependencies.fleetSize()),
    );
    const timerSource = this.dependencies.timerSourceFactory?.(walletId);
    const randomSource = this.dependencies.randomSourceFactory?.(walletId);
    let runtime: Readonly<ComposedWalletMiningRuntime>;
    try {
      runtime = runtimeBuilder(Object.freeze({
        validatedIdentity: identity,
        nativeAdapter: this.dependencies.nativeAdapter,
        canonicalEpochSource: this.dependencies.canonicalEpochSource,
        diagnostics: this.dependencies.diagnostics,
        prepareLimiter: this.dependencies.prepareLimiter,
        startLimiter: this.dependencies.startLimiter,
        ...(this.dependencies.queuePressureController
          ? {
              queuePressureController:
                this.dependencies.queuePressureController,
            }
          : {}),
        rewardLimiter: this.dependencies.rewardLimiter,
        ...(this.dependencies.submissionGuard
          ? { submissionGuard: this.dependencies.submissionGuard }
          : {}),
        ...(this.dependencies.automaticContinuationEnabled !== undefined
          ? {
              automaticContinuationEnabled:
                this.dependencies.automaticContinuationEnabled,
            }
          : {}),
        identitySource:
          this.dependencies.identitySourceFactory?.(walletId) ??
          new WalletLocalMiningIdentitySource(walletId),
        ...(timerSource ? { timerSource } : {}),
        ...(randomSource ? { randomSource } : {}),
        pacingPolicy: {
          ...this.dependencies.pacingPolicy,
          fleetStartSlotIndex,
          fleetStartSlotCount,
        },
      }));
    } catch (error) {
      this.#releaseStartSlot(walletId);
      throw error;
    }
    this.#runtimes.set(walletId, runtime);
    return runtime;
  }

  #allocateStartSlot(walletId: string): number {
    const existing = this.#startSlotByWallet.get(walletId);
    if (existing !== undefined) return existing;
    const slot = this.#availableStartSlots.shift() ?? this.#nextStartSlot++;
    this.#startSlotByWallet.set(walletId, slot);
    return slot;
  }

  #releaseStartSlot(walletId: string): void {
    const slot = this.#startSlotByWallet.get(walletId);
    if (slot === undefined) return;
    this.#startSlotByWallet.delete(walletId);
    this.#availableStartSlots.push(slot);
    this.#availableStartSlots.sort((left, right) => left - right);
  }
}

class WalletLocalMiningIdentitySource implements WalletMiningIdentitySource {
  readonly #scope = globalThis.crypto.randomUUID();
  #generation = 0;
  #session = 0;

  constructor(private readonly walletId: string) {}

  nextGenerationToken(walletId: string): string {
    this.#assertWallet(walletId);
    return `${walletId}:${this.#scope}:generation:${++this.#generation}`;
  }

  nextSessionId(walletId: string): string {
    this.#assertWallet(walletId);
    return `${walletId}:${this.#scope}:session:${++this.#session}`;
  }

  #assertWallet(walletId: string): void {
    if (walletId !== this.walletId) {
      throw new Error('Wallet-local mining identity source mismatch.');
    }
  }
}
