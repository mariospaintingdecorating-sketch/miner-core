import { describe, expect, it } from 'vitest';
import { WalletMiningWorker } from './WalletMiningWorker';
import { MiningNativeAdapterError, type CanonicalMiniEpochSource } from './WalletMiningRuntime';
import { PRODUCTION_MINING_SESSION_POLICY } from './product/MiningSessionPolicy';
import {
  DeterministicTimerSource, DeterministicIdentitySource, DeterministicRandomSource,
  FakeMiningNativeAdapter, FakeNativeMiner, flushMiningMicrotasks, deferredValue,
  DeterministicStartLimiter, DeterministicPrepareLimiter,
} from './testing/DeterministicMiningFakes';
import { CORE_MINER_DAPP_ID } from '../shared/releaseIdentity';

const identity = Object.freeze({ walletId: 'synthetic', endpoints: ['https://synthetic.invalid'],
  appId: CORE_MINER_DAPP_ID, minerAddress: `0:${'a'.repeat(64)}`,
  publicKey: 'b'.repeat(64), secretKey: 'synthetic-only' });

function setup(input: { remaining?: number | null; observedAt?: number | null;
  startWait?: Promise<void>; prepareWait?: Promise<void>; timer?: DeterministicTimerSource } = {}) {
  const timer = input.timer ?? new DeterministicTimerSource();
  let epoch = '1000'; let remaining = input.remaining === undefined ? 330_000 : input.remaining;
  const source: CanonicalMiniEpochSource = {
    snapshot: () => ({ miniEpoch: epoch, remainingMs: remaining,
      observedAtMs: input.observedAt === undefined ? timer.nowMs() : input.observedAt }),
    subscribe: () => () => undefined,
  };
  const miner = new FakeNativeMiner(); const adapter = new FakeMiningNativeAdapter();
  adapter.enqueueMiner(miner);
  const worker = new WalletMiningWorker(identity.walletId, {
    nativeAdapter: adapter, epochSource: source, identitySource: new DeterministicIdentitySource(),
    timerSource: timer, randomSource: new DeterministicRandomSource(),
    startDispatchLimiter: new DeterministicStartLimiter(input.startWait),
    prepareDispatchLimiter: new DeterministicPrepareLimiter(input.prepareWait),
    options: PRODUCTION_MINING_SESSION_POLICY,
  });
  return { worker, miner, adapter, timer,
    change: (id: string, ms: number | null) => { epoch = id; remaining = ms; } };
}

describe('desktop production session policy', () => {
  it('keeps the exact registered hexadecimal DApp identity', () => {
    expect(CORE_MINER_DAPP_ID).toMatch(/^0x[0-9a-f]{64}$/);
    expect(CORE_MINER_DAPP_ID.endsWith('0030')).toBe(true);
    expect(CORE_MINER_DAPP_ID.endsWith('001e')).toBe(false);
  });
  it.each([null, 0, 144_999, NaN, Infinity])('does not allocate/write a Miner without a complete admission window (%s)', async (remaining) => {
    const f = setup({ remaining });
    await f.worker.start(identity);
    expect(f.worker.snapshot().state).toBe('WAITING_EPOCH');
    expect(f.worker.snapshot().desiredMining).toBe(true);
    expect(f.adapter.inputs).toHaveLength(0);
    await f.worker.stop('OPERATOR');
    expect(f.worker.snapshot().desiredMining).toBe(false);
  });
  it.each([null, -60_001, 1])('rejects an unknown, stale or future clock sample (%s)', async (observedAt) => {
    const f = setup({ observedAt }); await f.worker.start(identity);
    expect(f.adapter.inputs).toHaveLength(0);
  });
  it('allows exactly 145 seconds and sends the first tap only after 1720 ms', async () => {
    const f = setup({ remaining: 145_000 }); await f.worker.start(identity);
    expect(f.miner.durations).toEqual([126_000]);
    expect(f.miner.coordinates).toHaveLength(0);
    f.timer.advanceBy(1_719); await flushMiningMicrotasks(); expect(f.miner.coordinates).toHaveLength(0);
    f.timer.advanceBy(1); await flushMiningMicrotasks(); expect(f.miner.coordinates).toHaveLength(1);
  });
  it('dispatches exactly 70 taps at 120400 ms without a 71st', async () => {
    const f = setup(); await f.worker.start(identity);
    for (let i = 0; i < 70; i++) { f.timer.advanceBy(1_720); await flushMiningMicrotasks(); }
    expect(f.timer.nowMs()).toBe(120_400); expect(f.miner.coordinates).toHaveLength(70);
    f.timer.advanceBy(4_000); await flushMiningMicrotasks(); expect(f.miner.coordinates).toHaveLength(70);
  });
  it('does not catch up in bursts after an 8-second event-loop delay', async () => {
    class DelayedClock extends DeterministicTimerSource {
      offset = 0; override nowMs() { return super.nowMs() + this.offset; }
    }
    const timer = new DelayedClock(); const f = setup({ timer }); await f.worker.start(identity);
    timer.offset = 8_000;
    for (let i = 0; i < 70; i++) {
      const before = f.miner.coordinates.length; timer.advanceBy(1_720); await flushMiningMicrotasks();
      expect(f.miner.coordinates.length - before).toBeLessThanOrEqual(1);
    }
    expect(f.miner.coordinates).toHaveLength(68);
  });
  it('rechecks the epoch after prepare spacing before constructing a native Miner', async () => {
    const gate = deferredValue<void>(); const f = setup({ prepareWait: gate.promise });
    const start = f.worker.start(identity); await flushMiningMicrotasks();
    f.change('2000', 330_000); gate.resolve(); await start;
    expect(f.adapter.inputs).toHaveLength(0); expect(f.miner.durations).toHaveLength(0);
  });
  it.each([['2000',330_000],['1000',144_999]] as const)('rechecks the epoch/window after start spacing (%s, %s)', async (epoch, remaining) => {
    const gate = deferredValue<void>(); const f = setup({ startWait: gate.promise });
    const start = f.worker.start(identity); await flushMiningMicrotasks();
    f.change(epoch, remaining); gate.resolve(); await start;
    expect(f.miner.durations).toHaveLength(0); expect(f.miner.freeCalls).toBe(1);
  });
  it('manual Stop while awaiting admission prevents delayed Start', async () => {
    const gate = deferredValue<void>(); const f = setup({ startWait: gate.promise });
    const start = f.worker.start(identity); await flushMiningMicrotasks();
    const stop = f.worker.stop('OPERATOR'); gate.resolve(); await Promise.all([start, stop]);
    f.timer.advanceBy(10_000); await flushMiningMicrotasks();
    expect(f.miner.coordinates).toHaveLength(0); expect(f.miner.durations).toHaveLength(0);
    expect(f.worker.snapshot().desiredMining).toBe(false);
  });
  it('alternating queue/network failures cannot replenish the preparation retry budget', async () => {
    const timer = new DeterministicTimerSource(); let calls = 0;
    const worker = new WalletMiningWorker(identity.walletId, {
      nativeAdapter: { createMiner: async () => { calls++;
        throw new MiningNativeAdapterError({ failureStage: 'PREPARE', errorCategory: calls % 2 ? 'NETWORK' : 'QUEUE' }); } },
      epochSource: { snapshot: () => ({ miniEpoch: '1000', remainingMs: 330_000, observedAtMs: timer.nowMs() }), subscribe: () => () => undefined },
      identitySource: new DeterministicIdentitySource(), timerSource: timer,
      options: PRODUCTION_MINING_SESSION_POLICY,
    });
    await worker.start(identity); await flushMiningMicrotasks();
    for (let i = 0; i < 20; i++) { timer.runNext(); await flushMiningMicrotasks(); }
    expect(calls).toBeGreaterThan(1); expect(calls).toBeLessThanOrEqual(6);
    const finishedCalls = calls; timer.advanceBy(3_600_000); await flushMiningMicrotasks();
    expect(calls).toBe(finishedCalls);
  });
});
