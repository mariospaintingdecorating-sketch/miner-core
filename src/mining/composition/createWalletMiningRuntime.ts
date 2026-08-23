import {
  type CanonicalMiniEpochSource,
  type MiningNativeAdapter,
  type ValidatedMiningIdentity,
  type WalletMiningDiagnosticSink,
  type WalletMiningIdentitySource,
  type WalletMiningPrepareDispatchLimiter,
  type WalletMiningQueuePressureController,
  type WalletMiningRandomSource,
  type WalletMiningRewardDispatchLimiter,
  type WalletMiningStartDispatchLimiter,
  type WalletMiningSubmissionGuard,
  type WalletMiningSnapshot,
  type WalletMiningStartResult,
  type WalletMiningStopReason,
  type WalletMiningStopResult,
  type WalletMiningTimerSource,
  type WalletMiningWorkerOptions,
} from '../WalletMiningRuntime';
import {
  WalletMiningWorker,
  type WalletMiningWorkerDependencies,
} from '../WalletMiningWorker';
import { immutableValidatedMiningIdentity } from '../product/MiningIdentityAdapter';

export interface ComposedWalletMiningRuntime {
  readonly walletId: string;
  start(): Promise<Readonly<WalletMiningStartResult>>;
  stop(
    reason: WalletMiningStopReason,
  ): Promise<Readonly<WalletMiningStopResult>>;
  snapshot(): Readonly<WalletMiningSnapshot>;
  subscribe(
    listener: (snapshot: Readonly<WalletMiningSnapshot>) => void,
  ): () => void;
  dispose(): Promise<void>;
}

export type WalletMiningWorkerBuilder = (
  walletId: string,
  dependencies: Readonly<WalletMiningWorkerDependencies>,
) => WalletMiningWorker;

export interface CreateWalletMiningRuntimeInput {
  readonly validatedIdentity: Readonly<ValidatedMiningIdentity>;
  readonly canonicalEpochSource: CanonicalMiniEpochSource;
  readonly nativeAdapter: MiningNativeAdapter;
  readonly identitySource: WalletMiningIdentitySource;
  readonly timerSource?: WalletMiningTimerSource;
  readonly randomSource?: WalletMiningRandomSource;
  readonly prepareLimiter?: WalletMiningPrepareDispatchLimiter;
  readonly startLimiter?: WalletMiningStartDispatchLimiter;
  readonly queuePressureController?: WalletMiningQueuePressureController;
  readonly rewardLimiter?: WalletMiningRewardDispatchLimiter;
  readonly submissionGuard?: WalletMiningSubmissionGuard;
  readonly diagnostics?: WalletMiningDiagnosticSink;
  readonly automaticContinuationEnabled?: boolean;
  readonly pacingPolicy?: Partial<WalletMiningWorkerOptions>;
  readonly workerBuilder?: WalletMiningWorkerBuilder;
}

/** Dependency assembly only. The returned runtime remains operator-inactive. */
export function createWalletMiningRuntime(
  input: Readonly<CreateWalletMiningRuntimeInput>,
): Readonly<ComposedWalletMiningRuntime> {
  const identity = immutableValidatedMiningIdentity(input.validatedIdentity);
  const workerBuilder = input.workerBuilder ?? (
    (walletId, dependencies) => new WalletMiningWorker(walletId, dependencies)
  );
  const worker = workerBuilder(identity.walletId, Object.freeze({
    nativeAdapter: input.nativeAdapter,
    epochSource: input.canonicalEpochSource,
    identitySource: input.identitySource,
    ...(input.timerSource ? { timerSource: input.timerSource } : {}),
    ...(input.randomSource ? { randomSource: input.randomSource } : {}),
    ...(input.prepareLimiter
      ? { prepareDispatchLimiter: input.prepareLimiter }
      : {}),
    ...(input.startLimiter
      ? { startDispatchLimiter: input.startLimiter }
      : {}),
    ...(input.queuePressureController
      ? { queuePressureController: input.queuePressureController }
      : {}),
    ...(input.rewardLimiter
      ? { rewardDispatchLimiter: input.rewardLimiter }
      : {}),
    ...(input.submissionGuard
      ? { submissionGuard: input.submissionGuard }
      : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(input.automaticContinuationEnabled !== undefined
      ? { automaticContinuationEnabled: input.automaticContinuationEnabled }
      : {}),
    ...(input.pacingPolicy ? { options: input.pacingPolicy } : {}),
  }));

  return Object.freeze({
    walletId: identity.walletId,
    start: () => worker.start(identity),
    stop: (reason: WalletMiningStopReason) => worker.stop(reason),
    snapshot: () => worker.snapshot(),
    subscribe: (
      listener: (snapshot: Readonly<WalletMiningSnapshot>) => void,
    ) => worker.subscribe(listener),
    dispose: () => worker.dispose(),
  });
}
