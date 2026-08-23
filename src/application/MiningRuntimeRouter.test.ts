import { describe, expect, it, vi } from 'vitest';
import type { ComposedWalletMiningRuntime } from '../mining/composition/createWalletMiningRuntime';
import type { WalletMiningSnapshot } from '../mining/WalletMiningRuntime';
import type { ShadowMiningPreflightResult } from '../mining/product/ShadowMiningPreflight';
import {
  MiningRuntimeRouter,
  type MiningStartSource,
} from './MiningRuntimeRouter';
import type { WalletMiningWorkerProductAdapter } from './WalletMiningWorkerProductAdapter';

describe('MiningRuntimeRouter new-engine-only ownership', () => {
  it.each([
    'EXPLICIT_WALLET',
    'START_ALL',
    'MAIN_EPOCH',
  ] satisfies MiningStartSource[])(
    'routes %s through WalletMiningWorker',
    async (source) => {
      const context = fixture();
      const result = await context.router.start({ walletId: 'wallet-a', source });

      expect(result).toMatchObject({
        accepted: true,
        engine: 'NEW_WALLET_WORKER',
        reasonCode: 'started',
      });
      expect(context.create).toHaveBeenCalledTimes(1);
      expect(context.runtime.start).toHaveBeenCalledTimes(1);
      expect(context.router.ownership('wallet-a')).toBe('NEW');
    },
  );

  it('never starts without an explicit wallet identity', async () => {
    const context = fixture();
    await expect(context.router.start({
      walletId: null,
      source: 'EXPLICIT_WALLET',
    })).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'new-worker-wallet-required',
      engine: 'NEW_WALLET_WORKER',
    });
    expect(context.create).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent wallet starts and preserves one native owner', async () => {
    const context = fixture();
    const [first, second] = await Promise.all([
      context.router.start({ walletId: 'wallet-a', source: 'START_ALL' }),
      context.router.start({ walletId: 'wallet-a', source: 'START_ALL' }),
    ]);

    expect(first).toEqual(second);
    expect(context.create).toHaveBeenCalledTimes(1);
    expect(context.runtime.start).toHaveBeenCalledTimes(1);
  });

  it('cancels a start during worker construction without waiting on itself', async () => {
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const context = fixture('READY', creationGate);
    const start = context.router.start({
      walletId: 'wallet-a',
      source: 'EXPLICIT_WALLET',
    });
    await vi.waitFor(() => expect(context.create).toHaveBeenCalledTimes(1));

    const stop = context.router.stop('wallet-a', 'OPERATOR');
    releaseCreation();

    await expect(start).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'runtime-not-active',
    });
    await expect(stop).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'stopped',
    });
    expect(context.release).toHaveBeenCalledWith('wallet-a');
    expect(context.runtime.start).not.toHaveBeenCalled();
    expect(context.router.ownership('wallet-a')).toBe('NONE');
  });

  it('stops and releases only the wallet-local worker', async () => {
    const context = fixture();
    await context.router.start({ walletId: 'wallet-a', source: 'EXPLICIT_WALLET' });

    await expect(context.router.stop('wallet-a', 'OPERATOR')).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'stopped',
      engine: 'NEW_WALLET_WORKER',
    });
    expect(context.runtime.stop).toHaveBeenCalledWith('OPERATOR');
    await expect(context.router.release('wallet-a')).resolves.toBe(true);
    expect(context.release).toHaveBeenCalledWith('wallet-a');
    expect(context.router.ownership('wallet-a')).toBe('NONE');
  });

  it('blocks allocation when the authoritative preflight is not ready', async () => {
    const context = fixture('BLOCKED');
    await expect(context.router.start({
      walletId: 'wallet-a',
      source: 'EXPLICIT_WALLET',
    })).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'new-worker-shadow-blocked',
    });
    expect(context.create).not.toHaveBeenCalled();
  });
});

function fixture(
  status: ShadowMiningPreflightResult['status'] = 'READY',
  createGate: Promise<void> = Promise.resolve(),
) {
  let snapshot = miningSnapshot();
  const runtime = {
    walletId: 'wallet-a',
    start: vi.fn(async () => {
      snapshot = Object.freeze({
        ...snapshot,
        state: 'MINING' as const,
        desiredMining: true,
        sessionId: 'session-a',
        generationToken: 'generation-a',
      });
      return Object.freeze({
        status: 'STARTED' as const,
        sessionId: 'session-a',
        generationToken: 'generation-a',
      });
    }),
    stop: vi.fn(async () => {
      snapshot = Object.freeze({
        ...snapshot,
        state: 'IDLE' as const,
        desiredMining: false,
        disposalStatus: 'SUCCEEDED' as const,
      });
      return Object.freeze({
        status: 'STOPPED' as const,
        terminalOutcome: null,
      });
    }),
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    dispose: vi.fn(async () => undefined),
  } satisfies ComposedWalletMiningRuntime;
  const runtimes = new Map<string, Readonly<ComposedWalletMiningRuntime>>();
  const create = vi.fn(async (walletId: string) => {
    await createGate;
    runtimes.set(walletId, runtime);
    return runtime;
  });
  const release = vi.fn(async (walletId: string) => {
    await runtimes.get(walletId)?.dispose();
    runtimes.delete(walletId);
  });
  const adapter = {
    noteStopReason: vi.fn(),
    detach: vi.fn(),
    activeSessionIdentity: () => snapshot.sessionId
      ? Object.freeze({ sessionId: snapshot.sessionId, generation: 1 })
      : null,
    generationForToken: () => 1,
    rewardSynchronization: () => Object.freeze({
      status: 'idle' as const,
      walletId: null,
      sessionId: null,
      generation: null,
      confirmedRewardCount: 0,
      code: null,
    }),
    isTerminal: () => snapshot.state === 'IDLE' || snapshot.state === 'DISPOSED',
    presentation: (base: unknown) => ({
      ...(base as object),
      runtimeStatus: snapshot.state === 'MINING' ? 'running' : 'idle',
    }),
  } as unknown as WalletMiningWorkerProductAdapter;
  const router = new MiningRuntimeRouter({
    newRuntimeFactory: {
      create,
      runtime: (walletId) => runtimes.get(walletId) ?? null,
      walletIds: () => [...runtimes.keys()],
      release,
      dispose: vi.fn(async () => undefined),
    },
    shadowPreflight: {
      check: vi.fn(async (walletId: string) => Object.freeze({
        walletId,
        status,
        checkedAt: '2026-08-12T00:00:00.000Z',
        checks: Object.freeze({
          walletRegistered: status === 'READY',
          configurationReady: status === 'READY',
          endpointsValid: status === 'READY',
          appIdValid: status === 'READY',
          credentialReferencePresent: status === 'READY',
          credentialAvailable: status === 'READY',
          credentialParsed: status === 'READY',
          walletIdentityMatches: status === 'READY',
          minerAddressValid: status === 'READY',
          publicKeyValid: status === 'READY',
          keyBindingVerified: status === 'READY',
          validatedIdentityCreated: status === 'READY',
          newRuntimeConstructible: status === 'READY',
        }),
        blockers: Object.freeze([]),
      })),
    },
    createProductAdapter: () => adapter,
    newProductSessionAvailable: () => true,
  });
  return { router, runtime, create, release };
}

function miningSnapshot(): Readonly<WalletMiningSnapshot> {
  return Object.freeze({
    walletId: 'wallet-a',
    state: 'IDLE',
    sessionId: null,
    generationToken: null,
    miniEpoch: null,
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
