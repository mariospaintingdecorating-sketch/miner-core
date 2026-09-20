import { describe, it, expect } from 'vitest';
import { WalletMiningWorker } from './WalletMiningWorker';
import { DEFAULT_WALLET_MINING_WORKER_OPTIONS, SYSTEM_WALLET_MINING_RANDOM } from './WalletMiningRuntime';
import { DeterministicTimerSource, DeterministicMiniEpochSource, DeterministicIdentitySource, DeterministicStartLimiter, FakeMiningNativeAdapter, FakeNativeMiner, flushMiningMicrotasks, deferredValue } from './testing/DeterministicMiningFakes';
const identity={walletId:'w',endpoints:['https://invalid.example'],appId:'0x'+'30'.padStart(64,'0'),minerAddress:'0:'+'ab'.repeat(32),publicKey:'cd'.repeat(32),secretKey:'synthetic-only'};
function fixture(remaining=330000, limiter?: DeterministicStartLimiter) {
  const timer=new DeterministicTimerSource(); const epoch=new DeterministicMiniEpochSource('1000',remaining);
  const miner=new FakeNativeMiner({tapSum:280n}); const adapter=new FakeMiningNativeAdapter();adapter.enqueueMiner(miner);
  const worker=new WalletMiningWorker('w',{nativeAdapter:adapter,epochSource:epoch,identitySource:new DeterministicIdentitySource(),timerSource:timer,startDispatchLimiter:limiter});
  return {timer,epoch,miner,adapter,worker};
}
describe('0.2.1 production policy, real worker with synthetic SDK',()=>{
  it('uses a 126-second session and sends exactly 70 paced taps, first after 1720 ms',async()=>{
    const f=fixture(); expect((await f.worker.start(identity)).status).toBe('STARTED');
    expect(f.miner.durations).toEqual([126000]);expect(f.miner.addTapCalls).toBe(0);
    f.timer.advanceBy(1719);await flushMiningMicrotasks();expect(f.miner.addTapCalls).toBe(0);
    f.timer.advanceBy(1);await flushMiningMicrotasks();expect(f.miner.addTapCalls).toBe(1);
    for(let i=1;i<70;i++){f.timer.advanceBy(1720);await flushMiningMicrotasks();}
    expect(f.miner.addTapCalls).toBe(70);expect(f.timer.nowMs()).toBe(120400);
    f.timer.advanceBy(4000);await flushMiningMicrotasks();expect(f.miner.addTapCalls).toBe(70);
    expect(f.worker.snapshot().baselineTapSum).toBe('280');
    expect(f.worker.snapshot().confirmedTapDelta).toBeNull();
  });
  it('uses the eight-position cycle without a cross-wallet cursor',()=>{
    const get=SYSTEM_WALLET_MINING_RANDOM.tapCoordinates;
    expect(get(0)).toEqual({x:120,y:120});expect(get(7)).toEqual({x:105,y:185});expect(get(8)).toEqual(get(0));
  });
  it.each([0,1000,144999])('waits instead of starting a shortened session at %i ms',async(remaining)=>{
    const f=fixture(remaining);expect((await f.worker.start(identity)).status).toBe('WAITING_EPOCH');
    expect(f.adapter.inputs).toHaveLength(0);expect(f.miner.startCalls).toBe(0);
  });
  it('allows the exact 145000 ms boundary',async()=>{
    const f=fixture(145000);expect((await f.worker.start(identity)).status).toBe('STARTED');expect(f.miner.durations).toEqual([126000]);
  });
  it('rechecks the window after waiting for a start slot',async()=>{
    const gate=deferredValue<void>();const f=fixture(330000,new DeterministicStartLimiter(gate.promise));
    const start=f.worker.start(identity);await flushMiningMicrotasks(24);f.epoch.update('1000',10000);gate.resolve();
    expect((await start).status).toBe('CANCELLED');expect(f.miner.startCalls).toBe(0);expect(f.miner.freeCalls).toBe(1);
  });
  it('does not start the old epoch after the epoch changes during a wait',async()=>{
    const gate=deferredValue<void>();const f=fixture(330000,new DeterministicStartLimiter(gate.promise));
    const start=f.worker.start(identity);await flushMiningMicrotasks(24);f.epoch.update('2000',330000);gate.resolve();
    expect((await start).status).toBe('CANCELLED');expect(f.miner.startCalls).toBe(0);
  });
  it('cancels the first scheduled tap after manual Stop',async()=>{
    const f=fixture();await f.worker.start(identity);void f.worker.stop('OPERATOR');
    f.timer.advanceBy(1720);await flushMiningMicrotasks();expect(f.miner.addTapCalls).toBe(0);expect(f.worker.snapshot().desiredMining).toBe(false);
  });
  it('does not burst pending taps after the event loop is delayed',async()=>{
    const f=fixture();await f.worker.start(identity);f.timer.advanceBy(10000);await flushMiningMicrotasks();
    expect(f.miner.addTapCalls).toBe(1);expect(f.timer.nextDelayMs()).toBe(DEFAULT_WALLET_MINING_WORKER_OPTIONS.tapIntervalMs);
  });
  it('a deferred late-window start can continue in the next epoch without resetting credentials',async()=>{
    const f=fixture(1000);await f.worker.start(identity);f.epoch.update('2000',330000);
    f.timer.advanceBy(5000);await flushMiningMicrotasks(40);expect(f.miner.startCalls).toBe(1);
  });
});
