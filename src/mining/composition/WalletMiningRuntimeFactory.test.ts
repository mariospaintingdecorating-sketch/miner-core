import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  MiningNativeAdapterError,
  type ValidatedMiningIdentity,
  type WalletMiningDiagnosticSink,
  type WalletMiningRewardDispatchLimiter,
} from '../WalletMiningRuntime';
import { IsolatedMiningDiagnosticSink } from '../product/IsolatedMiningDiagnosticSink';
import type { MiningIdentitySource } from '../product/MiningIdentityAdapter';
import {
  deferredValue,
  DeterministicIdentitySource,
  DeterministicMiniEpochSource,
  DeterministicPrepareLimiter,
  DeterministicStartLimiter,
  DeterministicRandomSource,
  DeterministicTimerSource,
  FakeMiningNativeAdapter,
  FakeNativeMiner,
  flushMiningMicrotasks,
  MiningDiagnosticRecorder,
} from '../testing/DeterministicMiningFakes';
import {
  createWalletMiningRuntime,
  type ComposedWalletMiningRuntime,
} from './createWalletMiningRuntime';
import {
  WalletMiningRuntimeFactory,
  type WalletMiningRuntimeFactoryDependencies,
} from './WalletMiningRuntimeFactory';

const SECRET_PREFIX = 'synthetic-secret-for-';

class SyntheticMiningIdentitySource implements MiningIdentitySource {
  readonly requests: string[] = [];
  readonly failures = new Set<string>();

  async resolve(walletId: string): Promise<Readonly<ValidatedMiningIdentity>> {
    this.requests.push(walletId);
    if (this.failures.has(walletId)) {
      throw new Error('Synthetic identity failure.');
    }
    return Object.freeze({
      walletId,
      endpoints: Object.freeze(['https://synthetic-node.invalid']),
      appId: 'synthetic-app-id',
      minerAddress: `0:${walletId}-miner`,
      publicKey: `synthetic-public-${walletId}`,
      secretKey: `${SECRET_PREFIX}${walletId}`,
    });
  }
}

class PerWalletRewardLimiter implements WalletMiningRewardDispatchLimiter {
  readonly requests: Array<readonly [string, string]> = [];
  readonly waits = new Map<string, Promise<void>>();

  async waitForDispatch(walletId: string, generationToken: string): Promise<void> {
    this.requests.push([walletId, generationToken]);
    await (this.waits.get(walletId) ?? Promise.resolve());
  }
}

interface FactoryFixture {
  readonly factory: WalletMiningRuntimeFactory;
  readonly identities: SyntheticMiningIdentitySource;
  readonly adapter: FakeMiningNativeAdapter;
  readonly epoch: DeterministicMiniEpochSource;
  readonly diagnostics: MiningDiagnosticRecorder;
  readonly limiter: PerWalletRewardLimiter;
  readonly timers: Map<string, DeterministicTimerSource>;
}

function factoryFixture(
  overrides: Partial<WalletMiningRuntimeFactoryDependencies> = {},
): FactoryFixture {
  const identities = new SyntheticMiningIdentitySource();
  const adapter = new FakeMiningNativeAdapter();
  const epoch = new DeterministicMiniEpochSource('epoch-1');
  const diagnostics = new MiningDiagnosticRecorder();
  const prepareLimiter = new DeterministicPrepareLimiter();
  const startLimiter = new DeterministicStartLimiter();
  const limiter = new PerWalletRewardLimiter();
  const timers = new Map<string, DeterministicTimerSource>();
  const dependencies: WalletMiningRuntimeFactoryDependencies = {
    miningIdentity: identities,
    nativeAdapter: adapter,
    canonicalEpochSource: epoch,
    diagnostics: new IsolatedMiningDiagnosticSink(diagnostics),
    prepareLimiter,
    startLimiter,
    rewardLimiter: limiter,
    fleetSize: () => 13,
    identitySourceFactory: () => new DeterministicIdentitySource(),
    timerSourceFactory: (walletId) => {
      const timer = new DeterministicTimerSource();
      timers.set(walletId, timer);
      return timer;
    },
    randomSourceFactory: () => new DeterministicRandomSource(),
    ...overrides,
  };
  return {
    factory: new WalletMiningRuntimeFactory(dependencies),
    identities,
    adapter,
    epoch,
    diagnostics,
    limiter,
    timers,
  };
}

function emit(
  miner: FakeNativeMiner,
  sequence: number,
  action: string,
  fields: Record<string, unknown> = {},
): void {
  miner.emit({ action, sequence, ...fields });
}

describe('disabled one-wallet composition', () => {
  it('constructs one inert runtime without native preparation', async () => {
    const context = factoryFixture();
    const runtime = await context.factory.create('wallet-a');
    expect(runtime.walletId).toBe('wallet-a');
    expect(runtime.snapshot()).toMatchObject({
      walletId: 'wallet-a',
      state: 'IDLE',
      sessionId: null,
    });
    expect(context.adapter.inputs).toHaveLength(0);
  });

  it('maps the bound validated identity exactly at native preparation', async () => {
    const context = factoryFixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    const runtime = await context.factory.create('wallet-a');
    await runtime.start();
    expect(context.adapter.inputs).toEqual([{
      walletId: undefined,
      endpoints: ['https://synthetic-node.invalid'],
      appId: 'synthetic-app-id',
      minerAddress: '0:wallet-a-miner',
      publicKey: 'synthetic-public-wallet-a',
      secretKey: `${SECRET_PREFIX}wallet-a`,
    }].map(({ walletId: _blocked, ...input }) => input));
  });

  it('passes the synthetic secret only when start reaches the native adapter', async () => {
    const context = factoryFixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    const runtime = await context.factory.create('wallet-a');
    expect(context.adapter.inputs).toHaveLength(0);
    expect(JSON.stringify(runtime)).not.toContain(SECRET_PREFIX);
    await runtime.start();
    expect(context.adapter.inputs[0]?.secretKey).toBe(
      `${SECRET_PREFIX}wallet-a`,
    );
  });

  it('keeps secrets absent from runtime snapshots', async () => {
    const context = factoryFixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    const runtime = await context.factory.create('wallet-a');
    await runtime.start();
    const serialized = JSON.stringify(runtime.snapshot());
    expect(serialized).not.toContain(SECRET_PREFIX);
    expect(serialized).not.toContain('secretKey');
  });

  it('keeps secrets absent from allowlisted worker diagnostics', async () => {
    const context = factoryFixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    const runtime = await context.factory.create('wallet-a');
    await runtime.start();
    const serialized = JSON.stringify(context.diagnostics.events);
    expect(serialized).not.toContain(SECRET_PREFIX);
    expect(serialized).not.toContain('secretKey');
  });

  it('does not start the runtime automatically after composition', async () => {
    const context = factoryFixture();
    const runtime = await context.factory.create('wallet-a');
    expect(runtime.snapshot().state).toBe('IDLE');
    expect(context.adapter.inputs).toHaveLength(0);
  });

  it('failed product identity readiness prevents worker construction', async () => {
    const identities = new SyntheticMiningIdentitySource();
    identities.failures.add('wallet-a');
    const runtimeBuilder = vi.fn(createWalletMiningRuntime);
    const context = factoryFixture({ miningIdentity: identities, runtimeBuilder });
    await expect(context.factory.create('wallet-a')).rejects.toThrow(
      'Synthetic identity failure.',
    );
    expect(runtimeBuilder).not.toHaveBeenCalled();
    expect(context.adapter.inputs).toHaveLength(0);
  });

  it('creates exactly one worker for one wallet', async () => {
    const runtimeBuilder = vi.fn(createWalletMiningRuntime);
    const context = factoryFixture({ runtimeBuilder });
    await context.factory.create('wallet-a');
    expect(runtimeBuilder).toHaveBeenCalledTimes(1);
    expect(context.factory.walletIds()).toEqual(['wallet-a']);
  });

  it('rejects a second active runtime for the same wallet', async () => {
    const context = factoryFixture();
    await context.factory.create('wallet-a');
    await expect(context.factory.create('wallet-a')).rejects.toMatchObject({
      code: 'WALLET_RUNTIME_ALREADY_EXISTS',
    });
    expect(context.identities.requests).toEqual(['wallet-a']);
  });

  it('permits replacement only after explicit release', async () => {
    const context = factoryFixture();
    const first = await context.factory.create('wallet-a');
    await expect(context.factory.create('wallet-a')).rejects.toMatchObject({
      code: 'WALLET_RUNTIME_ALREADY_EXISTS',
    });
    await context.factory.release('wallet-a');
    const second = await context.factory.create('wallet-a');
    expect(second).not.toBe(first);
    expect(context.identities.requests).toEqual(['wallet-a', 'wallet-a']);
  });
});

describe('13-wallet composition isolation', () => {
  it('constructs 13 distinct runtimes and 13 distinct native handles', async () => {
    const context = factoryFixture();
    const miners = Array.from({ length: 13 }, () => new FakeNativeMiner());
    const replacements = Array.from({ length: 13 }, () => new FakeNativeMiner());
    for (const miner of miners) context.adapter.enqueueMiner(miner);
    for (const miner of replacements) context.adapter.enqueueMiner(miner);
    const runtimes = await Promise.all(
      miners.map((_miner, index) => context.factory.create(`wallet-${index + 1}`)),
    );
    await Promise.all(runtimes.map((runtime) => runtime.start()));
    expect(new Set(runtimes).size).toBe(13);
    expect(context.adapter.inputs).toHaveLength(13);
    expect(miners.every((miner) => miner.startCalls === 1)).toBe(true);
  });

  it('uses 13 separate wallet-local generation spaces', async () => {
    const context = factoryFixture();
    for (let index = 1; index <= 13; index += 1) {
      context.adapter.enqueueMiner(new FakeNativeMiner());
    }
    const runtimes = await Promise.all(
      Array.from({ length: 13 }, (_value, index) =>
        context.factory.create(`wallet-${index + 1}`)),
    );
    await Promise.all(runtimes.map((runtime) => runtime.start()));
    const tokens = runtimes.map((runtime) => runtime.snapshot().generationToken);
    expect(new Set(tokens).size).toBe(13);
    tokens.forEach((token, index) => {
      expect(token).toContain(`wallet-${index + 1}:generation:1`);
    });
  });

  it('keeps wallet B mining when wallet A native preparation fails', async () => {
    const context = factoryFixture();
    context.adapter.enqueueFailure({
      failureStage: 'PREPARE',
      errorCategory: 'SYNTHETIC_A_FAILURE',
    });
    const minerB = new FakeNativeMiner();
    context.adapter.enqueueMiner(minerB);
    const [runtimeA, runtimeB] = await Promise.all([
      context.factory.create('wallet-a'),
      context.factory.create('wallet-b'),
    ]);
    await expect(runtimeA.start()).resolves.toMatchObject({ status: 'FAILED' });
    await expect(runtimeB.start()).resolves.toMatchObject({ status: 'STARTED' });
    expect(runtimeB.snapshot().state).toBe('MINING');
    expect(minerB.startCalls).toBe(1);
  });

  it('does not let wallet A reward delay own wallet B lifecycle', async () => {
    const rewardWait = deferredValue<void>();
    const limiter = new PerWalletRewardLimiter();
    limiter.waits.set('wallet-a', rewardWait.promise);
    const context = factoryFixture({ rewardLimiter: limiter });
    const minerA = new FakeNativeMiner();
    const minerB = new FakeNativeMiner();
    context.adapter.enqueueMiner(minerA);
    context.adapter.enqueueMiner(minerB);
    const [runtimeA, runtimeB] = await Promise.all([
      context.factory.create('wallet-a'),
      context.factory.create('wallet-b'),
    ]);
    await runtimeA.start();
    await runtimeB.start();
    emit(minerA, 1, 'computation_completed', { computationCompletedTaps: 70 });
    emit(minerA, 2, 'submit_session_root');
    emit(minerA, 3, 'submit_session_proof');
    emit(minerA, 4, 'session_accepted');
    await flushMiningMicrotasks();
    expect(runtimeA.snapshot().state).toBe('REWARDING');
    expect(runtimeB.snapshot().state).toBe('MINING');
    expect(minerB.rewardCalls).toBe(0);
    rewardWait.resolve(undefined);
    await flushMiningMicrotasks(16);
  });

  it('quarantines only wallet A when its native free fails', async () => {
    const context = factoryFixture();
    const minerA = new FakeNativeMiner({ freeFailure: true });
    const minerB = new FakeNativeMiner();
    context.adapter.enqueueMiner(minerA);
    context.adapter.enqueueMiner(minerB);
    const [runtimeA, runtimeB] = await Promise.all([
      context.factory.create('wallet-a'),
      context.factory.create('wallet-b'),
    ]);
    await runtimeA.start();
    await runtimeB.start();
    emit(minerA, 1, 'session_rejected', { errorPresent: true });
    await flushMiningMicrotasks(16);
    expect(runtimeA.snapshot()).toMatchObject({
      quarantined: true,
      disposalStatus: 'FAILED',
    });
    expect(runtimeB.snapshot()).toMatchObject({
      state: 'MINING',
      quarantined: false,
    });
  });

  it('broadcasts an epoch boundary and stops all 13 active sessions exactly once', async () => {
    const context = factoryFixture();
    const miners = Array.from({ length: 13 }, () => new FakeNativeMiner());
    const replacements = Array.from({ length: 13 }, () => new FakeNativeMiner());
    for (const miner of miners) context.adapter.enqueueMiner(miner);
    for (const miner of replacements) context.adapter.enqueueMiner(miner);
    const runtimes = await Promise.all(
      miners.map((_miner, index) => context.factory.create(`wallet-${index + 1}`)),
    );
    await Promise.all(runtimes.map((runtime) => runtime.start()));
    context.epoch.update('epoch-2');
    await flushMiningMicrotasks();
    expect(miners.every((miner) => miner.stopCalls === 1)).toBe(true);
    expect(runtimes.every(
      (runtime) => runtime.snapshot().state === 'STOP_REQUESTED',
    )).toBe(true);

    miners.forEach((miner) => {
      miner.emit({ action: 'session_accepted', sequence: 1 });
    });
    await flushMiningMicrotasks(30);
    for (const timer of context.timers.values()) timer.advanceBy(5_500);
    await flushMiningMicrotasks(30);
    expect(miners.every((miner) => miner.startCalls === 1)).toBe(true);
    expect(miners.every((miner) => miner.freeCalls === 1)).toBe(true);
    expect(replacements.every((miner) => miner.startCalls === 1)).toBe(true);
    expect(runtimes.every(
      (runtime) =>
        runtime.snapshot().state === 'MINING' &&
        runtime.snapshot().miniEpoch === 'epoch-2',
    )).toBe(true);
  });

  it('passes the same canonical, native, diagnostics and reward services to every runtime', async () => {
    const queuePressureController = Object.freeze({
      startSpacingMs: () => 5_000,
      observeQueueFailure: () => undefined,
      reportProductiveOutcome: () => undefined,
    });
    const observed: Array<{
      canonical: unknown;
      native: unknown;
      diagnostics: unknown;
      reward: unknown;
      queuePressure: unknown;
      fleetStartSlotIndex: number | undefined;
      fleetStartSlotCount: number | undefined;
    }> = [];
    const context = factoryFixture({
      queuePressureController,
      runtimeBuilder: (input) => {
        observed.push({
          canonical: input.canonicalEpochSource,
          native: input.nativeAdapter,
          diagnostics: input.diagnostics,
          reward: input.rewardLimiter,
          queuePressure: input.queuePressureController,
          fleetStartSlotIndex: input.pacingPolicy?.fleetStartSlotIndex,
          fleetStartSlotCount: input.pacingPolicy?.fleetStartSlotCount,
        });
        return createWalletMiningRuntime(input);
      },
    });
    await Promise.all(
      Array.from({ length: 13 }, (_value, index) =>
        context.factory.create(`wallet-${index + 1}`)),
    );
    for (const key of ['canonical', 'native', 'diagnostics', 'reward'] as const) {
      expect(new Set(observed.map((entry) => entry[key])).size).toBe(1);
    }
    expect(new Set(observed.map((entry) => entry.queuePressure))).toEqual(
      new Set([queuePressureController]),
    );
    expect(observed.map((entry) => entry.fleetStartSlotIndex).sort((a, b) =>
      (a ?? 0) - (b ?? 0))).toEqual(Array.from({ length: 13 }, (_value, index) => index));
    expect(new Set(observed.map((entry) => entry.fleetStartSlotCount))).toEqual(
      new Set([13]),
    );
  });

  it('has no global creation lock when one wallet identity fails', async () => {
    const identities = new SyntheticMiningIdentitySource();
    identities.failures.add('wallet-a');
    const context = factoryFixture({ miningIdentity: identities });
    const results = await Promise.allSettled([
      context.factory.create('wallet-a'),
      context.factory.create('wallet-b'),
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('fulfilled');
    expect(context.factory.walletIds()).toEqual(['wallet-b']);
  });
});

describe('factory disposal and production isolation', () => {
  it('disposes every wallet independently even when one disposal rejects', async () => {
    const disposeCalls: string[] = [];
    const context = factoryFixture({
      runtimeBuilder: (input) => ({
        walletId: input.validatedIdentity.walletId,
        start: async () => ({ status: 'FAILED', sessionId: null, generationToken: null }),
        stop: async () => ({ status: 'ALREADY_STOPPED', terminalOutcome: null }),
        snapshot: () => ({ walletId: input.validatedIdentity.walletId } as never),
        subscribe: () => () => undefined,
        dispose: async () => {
          disposeCalls.push(input.validatedIdentity.walletId);
          if (input.validatedIdentity.walletId === 'wallet-a') {
            throw new Error('synthetic disposal failure');
          }
        },
      }),
    });
    await Promise.all([
      context.factory.create('wallet-a'),
      context.factory.create('wallet-b'),
    ]);
    await expect(context.factory.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(disposeCalls.sort()).toEqual(['wallet-a', 'wallet-b']);
    expect(context.factory.walletIds()).toEqual(['wallet-a']);
  });

  it('performs no network call and creates no real Bee object in deterministic composition', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const context = factoryFixture();
      context.adapter.enqueueMiner(new FakeNativeMiner());
      const runtime = await context.factory.create('wallet-a');
      await runtime.start();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(context.adapter).toBeInstanceOf(FakeMiningNativeAdapter);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps MinerApplicationService dependent only on the router boundary', () => {
    const source = sourceFile('../../application/MinerApplicationService.ts');
    expect(source).not.toMatch(
      /WalletMiningRuntimeFactory|createWalletMiningRuntime|BeeMiningNativeAdapter/,
    );
  });

  it('composes the wallet-local runtime as the only production engine', () => {
    const source = sourceFile('../../application/createMinerApplication.ts');
    expect(source).toContain('WALLET_MINING_RUNTIME_CONSTRUCTIBILITY_INSPECTOR');
    expect(source).toContain('new WalletMiningRuntimeFactory');
    expect(source).toContain('new BeeMiningNativeAdapter');
    expect(source).toContain('new MiningRuntimeRouter');
    expect(source).toContain('automaticContinuationEnabled: true');
    expect(source).not.toContain('ENABLE_NEW_WORKER_LIVE_ACTIVATION');
    expect(source).not.toContain('legacyDirectory');
  });

  it('keeps App, WorkspacePage and automatic main startup free of new-engine imports', () => {
    const sources = [
      sourceFile('../../ui/App.tsx'),
      sourceFile('../../ui/WorkspacePage.tsx'),
      sourceFile('../../main.tsx'),
    ].join('\n');
    expect(sources).not.toMatch(
      /WalletMiningWorker|WalletMiningRuntimeFactory|createWalletMiningRuntime|BeeMiningNativeAdapter/,
    );
  });

  it('keeps the neutral composition module independent of real Bee imports', () => {
    const sources = [
      sourceFile('./createWalletMiningRuntime.ts'),
      sourceFile('./WalletMiningRuntimeFactory.ts'),
    ].join('\n');
    expect(sources).not.toContain('@teamgosh/bee-sdk');
    expect(sources).not.toContain('BeeMiningNativeAdapter');
  });
});

function sourceFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}
