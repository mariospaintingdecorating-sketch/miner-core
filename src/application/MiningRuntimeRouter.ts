import type { MinerRuntimeStatus } from '../shared/miningRuntime';
import type { ComposedWalletMiningRuntime } from '../mining/composition/createWalletMiningRuntime';
import type { WalletMiningRuntimeFactory } from '../mining/composition/WalletMiningRuntimeFactory';
import type { ShadowMiningPreflightCapability } from '../mining/product/ShadowMiningPreflight';
import type { BeeMiningSessionSnapshot } from '../services/bee/contracts';
import type { RewardSynchronizationSnapshot } from './operatorState';
import type { RuntimePresentationState } from './runtimeState';
import { WalletMiningWorkerProductAdapter } from './WalletMiningWorkerProductAdapter';

export type MiningEngineKind = 'NEW_WALLET_WORKER';
export type MiningRuntimeOwnership = 'NONE' | 'NEW';
export type MiningStartSource =
  | 'EXPLICIT_WALLET'
  | 'START_ALL'
  | 'MAIN_EPOCH';

export interface MiningRuntimeRouterStartInput {
  readonly walletId: string | null;
  readonly source: MiningStartSource;
}

export interface MiningRuntimeRouterStartResult {
  readonly accepted: boolean;
  readonly reasonCode: string;
  readonly message: string;
  readonly engine: MiningEngineKind;
  readonly sessionId: string | null;
  readonly generationToken: string | null;
}

export interface MiningRuntimeRouterStopResult {
  readonly accepted: boolean;
  readonly reasonCode: string;
  readonly message: string;
  readonly engine: MiningEngineKind;
}

export interface MiningRuntimeRouterDependencies {
  readonly newRuntimeFactory?: Pick<
    WalletMiningRuntimeFactory,
    'create' | 'runtime' | 'walletIds' | 'release' | 'dispose'
  >;
  readonly shadowPreflight?: ShadowMiningPreflightCapability;
  readonly createProductAdapter?: (
    runtime: Readonly<ComposedWalletMiningRuntime>,
  ) => WalletMiningWorkerProductAdapter;
  readonly newProductSessionAvailable?: (walletId: string) => boolean;
}

/**
 * The single production mining-runtime boundary. Every wallet is owned by a
 * wallet-local WalletMiningWorker with one authoritative ownership path.
 */
export class MiningRuntimeRouter {
  readonly #owners = new Set<string>();
  readonly #productAdapters = new Map<string, WalletMiningWorkerProductAdapter>();
  readonly #startOperations = new Map<
    string,
    Promise<Readonly<MiningRuntimeRouterStartResult>>
  >();
  readonly #cancelledStarts = new Set<string>();
  #disposeRequested = false;
  #disposal: Promise<void> | null = null;

  constructor(
    private readonly dependencies: Readonly<MiningRuntimeRouterDependencies>,
  ) {}

  start(
    input: Readonly<MiningRuntimeRouterStartInput>,
  ): Promise<Readonly<MiningRuntimeRouterStartResult>> {
    if (this.#disposeRequested) {
      return Promise.resolve(startResult(
        false,
        'runtime-not-active',
        'Application shutdown is in progress.',
      ));
    }
    if (!input.walletId) {
      return Promise.resolve(startResult(
        false,
        'new-worker-wallet-required',
        'The wallet mining worker requires an explicit wallet.',
      ));
    }

    const key = input.walletId;
    const existing = this.#startOperations.get(key);
    if (existing) return existing;
    this.#cancelledStarts.delete(key);
    const operation = this.#start(input, key);
    this.#startOperations.set(key, operation);
    void operation.finally(() => {
      if (this.#startOperations.get(key) === operation) {
        this.#startOperations.delete(key);
      }
    }).catch(() => undefined);
    return operation;
  }

  async stop(
    walletId: string | null,
    reason: Parameters<ComposedWalletMiningRuntime['stop']>[0],
    allowIdle = false,
  ): Promise<Readonly<MiningRuntimeRouterStopResult>> {
    if (!walletId) {
      return stopResult(
        allowIdle,
        allowIdle ? 'stopped' : 'runtime-not-active',
        allowIdle
          ? 'No wallet mining runtime was active.'
          : 'The selected wallet runtime is not active.',
      );
    }

    this.#cancelledStarts.add(walletId);
    const pending = this.#startOperations.get(walletId);
    await pending?.catch(() => undefined);
    const runtime = this.dependencies.newRuntimeFactory?.runtime(walletId);
    if (!runtime) {
      return stopResult(
        allowIdle || Boolean(pending),
        allowIdle || pending ? 'stopped' : 'runtime-not-active',
        allowIdle || pending
          ? 'The pending wallet mining start was cancelled.'
          : 'The selected wallet runtime is not active.',
      );
    }

    try {
      this.#productAdapters.get(walletId)?.noteStopReason(reason);
      const result = await runtime.stop(reason);
      return stopResult(
        result.status !== 'QUARANTINED',
        result.status === 'QUARANTINED'
          ? 'new-worker-disposal-failed'
          : 'stopped',
        result.status === 'QUARANTINED'
          ? 'The wallet mining worker is quarantined after disposal failure.'
          : 'The wallet runtime received a stop command.',
      );
    } catch {
      return stopResult(
        false,
        'runtime-stop-failed',
        'The wallet runtime could not be stopped. Review diagnostics and retry.',
      );
    }
  }

  ownership(walletId: string | null): MiningRuntimeOwnership {
    return walletId && this.#owners.has(walletId) ? 'NEW' : 'NONE';
  }

  engine(walletId: string | null): MiningEngineKind | null {
    return this.ownership(walletId) === 'NEW' ? 'NEW_WALLET_WORKER' : null;
  }

  status(walletId: string | null): MinerRuntimeStatus {
    if (!walletId) return this.#disposeRequested ? 'disposed' : 'idle';
    const adapter = this.#productAdapters.get(walletId);
    return adapter?.presentation(EMPTY_PRESENTATION).runtimeStatus ??
      (this.#disposeRequested ? 'disposed' : 'idle');
  }

  presentation(
    walletId: string,
    base: Readonly<RuntimePresentationState>,
  ): Readonly<RuntimePresentationState> | null {
    return this.#productAdapters.get(walletId)?.presentation(base) ?? null;
  }

  rewardSynchronization(
    walletId: string,
  ): Readonly<RewardSynchronizationSnapshot> | null {
    return this.#productAdapters.get(walletId)?.rewardSynchronization() ?? null;
  }

  activeSessionIdentity(walletId: string): Readonly<{
    sessionId: string;
    generation: number;
  }> | null {
    return this.#productAdapters.get(walletId)?.activeSessionIdentity() ?? null;
  }

  nativeSession(walletId: string): Readonly<BeeMiningSessionSnapshot> | null {
    const runtime = this.dependencies.newRuntimeFactory?.runtime(walletId);
    const session = this.activeSessionIdentity(walletId);
    if (!runtime || !session) return null;
    const state = runtime.snapshot().state;
    const phase: BeeMiningSessionSnapshot['phase'] =
      state === 'PREPARING' || state === 'READY'
        ? 'prepared'
        : state === 'MINING'
          ? 'running'
          : state === 'TERMINAL' || state === 'REWARDING' || state === 'DISPOSING'
            ? 'completed'
            : state === 'STOP_REQUESTED' ||
                state === 'SUBMITTING_ROOT' ||
                state === 'WAITING_INTERVAL' ||
                state === 'SUBMITTING_PROOF' ||
                state === 'WAITING_RESULT'
              ? 'stopping'
              : 'stopped';
    return Object.freeze({ walletId, ...session, phase });
  }

  productGeneration(
    walletId: string,
    generationToken: string | null,
  ): number | null {
    return this.#productAdapters
      .get(walletId)
      ?.generationForToken(generationToken) ?? null;
  }

  ownedWalletIds(): readonly string[] {
    return Object.freeze([...this.#owners]);
  }

  activeWalletIds(): readonly string[] {
    return Object.freeze(
      [...this.#owners].filter((walletId) => {
        const status = this.status(walletId);
        return status !== 'idle' && status !== 'disposed';
      }),
    );
  }

  isTerminal(walletId: string): boolean {
    return this.#productAdapters.get(walletId)?.isTerminal() ?? true;
  }

  retainsDesiredMining(walletId: string): boolean {
    return Boolean(
      this.dependencies.newRuntimeFactory?.runtime(walletId)?.snapshot()
        .desiredMining,
    );
  }

  async release(walletId: string): Promise<boolean> {
    this.#cancelledStarts.add(walletId);
    const pending = this.#startOperations.get(walletId);
    await pending?.catch(() => undefined);
    return this.#releaseOwnedRuntime(walletId);
  }

  async #releaseOwnedRuntime(walletId: string): Promise<boolean> {
    try {
      await this.dependencies.newRuntimeFactory?.release(walletId);
      this.#productAdapters.get(walletId)?.detach();
      this.#productAdapters.delete(walletId);
      this.#owners.delete(walletId);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposeRequested = true;
    for (const walletId of this.#owners) this.#cancelledStarts.add(walletId);
    this.#disposal = this.#dispose();
    return this.#disposal;
  }

  async #start(
    input: Readonly<MiningRuntimeRouterStartInput>,
    walletId: string,
  ): Promise<Readonly<MiningRuntimeRouterStartResult>> {
    const existing = this.dependencies.newRuntimeFactory?.runtime(walletId);
    if (existing) return this.#startExisting(existing, walletId);

    const factory = this.dependencies.newRuntimeFactory;
    const preflight = this.dependencies.shadowPreflight;
    const createAdapter = this.dependencies.createProductAdapter;
    if (!factory || !preflight || !createAdapter) {
      return startResult(
        false,
        'new-worker-not-configured',
        'The wallet mining runtime is not configured.',
      );
    }
    if (this.dependencies.newProductSessionAvailable?.(walletId) === false) {
      return startResult(
        false,
        'new-worker-product-session-conflict',
        'The wallet already has a product session association.',
      );
    }

    const readiness = await preflight.check(walletId);
    if (readiness.status !== 'READY') {
      return startResult(
        false,
        readiness.status === 'ERROR'
          ? 'new-worker-shadow-error'
          : 'new-worker-shadow-blocked',
        'The wallet mining preflight is not ready.',
      );
    }
    if (this.#cancelledStarts.has(walletId)) {
      return startResult(
        false,
        'runtime-not-active',
        'Mining start was cancelled before wallet preparation.',
      );
    }

    let runtime: Readonly<ComposedWalletMiningRuntime>;
    try {
      runtime = await factory.create(walletId);
    } catch {
      return startResult(
        false,
        'new-worker-construction-failed',
        'The wallet mining runtime could not be constructed.',
      );
    }
    const adapter = createAdapter(runtime);
    this.#productAdapters.set(walletId, adapter);
    this.#owners.add(walletId);

    if (this.#cancelledStarts.has(walletId)) {
      // This runs inside the wallet's start operation, so it must not call the
      // public release method which intentionally waits for that operation.
      const released = await this.#releaseOwnedRuntime(walletId);
      return startResult(
        false,
        released ? 'runtime-not-active' : 'new-worker-disposal-failed',
        released
          ? 'Mining start was cancelled before native preparation.'
          : 'The cancelled wallet worker could not be disposed.',
      );
    }
    return this.#startExisting(runtime, walletId);
  }

  async #startExisting(
    runtime: Readonly<ComposedWalletMiningRuntime>,
    walletId: string,
  ): Promise<Readonly<MiningRuntimeRouterStartResult>> {
    if (runtime.snapshot().quarantined) {
      return startResult(
        false,
        'new-worker-quarantined',
        'The wallet mining worker is quarantined after disposal failure.',
      );
    }
    if (this.#cancelledStarts.has(walletId)) {
      return startResult(
        false,
        'runtime-not-active',
        'Mining start was cancelled before wallet preparation.',
      );
    }
    try {
      const result = await runtime.start();
      return startResult(
        result.status === 'STARTED' || result.status === 'ALREADY_ACTIVE',
        result.status === 'STARTED'
          ? 'started'
          : result.status === 'ALREADY_ACTIVE'
            ? 'runtime-already-active'
            : 'runtime-start-failed',
        result.status === 'STARTED'
          ? 'Wallet mining runtime started.'
          : result.status === 'ALREADY_ACTIVE'
            ? 'The wallet runtime is already active.'
            : 'The wallet mining runtime could not start.',
        result.sessionId,
        result.generationToken,
      );
    } catch {
      return startResult(
        false,
        'runtime-start-failed',
        'The wallet mining runtime could not start.',
      );
    }
  }

  async #dispose(): Promise<void> {
    await Promise.allSettled([...this.#startOperations.values()]);
    try {
      await this.dependencies.newRuntimeFactory?.dispose();
    } finally {
      for (const adapter of this.#productAdapters.values()) adapter.detach();
      this.#productAdapters.clear();
      this.#owners.clear();
    }
  }
}

function startResult(
  accepted: boolean,
  reasonCode: string,
  message: string,
  sessionId: string | null = null,
  generationToken: string | null = null,
): Readonly<MiningRuntimeRouterStartResult> {
  return Object.freeze({
    accepted,
    reasonCode,
    message,
    engine: 'NEW_WALLET_WORKER',
    sessionId,
    generationToken,
  });
}

function stopResult(
  accepted: boolean,
  reasonCode: string,
  message: string,
): Readonly<MiningRuntimeRouterStopResult> {
  return Object.freeze({
    accepted,
    reasonCode,
    message,
    engine: 'NEW_WALLET_WORKER',
  });
}

const EMPTY_PRESENTATION = Object.freeze({
  runtimeStatus: 'idle' as const,
  miningExecution: null,
  schedulerStatus: 'idle' as const,
  settlementStatus: 'idle' as const,
  boundaryStatus: 'idle' as const,
  recoveryStatus: 'idle' as const,
  recoveryIssue: null,
  epochs: Object.freeze({
    miniEpoch: Object.freeze({
      status: 'waiting' as const,
      id: null,
      startBlock: null,
      endBlock: null,
      currentBlock: null,
      progressPercent: 0,
      elapsedMs: null,
      remainingMs: null,
      remainingBlocks: null,
      elapsedLabel: '—',
      remainingLabel: '—',
      startedAt: null,
      expectedEndAt: null,
      expectedEndLabel: '—',
    }),
    mainEpoch: Object.freeze({
      status: 'waiting' as const,
      id: null,
      startBlock: null,
      endBlock: null,
      currentBlock: null,
      progressPercent: 0,
      elapsedMs: null,
      remainingMs: null,
      remainingBlocks: null,
      elapsedLabel: '—',
      remainingLabel: '—',
      startedAt: null,
      expectedEndAt: null,
      expectedEndLabel: '—',
    }),
  }),
  health: Object.freeze({ uptimeMs: null, lastError: null }),
}) satisfies Readonly<RuntimePresentationState>;
