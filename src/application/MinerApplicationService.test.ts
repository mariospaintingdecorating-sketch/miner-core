import { describe, expect, it, vi } from 'vitest';
import { CoreEventEmitter } from '../shared/events';
import type { ComposedWalletMiningRuntime } from '../mining/composition/createWalletMiningRuntime';
import type { WalletMiningSnapshot } from '../mining/WalletMiningRuntime';
import { MiningRuntimeRouter } from './MiningRuntimeRouter';
import {
  MinerApplicationService,
  type ComputerShutdownRequester,
} from './MinerApplicationService';
import { RewardLedger } from './RewardLedger';
import { WalletRegistry } from './WalletRegistry';
import type { WalletMiningWorkerProductAdapter } from './WalletMiningWorkerProductAdapter';
import type { RuntimePresentationState } from './runtimeState';
import type {
  MainEpochStartPersistenceSnapshot,
  MainEpochStartStorageContract,
} from '../storage';

describe('MinerApplicationService with WalletMiningWorker only', () => {
  it('routes one wallet START and STOP through the new wallet-local runtime', async () => {
    const context = fixture(2);

    await expect(context.service.startWalletMining('wallet-1')).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'started',
      walletId: 'wallet-1',
    });
    expect(context.runtime('wallet-1').start).toHaveBeenCalledOnce();
    expect(context.router.engine('wallet-1')).toBe('NEW_WALLET_WORKER');
    expect(context.runtimeOrNull('wallet-2')).toBeNull();

    await expect(context.service.stopWalletMining('wallet-1')).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'stopped',
      walletId: 'wallet-1',
    });
    expect(context.runtime('wallet-1').stop).toHaveBeenCalledWith('OPERATOR');
  });

  it('dispatches all 13 wallets with one-second preparation spacing and parallel isolation', async () => {
    vi.useFakeTimers();
    try {
      const context = fixture(13);
      const operation = context.service.startAllMining();
      await vi.advanceTimersByTimeAsync(12_000);
      const result = await operation;

      expect(result).toMatchObject({
        accepted: true,
        reasonCode: 'all-started',
      });
      expect(result.results).toHaveLength(13);
      expect(context.createdWalletIds()).toHaveLength(13);
      expect(context.createdWalletIds().every((walletId) =>
        context.runtime(walletId).start.mock.calls.length === 1,
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps another wallet running when one wallet is stopped', async () => {
    const context = fixture(2);
    await context.service.startWalletMining('wallet-1');
    await context.service.startWalletMining('wallet-2');

    await context.service.stopWalletMining('wallet-1');

    expect(context.runtime('wallet-1').snapshot().state).toBe('IDLE');
    expect(context.runtime('wallet-2').snapshot().state).toBe('MINING');
    expect(context.runtime('wallet-2').stop).not.toHaveBeenCalled();
  });

  it('keeps global uptime active until the final requested wallet stops', async () => {
    const context = fixture(2);
    expect(context.service.activeMiningWalletCount()).toBe(0);
    await context.service.startWalletMining('wallet-1');
    expect(context.service.activeMiningWalletCount()).toBe(1);
    await context.service.startWalletMining('wallet-2');
    expect(context.service.activeMiningWalletCount()).toBe(2);
    expect(context.service.getOperatorState().globalMiningUptime.active).toBe(true);

    await context.service.stopWalletMining('wallet-1');
    expect(context.service.activeMiningWalletCount()).toBe(1);
    expect(context.service.getOperatorState().globalMiningUptime.active).toBe(true);
    await context.service.stopWalletMining('wallet-2');
    expect(context.service.activeMiningWalletCount()).toBe(0);
    expect(context.service.getOperatorState().globalMiningUptime.active).toBe(false);
  });

  it('arms timed completion without starting any wallet runtime', async () => {
    vi.useFakeTimers();
    try {
      const context = fixture(13);

      await expect(
        context.service.startTimedMining(1, false),
      ).resolves.toMatchObject({
        accepted: true,
        reasonCode: 'timed-mining-armed',
      });

      expect(context.createdWalletIds()).toEqual([]);
      expect(context.service.getOperatorState().timedMining).toMatchObject({
        status: 'running',
        shutdownAfterCompletion: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops an existing runtime before requesting the optional computer shutdown', async () => {
    vi.useFakeTimers();
    try {
      const computerShutdown = {
        shutdownComputer: vi.fn(async () => 'requested' as const),
      };
      const context = fixture(2, computerShutdown);
      await context.service.startWalletMining('wallet-1');

      await context.service.startTimedMining(1, true);
      expect(context.createdWalletIds()).toEqual(['wallet-1']);
      expect(computerShutdown.shutdownComputer).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);

      expect(context.runtime('wallet-1').stop).toHaveBeenCalledWith(
        'TIMED_COMPLETION',
      );
      expect(computerShutdown.shutdownComputer).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes a persisted delayed Main Epoch start and clears it before execution', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const persistence = mainEpochStartPersistence();
      const context = fixture(
        1,
        undefined,
        persistence,
        persistedMainEpochStart(11_000),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(context.runtime('wallet-1').start).toHaveBeenCalledOnce();
      expect(context.service.getOperatorState().mainEpochStart).toMatchObject({
        status: 'completed',
        failureCode: null,
      });
      expect(persistence.saveMainEpochStartSchedule).toHaveBeenCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed delayed start when no wallet can be started', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    try {
      const persistence = mainEpochStartPersistence();
      const context = fixture(
        0,
        undefined,
        persistence,
        persistedMainEpochStart(21_000),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(context.service.getOperatorState().mainEpochStart).toMatchObject({
        status: 'failed',
        failureCode: 'start-failed',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes the router exactly once during application shutdown', async () => {
    const context = fixture(1);
    await context.service.startWalletMining('wallet-1');
    await Promise.all([context.service.dispose(), context.service.dispose()]);

    expect(context.disposeFactory).toHaveBeenCalledOnce();
  });
});

function fixture(
  walletCount: number,
  computerShutdown: ComputerShutdownRequester = {
    shutdownComputer: vi.fn(async () => 'unsupported' as const),
  },
  mainEpochStartStorage?: MainEpochStartStorageContract,
  initialMainEpochStart?: Readonly<MainEpochStartPersistenceSnapshot> | null,
) {
  const wallets = Array.from({ length: walletCount }, (_, index) => ({
    id: `wallet-${index + 1}`,
    name: `Wallet ${index + 1}`,
    onboardingStatus: 'ready' as const,
    connectionReference: `connection-${index + 1}`,
    miningCredentialReference: `credential-${index + 1}`,
  }));
  const registry = new WalletRegistry(wallets);
  const eventBus = new CoreEventEmitter();
  const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>();
  const adapters = new Map<string, WalletMiningWorkerProductAdapter>();
  const disposeFactory = vi.fn(async () => {
    await Promise.all([...runtimes.values()].map((runtime) => runtime.dispose()));
    runtimes.clear();
  });
  const router = new MiningRuntimeRouter({
    newRuntimeFactory: {
      create: vi.fn(async (walletId: string) => {
        const runtime = fakeRuntime(walletId);
        runtimes.set(walletId, runtime);
        return runtime;
      }),
      runtime: (walletId) => runtimes.get(walletId) ?? null,
      walletIds: () => [...runtimes.keys()],
      release: vi.fn(async (walletId: string) => {
        await runtimes.get(walletId)?.dispose();
        runtimes.delete(walletId);
      }),
      dispose: disposeFactory,
    },
    shadowPreflight: {
      check: vi.fn(async (walletId: string) => readyPreflight(walletId)),
    },
    createProductAdapter: (runtime) => {
      const adapter = fakeProductAdapter(runtime);
      adapters.set(runtime.walletId, adapter);
      return adapter;
    },
    newProductSessionAvailable: (walletId) =>
      registry.wallet(walletId)?.session === null,
  });
  const service = new MinerApplicationService(
    eventBus,
    undefined,
    { walletRegistry: registry, rewardLedger: new RewardLedger() },
    undefined,
    undefined,
    undefined,
    undefined,
    eventBus,
    undefined,
    undefined,
    computerShutdown,
    router,
    mainEpochStartStorage,
    initialMainEpochStart,
  );
  return {
    service,
    router,
    disposeFactory,
    createdWalletIds: () => [...runtimes.keys()],
    runtimeOrNull: (walletId: string) => runtimes.get(walletId) ?? null,
    runtime: (walletId: string) => {
      const runtime = runtimes.get(walletId);
      if (!runtime) throw new Error(`Missing runtime ${walletId}`);
      return runtime;
    },
  };
}

function mainEpochStartPersistence(): MainEpochStartStorageContract {
  return {
    loadMainEpochStartSchedule: vi.fn(async () => null),
    saveMainEpochStartSchedule: vi.fn(async () => undefined),
  };
}

function persistedMainEpochStart(
  targetStartAt: number,
): Readonly<MainEpochStartPersistenceSnapshot> {
  return Object.freeze({
    status: 'waiting-for-delay',
    armedAt: targetStartAt - 2_000,
    baselineMainEpoch: '78600000',
    delayHours: 1,
    detectedMainEpoch: '78862000',
    epochDetectedAt: targetStartAt - 1_000,
    targetStartAt,
  });
}

function fakeRuntime(walletId: string) {
  let snapshot = miningSnapshot(walletId);
  return {
    walletId,
    start: vi.fn(async () => {
      snapshot = Object.freeze({
        ...snapshot,
        state: 'MINING' as const,
        desiredMining: true,
        sessionId: `${walletId}:session`,
        generationToken: `${walletId}:generation`,
      });
      return Object.freeze({
        status: 'STARTED' as const,
        sessionId: snapshot.sessionId,
        generationToken: snapshot.generationToken,
      });
    }),
    stop: vi.fn(async () => {
      snapshot = Object.freeze({
        ...snapshot,
        state: 'IDLE' as const,
        desiredMining: false,
        disposalStatus: 'SUCCEEDED' as const,
      });
      return Object.freeze({ status: 'STOPPED' as const, terminalOutcome: null });
    }),
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    dispose: vi.fn(async () => {
      snapshot = Object.freeze({ ...snapshot, state: 'DISPOSED' as const });
    }),
  } satisfies ComposedWalletMiningRuntime;
}

function fakeProductAdapter(
  runtime: Readonly<ComposedWalletMiningRuntime>,
): WalletMiningWorkerProductAdapter {
  return {
    noteStopReason: vi.fn(),
    detach: vi.fn(),
    activeSessionIdentity: () => {
      const snapshot = runtime.snapshot();
      return snapshot.sessionId
        ? Object.freeze({ sessionId: snapshot.sessionId, generation: 1 })
        : null;
    },
    generationForToken: () => 1,
    rewardSynchronization: () => Object.freeze({
      status: 'idle' as const,
      walletId: null,
      sessionId: null,
      generation: null,
      confirmedRewardCount: 0,
      code: null,
    }),
    isTerminal: () => {
      const state = runtime.snapshot().state;
      return state === 'IDLE' || state === 'DISPOSED';
    },
    presentation: (base: Readonly<RuntimePresentationState>) => Object.freeze({
      ...base,
      runtimeStatus: runtime.snapshot().state === 'MINING' ? 'running' : 'idle',
    }),
  } as unknown as WalletMiningWorkerProductAdapter;
}

function readyPreflight(walletId: string) {
  return Object.freeze({
    walletId,
    status: 'READY' as const,
    checkedAt: '2026-08-12T00:00:00.000Z',
    checks: Object.freeze({
      walletRegistered: true,
      configurationReady: true,
      endpointsValid: true,
      appIdValid: true,
      credentialReferencePresent: true,
      credentialAvailable: true,
      credentialParsed: true,
      walletIdentityMatches: true,
      minerAddressValid: true,
      publicKeyValid: true,
      keyBindingVerified: true,
      validatedIdentityCreated: true,
      newRuntimeConstructible: true,
    }),
    blockers: Object.freeze([]),
  });
}

function miningSnapshot(walletId: string): Readonly<WalletMiningSnapshot> {
  return Object.freeze({
    walletId,
    state: 'IDLE',
    sessionId: null,
    generationToken: null,
    miniEpoch: 'epoch-a',
    desiredMining: false,
    queuedLocalTaps: 0,
    nativeComputedTaps: 0,
    computationCompletedTaps: null,
    baselineTapSum: null,
    latestTapSum: null,
    confirmedTapDelta: null,
    submissionStaggerMs: null,
    terminalOutcome: null,
    failureStage: null,
    errorCategory: null,
    rewardStatus: 'NOT_REQUESTED',
    disposalStatus: 'NOT_STARTED',
    quarantined: false,
    lastCallbackAction: null,
    lastCallbackSequence: null,
    transitionObservationDerived: false,
  });
}
