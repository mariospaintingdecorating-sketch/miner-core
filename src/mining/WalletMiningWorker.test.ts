import { describe, expect, it } from 'vitest';
import {
  MiningNativeAdapterError,
  type SafeMiningFailure,
  type SafeNativeCallback,
  type ValidatedMiningIdentity,
  type WalletMiningWorkerOptions,
  type WalletMiningWorkerState,
  type WalletMiningSubmissionGuard,
  type WalletMiningQueuePressureController,
} from './WalletMiningRuntime';
import { WalletMiningWorker } from './WalletMiningWorker';
import {
  deferredValue,
  DeterministicIdentitySource,
  DeterministicMiniEpochSource,
  DeterministicPrepareLimiter,
  DeterministicRandomSource,
  DeterministicRewardLimiter,
  DeterministicStartLimiter,
  DeterministicTimerSource,
  FakeMiningNativeAdapter,
  FakeNativeMiner,
  flushMiningMicrotasks,
  MiningDiagnosticRecorder,
} from './testing/DeterministicMiningFakes';

const SYNTHETIC_IDENTITY: Readonly<ValidatedMiningIdentity> = Object.freeze({
  walletId: 'wallet-a',
  endpoints: Object.freeze(['https://synthetic.invalid']),
  appId: 'synthetic-app-id',
  minerAddress: '0:synthetic-miner',
  publicKey: 'synthetic-public-key',
  secretKey: 'synthetic-secret-key',
});

interface Fixture {
  readonly worker: WalletMiningWorker;
  readonly miner: FakeNativeMiner;
  readonly adapter: FakeMiningNativeAdapter;
  readonly timer: DeterministicTimerSource;
  readonly epoch: DeterministicMiniEpochSource;
  readonly diagnostics: MiningDiagnosticRecorder;
  sequence: number;
}

class RecordingSubmissionGuard implements WalletMiningSubmissionGuard {
  enterCalls = 0;
  releaseCalls = 0;
  waitCalls = 0;

  enter(): () => void {
    this.enterCalls += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseCalls += 1;
    };
  }

  async transitionToPostSubmission(): Promise<() => void> {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseCalls += 1;
    };
  }

  async acquireIdleLease(): Promise<() => void> {
    this.waitCalls += 1;
    return () => undefined;
  }

  async waitUntilIdle(): Promise<void> {
    this.waitCalls += 1;
  }
}

class RecordingQueuePressureController
  implements WalletMiningQueuePressureController
{
  readonly observations: Array<{
    walletId: string;
    miniEpoch: string;
    generationToken: string;
    failure: Readonly<SafeMiningFailure>;
  }> = [];
  readonly outcomes: Array<{
    walletId: string;
    miniEpoch: string;
    failure: Readonly<SafeMiningFailure> | null;
  }> = [];

  startSpacingMs(): number {
    return 0;
  }

  observeQueueFailure(
    walletId: string,
    miniEpoch: string,
    generationToken: string,
    failure: Readonly<SafeMiningFailure>,
  ): void {
    this.observations.push({ walletId, miniEpoch, generationToken, failure });
  }

  reportProductiveOutcome(
    walletId: string,
    miniEpoch: string,
    failure: Readonly<SafeMiningFailure> | null,
  ): void {
    this.outcomes.push({ walletId, miniEpoch, failure });
  }
}

function fixture(input: Readonly<{
  miner?: FakeNativeMiner;
  adapter?: FakeMiningNativeAdapter;
  timer?: DeterministicTimerSource;
  epoch?: DeterministicMiniEpochSource;
  random?: DeterministicRandomSource;
  rewardLimiter?: DeterministicRewardLimiter;
  prepareLimiter?: DeterministicPrepareLimiter;
  startLimiter?: DeterministicStartLimiter;
  queuePressureController?: WalletMiningQueuePressureController;
  submissionGuard?: WalletMiningSubmissionGuard;
  automaticContinuationEnabled?: boolean;
  options?: Partial<WalletMiningWorkerOptions>;
}> = {}): Fixture {
  const miner = input.miner ?? new FakeNativeMiner();
  const adapter = input.adapter ?? new FakeMiningNativeAdapter();
  if (!input.adapter) adapter.enqueueMiner(miner);
  const timer = input.timer ?? new DeterministicTimerSource();
  const epoch = input.epoch ?? new DeterministicMiniEpochSource();
  const diagnostics = new MiningDiagnosticRecorder();
  const worker = new WalletMiningWorker('wallet-a', {
    nativeAdapter: adapter,
    epochSource: epoch,
    identitySource: new DeterministicIdentitySource(),
    timerSource: timer,
    randomSource: input.random ?? new DeterministicRandomSource(),
    diagnostics,
    prepareDispatchLimiter: input.prepareLimiter,
    startDispatchLimiter: input.startLimiter,
    queuePressureController: input.queuePressureController,
    submissionGuard: input.submissionGuard,
    rewardDispatchLimiter: input.rewardLimiter,
    automaticContinuationEnabled: input.automaticContinuationEnabled,
    options: input.options,
  });
  return { worker, miner, adapter, timer, epoch, diagnostics, sequence: 0 };
}

function emit(
  context: Fixture,
  action: string,
  data: Partial<SafeNativeCallback> = {},
): number {
  const sequence = data.sequence ?? ++context.sequence;
  context.miner.emit({ action, sequence, ...data });
  return sequence;
}

async function start(context: Fixture): Promise<void> {
  const result = await context.worker.start(SYNTHETIC_IDENTITY);
  expect(result.status).toBe('STARTED');
}

async function queueTaps(
  context: Fixture,
  target: number,
  nativeCallbacks = true,
): Promise<void> {
  while (context.worker.snapshot().queuedLocalTaps < target) {
    const snapshot = context.worker.snapshot();
    if (
      nativeCallbacks &&
      snapshot.nativeComputedTaps < snapshot.queuedLocalTaps
    ) {
      emit(context, 'tap_computed');
      continue;
    }
    expect(context.timer.runNext()).toBe(true);
    await flushMiningMicrotasks();
  }
  while (
    nativeCallbacks &&
    context.worker.snapshot().nativeComputedTaps < target
  ) {
    emit(context, 'tap_computed');
  }
}

async function accepted(context: Fixture, taps = 70): Promise<void> {
  emit(context, 'computation_completed', { computationCompletedTaps: taps });
  emit(context, 'submit_session_root');
  emit(context, 'submit_session_proof');
  emit(context, 'session_accepted');
  await flushMiningMicrotasks(16);
}

describe('WalletMiningWorker', () => {
  it('runs a normal 70-tap accepted session and retains its native Miner', async () => {
    const context = fixture();
    await start(context);
    await queueTaps(context, 70);

    expect(context.miner.addTapCalls).toBe(70);
    expect(context.worker.snapshot()).toMatchObject({
      queuedLocalTaps: 70,
      nativeComputedTaps: 70,
      state: 'MINING',
    });
    expect(context.miner.stopCalls).toBe(0);
    await accepted(context);

    expect(context.worker.snapshot()).toMatchObject({
      state: 'WAITING_EPOCH',
      terminalOutcome: 'ACCEPTED',
      rewardStatus: 'SUCCEEDED',
      disposalStatus: 'SUCCEEDED',
    });
    expect(context.miner.rewardCalls).toBe(1);
    expect(context.miner.freeCalls).toBe(1);
    expect(context.miner.durations).toEqual([135_000]);
  });

  it('holds the shared submission guard from computation through terminal callback', async () => {
    const guard = new RecordingSubmissionGuard();
    const context = fixture({ submissionGuard: guard });
    await start(context);

    expect(guard.waitCalls).toBe(2);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    expect(guard.enterCalls).toBe(3);
    expect(guard.releaseCalls).toBe(0);

    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(guard.releaseCalls).toBe(1);
  });

  it('retries a just-started native worker lifecycle tap once after 1 second', async () => {
    const lifecycleFailure = Object.freeze({
      failureStage: 'TAP_EXECUTION' as const,
      errorCategory: 'UNKNOWN',
      nativeTopLevelMessage: 'Mining worker is not running.',
    });
    const context = fixture({
      miner: new FakeNativeMiner({
        addTapFailures: [lifecycleFailure, null],
      }),
    });

    await start(context);

    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      queuedLocalTaps: 0,
      terminalOutcome: null,
    });
    expect(context.miner.addTapCalls).toBe(1);
    expect(context.miner.stopCalls).toBe(0);
    expect(context.timer.nextDelayMs()).toBe(1_000);
    expect(context.diagnostics.events).toContainEqual(
      expect.objectContaining({
        kind: 'LIFECYCLE',
        failureStage: 'TAP_EXECUTION',
        errorCategory: 'UNKNOWN',
        nativeTopLevelMessage: 'Mining worker is not running.',
      }),
    );

    context.timer.advanceBy(999);
    await flushMiningMicrotasks();
    expect(context.miner.addTapCalls).toBe(1);

    context.timer.advanceBy(1);
    await flushMiningMicrotasks();
    expect(context.miner.addTapCalls).toBe(2);
    expect(context.miner.stopCalls).toBe(0);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      queuedLocalTaps: 1,
      terminalOutcome: null,
    });
    expect(context.timer.nextDelayMs()).toBe(1_730);
  });

  it('does not retry an add_tap error outside the retryable lifecycle classification', async () => {
    const context = fixture({
      miner: new FakeNativeMiner({
        addTapFailures: [Object.freeze({
          failureStage: 'TAP_EXECUTION' as const,
          errorCategory: 'CONTRACT',
          nativeTopLevelMessage: 'Contract rejected the tap.',
        })],
      }),
    });

    await start(context);
    expect(context.miner.addTapCalls).toBe(1);
    expect(context.miner.stopCalls).toBe(1);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'STOP_REQUESTED',
      queuedLocalTaps: 0,
    });
    expect(context.timer.nextDelayMs()).toBe(600_000);
  });

  it('cancels the pending native lifecycle retry when the operator stops', async () => {
    const context = fixture({
      miner: new FakeNativeMiner({
        addTapFailures: [Object.freeze({
          failureStage: 'TAP_EXECUTION' as const,
          errorCategory: 'UNKNOWN',
          nativeTopLevelMessage: 'No running workers.',
        })],
      }),
    });
    await start(context);
    expect(context.timer.nextDelayMs()).toBe(1_000);

    const stopping = context.worker.stop('OPERATOR');
    context.timer.advanceBy(1_000);
    await flushMiningMicrotasks();

    expect(context.miner.addTapCalls).toBe(1);
    expect(context.miner.stopCalls).toBe(1);
    emit(context, 'status_updated', { status: 'removed' });
    await stopping;
  });

  it('emits the complete allowlisted first-live telemetry stage sequence', async () => {
    const context = fixture({
      random: new DeterministicRandomSource({ x: 200, y: 360 }, 0),
    });
    await start(context);
    await queueTaps(context, 70);
    await accepted(context);
    const stages = context.diagnostics.events
      .map((event) => event.stage)
      .filter((stage): stage is NonNullable<typeof stage> => stage !== null);
    for (const stage of [
      'NATIVE_PREPARE_START',
      'NATIVE_PREPARE_RESULT',
      'BASELINE_TAP_SUM_READ',
      'NATIVE_MINING_START',
      'FIRST_TAP',
      'TAP_70',
      'COMPUTATION_COMPLETED',
      'ROOT_CALLBACK',
      'PROOF_CALLBACK',
      'TERMINAL',
      'LATEST_TAP_SUM_READ',
      'REWARD_START',
      'REWARD_RESULT',
      'NATIVE_FREE_START',
      'NATIVE_FREE_RESULT',
    ] as const) {
      expect(stages).toContain(stage);
    }
    expect(context.worker.snapshot()).toMatchObject({
      baselineTapSum: '0',
      latestTapSum: '0',
      confirmedTapDelta: '0',
      submissionStaggerMs: null,
    });
  });

  it('finishes preparation before waiting for the separate native start gate', async () => {
    const startPermit = deferredValue<void>();
    const prepareLimiter = new DeterministicPrepareLimiter();
    const startLimiter = new DeterministicStartLimiter(startPermit.promise);
    const context = fixture({ prepareLimiter, startLimiter });

    const starting = context.worker.start(SYNTHETIC_IDENTITY);
    await flushMiningMicrotasks(16);

    expect(prepareLimiter.requests).toHaveLength(1);
    expect(startLimiter.requests).toHaveLength(1);
    expect(context.worker.snapshot().state).toBe('READY');
    expect(context.miner.startCalls).toBe(0);

    startPermit.resolve(undefined);
    await starting;
    expect(context.miner.startCalls).toBe(1);
    expect(context.worker.snapshot().state).toBe('MINING');
  });

  it('cancels a ready generation instead of starting it after the mini epoch changes', async () => {
    const startPermit = deferredValue<void>();
    const startLimiter = new DeterministicStartLimiter(startPermit.promise);
    const context = fixture({ startLimiter });
    const replacement = new FakeNativeMiner();
    context.adapter.enqueueMiner(replacement);

    const staleStart = context.worker.start(SYNTHETIC_IDENTITY);
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot().state).toBe('READY');

    context.epoch.update('epoch-2');
    await flushMiningMicrotasks(24);
    expect(context.miner.startCalls).toBe(0);
    expect(context.miner.freeCalls).toBe(1);

    startPermit.resolve(undefined);
    await staleStart;
    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(24);

    expect(replacement.startCalls).toBe(1);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      miniEpoch: 'epoch-2',
    });
  });

  it('disables automatic next generation for the controlled first-live mode', async () => {
    const context = fixture({ automaticContinuationEnabled: false });
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    context.epoch.update('epoch-2');
    await flushMiningMicrotasks(8);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'IDLE',
      desiredMining: false,
      terminalOutcome: 'ACCEPTED',
    });
    expect(context.adapter.inputs).toHaveLength(1);
  });

  it('keeps a root callback error pending for an authoritative outcome', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root', {
      errorPresent: true,
      errorCategory: 'ROOT_NODE_ERROR',
    });
    expect(context.worker.snapshot()).toMatchObject({
      state: 'WAITING_RESULT',
      terminalOutcome: null,
      failureStage: 'ROOT_SUBMIT',
      errorCategory: 'ROOT_NODE_ERROR',
    });
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot().terminalOutcome).toBe('ACCEPTED');
  });

  it('keeps a proof callback error pending for an authoritative outcome', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof', {
      errorPresent: true,
      errorCategory: 'PROOF_NODE_ERROR',
    });
    expect(context.worker.snapshot()).toMatchObject({
      state: 'WAITING_RESULT',
      terminalOutcome: null,
      failureStage: 'PROOF_SUBMIT',
      errorCategory: 'PROOF_NODE_ERROR',
    });
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'ACCEPTED',
      rewardStatus: 'SUCCEEDED',
    });
  });

  it('keeps the first pending proof failure until an authoritative outcome', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof', {
      errorPresent: true,
      serverCode: 11,
    });
    emit(context, 'submit_session_proof');

    expect(context.worker.snapshot()).toMatchObject({
      state: 'WAITING_RESULT',
      terminalOutcome: null,
      failureStage: 'PROOF_SUBMIT',
      errorCategory: 'PROOF_SUBMIT_FAILED',
    });
  });

  it('keeps misleading root-failure text classified as proof failure by action', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof', {
      errorPresent: true,
      errorCategory: 'SUBMIT_SESSION_ROOT_FAILED_TEXT',
    });
    expect(context.worker.snapshot().failureStage).toBe('PROOF_SUBMIT');
    expect(context.worker.snapshot().terminalOutcome).toBeNull();
  });

  it('preserves safe proof failure details through terminal callback grace', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof', {
      errorPresent: true,
      nativeTopLevelMessage: 'Submit session root failed',
      serverCode: 11,
    });
    expect(context.worker.snapshot()).toMatchObject({
      state: 'WAITING_RESULT',
      terminalOutcome: null,
      failureStage: 'PROOF_SUBMIT',
    });
    emit(context, 'status_updated', { status: 'finished' });
    context.timer.advanceBy(30_000);
    await flushMiningMicrotasks(16);

    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'AMBIGUOUS',
      failureStage: 'PROOF_SUBMIT',
      errorCategory: 'PROOF_SUBMIT_FAILED',
    });
    expect(
      [...context.diagnostics.events].reverse().find(
        (event) => event.kind === 'TERMINAL_OUTCOME',
      ),
    ).toMatchObject({
      failureStage: 'PROOF_SUBMIT',
      nativeTopLevelMessage: 'Submit session root failed',
      serverCode: 11,
    });
    for (const stage of [
      'LATEST_TAP_SUM_READ',
      'NATIVE_FREE_START',
      'NATIVE_FREE_RESULT',
    ] as const) {
      expect(
        [...context.diagnostics.events].reverse().find(
          (event) => event.stage === stage,
        ),
      ).toMatchObject({ failureStage: null, errorCategory: null });
    }
  });

  it('uses terminal callback grace after a proof callback error', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof', {
      errorPresent: true,
      serverCode: 11,
    });

    expect(context.worker.snapshot()).toMatchObject({
      state: 'WAITING_RESULT',
      terminalOutcome: null,
      failureStage: 'PROOF_SUBMIT',
    });
    emit(context, 'status_updated', { status: 'finished' });
    context.timer.advanceBy(30_000);
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'AMBIGUOUS',
      failureStage: 'PROOF_SUBMIT',
      disposalStatus: 'SUCCEEDED',
    });
    expect(context.miner.freeCalls).toBe(1);
  });

  it('rebuilds the native Miner after an ambiguous proof queue failure', async () => {
    const replacement = new FakeNativeMiner();
    const context = fixture();
    context.adapter.enqueueMiner(replacement);
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 69 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof', {
      errorPresent: true,
      failureStage: 'PROOF_SUBMIT',
      errorCategory: 'QUEUE',
      serverCode: 621,
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
    emit(context, 'status_updated', { status: 'finished' });
    context.timer.advanceBy(30_000);
    await flushMiningMicrotasks(16);

    expect(context.worker.snapshot()).toMatchObject({
      state: 'WAITING_EPOCH',
      terminalOutcome: 'AMBIGUOUS',
      failureStage: 'PROOF_SUBMIT',
      errorCategory: 'QUEUE',
      disposalStatus: 'SUCCEEDED',
    });
    expect(context.miner.freeCalls).toBe(1);

    context.epoch.update('epoch-2');
    await flushMiningMicrotasks(20);
    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(20);
    expect(context.adapter.inputs).toHaveLength(2);
    expect(replacement.startCalls).toBe(1);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      miniEpoch: 'epoch-2',
      terminalOutcome: null,
    });
  });

  it('frees a not-ready retained Miner before retrying with a fresh handle', async () => {
    const notReady = new FakeNativeMiner({ canStart: false });
    const replacement = new FakeNativeMiner();
    const adapter = new FakeMiningNativeAdapter();
    adapter.enqueueMiner(notReady);
    adapter.enqueueMiner(replacement);
    const context = fixture({ adapter });

    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('FAILED');
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'BACKOFF',
      terminalOutcome: 'AMBIGUOUS',
      errorCategory: 'MINER_NOT_READY',
      disposalStatus: 'SUCCEEDED',
    });
    expect(notReady.freeCalls).toBe(1);

    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(20);
    expect(context.adapter.inputs).toHaveLength(2);
    expect(replacement.startCalls).toBe(1);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      terminalOutcome: null,
    });
  });

  it('accepts an authoritative callback during proof failure grace', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof', { errorPresent: true });
    emit(context, 'status_updated', { status: 'finished' });

    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);

    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'ACCEPTED',
      rewardStatus: 'SUCCEEDED',
      failureStage: null,
    });
  });

  it('treats SessionRejected as an authoritative rejected outcome', async () => {
    const context = fixture();
    await start(context);
    const stop = context.worker.stop('OPERATOR');
    emit(context, 'session_rejected', { errorPresent: true });
    await stop;
    expect(context.worker.snapshot().terminalOutcome).toBe('REJECTED');
    expect(context.miner.rewardCalls).toBe(0);
  });

  it('does not convert finished without accepted or rejected into success', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'status_updated', { status: 'finished' });
    expect(context.worker.snapshot().terminalOutcome).toBeNull();
    context.timer.advanceBy(30_000);
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot().terminalOutcome).toBe('AMBIGUOUS');
  });

  it('does not convert removed without accepted or rejected into success', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'status_updated', { status: 'removed' });
    expect(context.worker.snapshot().terminalOutcome).toBeNull();
    context.timer.advanceBy(30_000);
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot().terminalOutcome).toBe('AMBIGUOUS');
  });

  it('ignores a stale callback from a previous generation', async () => {
    const context = fixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    context.epoch.update('epoch-2');
    await flushMiningMicrotasks(16);
    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot().generationToken).toContain('generation:2');

    context.miner.emitForStart(0, {
      action: 'session_rejected',
      sequence: 500,
    });
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      terminalOutcome: null,
    });
    expect(context.diagnostics.events.at(-1)).toMatchObject({
      kind: 'STALE_CALLBACK',
      stale: true,
    });
  });

  it('ignores delayed acceptance from a previous generation', async () => {
    const context = fixture();
    const replacement = new FakeNativeMiner();
    context.adapter.enqueueMiner(replacement);
    await start(context);
    emit(context, 'session_rejected');
    await flushMiningMicrotasks(16);
    context.epoch.update('epoch-2');
    await flushMiningMicrotasks(16);
    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(16);
    context.miner.emitForStart(0, {
      action: 'session_accepted',
      sequence: 501,
    });
    expect(context.worker.snapshot().terminalOutcome).toBeNull();
    expect(context.miner.rewardCalls).toBe(0);
    expect(replacement.startCalls).toBe(1);
  });

  it('cancels STOP during PREPARING and frees a late Miner without start', async () => {
    const allocation = deferredValue<FakeNativeMiner>();
    const adapter = new FakeMiningNativeAdapter([allocation.promise]);
    const context = fixture({ adapter });
    const starting = context.worker.start(SYNTHETIC_IDENTITY);
    await flushMiningMicrotasks();
    expect(context.worker.snapshot().state).toBe('PREPARING');

    const stopping = context.worker.stop('OPERATOR');
    expect(context.worker.snapshot().terminalOutcome).toBe('CANCELLED');
    allocation.resolve(context.miner);
    expect((await starting).status).toBe('CANCELLED');
    expect((await stopping).status).toBe('STOPPED');
    expect(context.miner.startCalls).toBe(0);
    expect(context.miner.freeCalls).toBe(1);
    expect(context.worker.snapshot().state).toBe('IDLE');
  });

  it('handles STOP during READY before Miner.start', async () => {
    const context = fixture();
    let stopping: Promise<unknown> | null = null;
    const unsubscribe = context.worker.subscribe((snapshot) => {
      if (snapshot.state === 'READY' && !stopping) {
        stopping = context.worker.stop('OPERATOR');
      }
    });
    const result = await context.worker.start(SYNTHETIC_IDENTITY);
    await stopping;
    unsubscribe();
    expect(result.status).toBe('CANCELLED');
    expect(context.miner.startCalls).toBe(0);
    expect(context.miner.freeCalls).toBe(1);
  });

  it('issues exactly one stop for STOP during MINING', async () => {
    const context = fixture();
    await start(context);
    const stopping = context.worker.stop('OPERATOR');
    expect(context.worker.snapshot().state).toBe('STOP_REQUESTED');
    expect(context.miner.stopCalls).toBe(1);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_rejected');
    await stopping;
    expect(context.miner.stopCalls).toBe(1);
  });

  it('does not interrupt submission for STOP during ROOT', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    const stopping = context.worker.stop('OPERATOR');
    expect(context.miner.stopCalls).toBe(0);
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await stopping;
    expect(context.miner.stopCalls).toBe(0);
    expect(context.worker.snapshot().state).toBe('IDLE');
  });

  it('observes and safely handles STOP during PROOF', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    let stopping: Promise<unknown> | null = null;
    const unsubscribe = context.worker.subscribe((snapshot) => {
      if (snapshot.state === 'SUBMITTING_PROOF' && !stopping) {
        stopping = context.worker.stop('OPERATOR');
      }
    });
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await stopping;
    unsubscribe();
    expect(context.miner.stopCalls).toBe(0);
    expect(context.worker.snapshot().state).toBe('IDLE');
  });

  it('allows STOP during WAITING_RESULT without a second protocol action', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    const stopping = context.worker.stop('OPERATOR');
    expect(context.worker.snapshot().state).toBe('WAITING_RESULT');
    emit(context, 'session_rejected');
    await stopping;
    expect(context.miner.stopCalls).toBe(0);
  });

  it('makes repeated STOP idempotent', async () => {
    const context = fixture();
    await start(context);
    const first = context.worker.stop('OPERATOR');
    const second = context.worker.stop('STOP_ALL');
    expect(context.miner.stopCalls).toBe(1);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_rejected');
    await Promise.all([first, second]);
    expect(context.miner.stopCalls).toBe(1);
  });

  it('terminalizes a rejected asynchronous utility stop without a duplicate stop', async () => {
    const stopResult = deferredValue<void>();
    const context = fixture({
      miner: new FakeNativeMiner({ stop: stopResult.promise }),
    });
    await start(context);

    const stopping = context.worker.stop('OPERATOR');
    expect(context.miner.stopCalls).toBe(1);
    expect(context.worker.snapshot().state).toBe('STOP_REQUESTED');
    stopResult.reject(new MiningNativeAdapterError({
      failureStage: 'NATIVE_COMPUTATION',
      errorCategory: 'BEE_UTILITY_PROCESS_EXIT',
    }));
    await stopping;

    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'NATIVE_ERROR',
      failureStage: 'NATIVE_COMPUTATION',
      errorCategory: 'BEE_UTILITY_PROCESS_EXIT',
    });
    expect(context.miner.stopCalls).toBe(1);
  });

  it('stops and submits an active partial session when the epoch changes after 10 taps', async () => {
    const context = fixture();
    await start(context);
    await queueTaps(context, 10);
    context.epoch.update('epoch-2');
    expect(context.worker.snapshot().state).toBe('STOP_REQUESTED');
    expect(context.miner.stopCalls).toBe(1);
    expect(context.worker.snapshot().queuedLocalTaps).toBe(10);
  });

  it('stops and submits an active partial session when the epoch changes after 69 taps', async () => {
    const context = fixture();
    await start(context);
    await queueTaps(context, 69);
    context.epoch.update('epoch-2');
    expect(context.miner.stopCalls).toBe(1);
    expect(context.worker.snapshot().state).toBe('STOP_REQUESTED');
    expect(context.worker.snapshot().queuedLocalTaps).toBe(69);
  });

  it('does not issue a duplicate stop when the epoch changes after queued tap 70', async () => {
    const context = fixture();
    await start(context);
    await queueTaps(context, 70);
    expect(context.miner.stopCalls).toBe(0);
    context.epoch.update('epoch-2');
    expect(context.miner.stopCalls).toBe(1);
  });

  it('classifies native duration before target as partial', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'removed');
    expect(context.worker.snapshot().terminalOutcome).toBeNull();
    context.timer.advanceBy(30_000);
    await flushMiningMicrotasks();
    expect(context.worker.snapshot().terminalOutcome).toBe(
      'PARTIAL_NATIVE_SESSION',
    );
  });

  it('keeps an accepted session authoritative when Bee finalizes fewer than 70 taps', async () => {
    const context = fixture();
    await start(context);
    await queueTaps(context, 70, false);
    emit(context, 'computation_completed', { computationCompletedTaps: 69 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'ACCEPTED',
      computationCompletedTaps: 69,
      rewardStatus: 'SUCCEEDED',
    });
    expect(context.miner.rewardCalls).toBe(1);
  });

  it('submits and rewards an accepted partial session after a mini-epoch boundary', async () => {
    const context = fixture({ automaticContinuationEnabled: false });
    await start(context);
    await queueTaps(context, 35);

    context.epoch.update('epoch-2');
    expect(context.miner.stopCalls).toBe(1);
    emit(context, 'computation_completed', { computationCompletedTaps: 35 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);

    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'ACCEPTED',
      queuedLocalTaps: 35,
      computationCompletedTaps: 35,
      rewardStatus: 'SUCCEEDED',
    });
    expect(context.miner.rewardCalls).toBe(1);
  });

  it('tracks exactly 70 valid tap_computed callbacks separately from queued taps', async () => {
    const context = fixture();
    await start(context);
    await queueTaps(context, 70);
    expect(context.worker.snapshot()).toMatchObject({
      queuedLocalTaps: 70,
      nativeComputedTaps: 70,
    });
  });

  it('does not overcount a duplicate tap callback sequence', async () => {
    const context = fixture();
    await start(context);
    const sequence = emit(context, 'tap_computed');
    context.miner.emit({ action: 'tap_computed', sequence });
    expect(context.worker.snapshot().nativeComputedTaps).toBe(1);
    expect(context.diagnostics.events.at(-1)?.kind).toBe('DUPLICATE_CALLBACK');
  });

  it('does not regress state for a duplicated root callback', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    const sequence = emit(context, 'submit_session_root');
    context.miner.emit({ action: 'submit_session_root', sequence });
    expect(context.worker.snapshot().state).toBe('WAITING_INTERVAL');
    expect(
      context.diagnostics.events.filter(
        (event) => event.callbackAction === 'submit_session_root',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorPresent: null,
          failureStage: null,
          errorCategory: null,
        }),
      ]),
    );
  });

  it('does not regress state for a duplicated proof callback', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    const sequence = emit(context, 'submit_session_proof');
    context.miner.emit({ action: 'submit_session_proof', sequence });
    expect(context.worker.snapshot().state).toBe('WAITING_RESULT');
  });

  it('does not duplicate reward for duplicated accepted callbacks', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'session_accepted');
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(context.miner.rewardCalls).toBe(1);
  });

  it('classifies queue overflow during prepare without exposing raw errors', async () => {
    const adapter = new FakeMiningNativeAdapter();
    adapter.enqueueFailure({
      failureStage: 'PREPARE',
      errorCategory: 'QUEUE_OVERFLOW',
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
    const context = fixture({ adapter });
    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('FAILED');
    await flushMiningMicrotasks();
    expect(context.worker.snapshot()).toMatchObject({
      state: 'BACKOFF',
      terminalOutcome: 'NATIVE_ERROR',
      errorCategory: 'QUEUE_OVERFLOW',
    });
  });

  it('retries queue overflow during prepare in the same mini-epoch after 8 seconds', async () => {
    const adapter = new FakeMiningNativeAdapter();
    adapter.enqueueFailure({
      failureStage: 'PREPARE',
      errorCategory: 'QUEUE_OVERFLOW',
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
    adapter.enqueueMiner(new FakeNativeMiner());
    const context = fixture({ adapter, automaticContinuationEnabled: true });

    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('FAILED');
    await flushMiningMicrotasks();
    expect(context.worker.snapshot().state).toBe('BACKOFF');
    expect(context.adapter.inputs).toHaveLength(1);
    expect(context.timer.nextDelayMs()).toBe(8_000);

    context.timer.advanceBy(7_999);
    await flushMiningMicrotasks();
    expect(context.adapter.inputs).toHaveLength(1);

    context.timer.advanceBy(1);
    await flushMiningMicrotasks(16);

    expect(context.adapter.inputs).toHaveLength(2);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      miniEpoch: 'epoch-1',
      terminalOutcome: null,
    });
  });

  it('uses the dedicated 8, 16, 30 second queue prepare backoff sequence', async () => {
    const adapter = new FakeMiningNativeAdapter();
    for (let index = 0; index < 3; index += 1) {
      adapter.enqueueFailure({
        failureStage: 'PREPARE',
        errorCategory: 'QUEUE_OVERFLOW',
        nodeExtensionCode: 'QUEUE_OVERFLOW',
      });
    }
    adapter.enqueueMiner(new FakeNativeMiner());
    const context = fixture({ adapter, automaticContinuationEnabled: true });

    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('FAILED');
    await flushMiningMicrotasks();
    for (const delayMs of [8_000, 16_000, 30_000]) {
      expect(context.timer.nextDelayMs()).toBe(delayMs);
      context.timer.advanceBy(delayMs);
      await flushMiningMicrotasks(16);
    }

    expect(context.adapter.inputs).toHaveLength(4);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      miniEpoch: 'epoch-1',
    });
  });

  it('retries a transient Bee Account 205 network prepare failure', async () => {
    const adapter = new FakeMiningNativeAdapter();
    adapter.enqueueFailure({
      failureStage: 'PREPARE',
      errorCategory: 'NETWORK',
      kitModule: 'Account',
      kitCode: 205,
    });
    adapter.enqueueMiner(new FakeNativeMiner());
    const context = fixture({ adapter, automaticContinuationEnabled: true });

    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('FAILED');
    await flushMiningMicrotasks();
    expect(context.timer.nextDelayMs()).toBe(2_000);

    context.timer.advanceBy(2_000);
    await flushMiningMicrotasks(16);
    expect(context.adapter.inputs).toHaveLength(2);
    expect(context.worker.snapshot().state).toBe('MINING');
  });

  it('stops scheduling prepare retries after the fifth retry fails', async () => {
    const adapter = new FakeMiningNativeAdapter();
    for (let index = 0; index < 6; index += 1) {
      adapter.enqueueFailure({
        failureStage: 'PREPARE',
        errorCategory: 'NETWORK',
        kitModule: 'Account',
        kitCode: 205,
      });
    }
    const context = fixture({ adapter, automaticContinuationEnabled: true });

    await context.worker.start(SYNTHETIC_IDENTITY);
    await flushMiningMicrotasks();
    for (const delayMs of [2_000, 4_000, 8_000, 16_000, 30_000]) {
      expect(context.timer.nextDelayMs()).toBe(delayMs);
      context.timer.advanceBy(delayMs);
      await flushMiningMicrotasks(16);
    }

    expect(context.adapter.inputs).toHaveLength(6);
    expect(context.worker.snapshot().state).toBe('BACKOFF');
    expect(context.timer.nextDelayMs()).toBeNull();
  });

  it('cancels a pending prepare retry when the operator stops from BACKOFF', async () => {
    const adapter = new FakeMiningNativeAdapter();
    adapter.enqueueFailure({
      failureStage: 'PREPARE',
      errorCategory: 'QUEUE_OVERFLOW',
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
    adapter.enqueueMiner(new FakeNativeMiner());
    const context = fixture({ adapter, automaticContinuationEnabled: true });

    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('FAILED');
    await flushMiningMicrotasks();
    expect(context.timer.nextDelayMs()).toBe(8_000);
    await context.worker.stop('OPERATOR');
    context.timer.advanceBy(30_000);
    await flushMiningMicrotasks(16);

    expect(context.adapter.inputs).toHaveLength(1);
    expect(context.worker.snapshot().state).toBe('IDLE');
  });

  it('cancels a pending prepare retry when the worker is disposed', async () => {
    const adapter = new FakeMiningNativeAdapter();
    adapter.enqueueFailure({
      failureStage: 'PREPARE',
      errorCategory: 'QUEUE_OVERFLOW',
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
    adapter.enqueueMiner(new FakeNativeMiner());
    const context = fixture({ adapter, automaticContinuationEnabled: true });

    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('FAILED');
    await flushMiningMicrotasks();
    expect(context.timer.nextDelayMs()).toBe(8_000);
    await context.worker.dispose();
    context.timer.advanceBy(30_000);
    await flushMiningMicrotasks(16);

    expect(context.adapter.inputs).toHaveLength(1);
    expect(context.worker.snapshot().state).toBe('DISPOSED');
  });

  it('cancels the old prepare retry and starts once in the new mini-epoch', async () => {
    const adapter = new FakeMiningNativeAdapter();
    adapter.enqueueFailure({
      failureStage: 'PREPARE',
      errorCategory: 'QUEUE_OVERFLOW',
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
    adapter.enqueueMiner(new FakeNativeMiner());
    const context = fixture({ adapter, automaticContinuationEnabled: true });

    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('FAILED');
    await flushMiningMicrotasks();
    context.epoch.update('epoch-2');
    await flushMiningMicrotasks(16);
    context.timer.advanceBy(30_000);
    await flushMiningMicrotasks(16);

    expect(context.adapter.inputs).toHaveLength(2);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      miniEpoch: 'epoch-2',
    });
  });

  it('classifies queue overflow during root without retrying submission', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root', {
      errorPresent: true,
      errorCategory: 'QUEUE_OVERFLOW',
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
    await flushMiningMicrotasks();
    expect(context.worker.snapshot().failureStage).toBe('ROOT_SUBMIT');
    expect(context.adapter.inputs).toHaveLength(1);
  });

  it('classifies queue overflow during proof without retrying submission', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof', {
      errorPresent: true,
      errorCategory: 'QUEUE_OVERFLOW',
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
    await flushMiningMicrotasks();
    expect(context.worker.snapshot().failureStage).toBe('PROOF_SUBMIT');
    expect(context.adapter.inputs).toHaveLength(1);
  });

  it('reports queue pressure immediately and one productive terminal outcome', async () => {
    const queuePressureController = new RecordingQueuePressureController();
    const context = fixture({
      queuePressureController,
      options: { settlementTimeoutMs: 1_000 },
    });
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root', {
      errorPresent: true,
      errorCategory: 'QUEUE',
      serverCode: 621,
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });

    expect(queuePressureController.observations).toHaveLength(1);
    expect(queuePressureController.outcomes).toHaveLength(0);
    context.timer.advanceBy(1_000);
    await flushMiningMicrotasks(16);

    expect(queuePressureController.observations).toHaveLength(1);
    expect(queuePressureController.outcomes).toEqual([
      expect.objectContaining({
        walletId: 'wallet-a',
        miniEpoch: 'epoch-1',
        failure: expect.objectContaining({
          failureStage: 'ROOT_SUBMIT',
          errorCategory: 'QUEUE',
        }),
      }),
    ]);
  });

  it('blocks a second native start for the same wallet and mini-epoch', async () => {
    const secondMiner = new FakeNativeMiner();
    const context = fixture();
    context.adapter.enqueueMiner(secondMiner);
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    await context.worker.stop('OPERATOR');

    const secondStart = await context.worker.start(SYNTHETIC_IDENTITY);
    await flushMiningMicrotasks(16);

    expect(secondStart.status).toBe('FAILED');
    expect(secondMiner.startCalls).toBe(0);
    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'CANCELLED',
      errorCategory: 'DUPLICATE_PRODUCTIVE_SESSION_BLOCKED',
    });
  });

  it('preserves a root queue failure when the generic settlement timeout wins', async () => {
    const context = fixture({ options: { settlementTimeoutMs: 1_000 } });
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root', {
      errorPresent: true,
      errorCategory: 'QUEUE',
      serverCode: 621,
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });

    context.timer.advanceBy(1_000);
    await flushMiningMicrotasks(16);

    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'TIMEOUT',
      failureStage: 'ROOT_SUBMIT',
      errorCategory: 'QUEUE',
    });
    expect(
      [...context.diagnostics.events].reverse().find(
        (event) => event.kind === 'TERMINAL_OUTCOME',
      ),
    ).toMatchObject({
      failureStage: 'ROOT_SUBMIT',
      errorCategory: 'QUEUE',
      serverCode: 621,
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
  });

  it('terminalizes an unresolved settlement as TIMEOUT without quarantining a successfully freed Miner', async () => {
    const context = fixture({ options: { settlementTimeoutMs: 1_000 } });
    await start(context);
    const stopping = context.worker.stop('OPERATOR');
    context.timer.advanceBy(1_000);
    await stopping;
    expect(context.worker.snapshot().terminalOutcome).toBe('TIMEOUT');
    expect(context.worker.snapshot().quarantined).toBe(false);
  });

  it('starts the current mini epoch after an old settlement times out and cleanup succeeds', async () => {
    const epoch = new DeterministicMiniEpochSource('epoch-1');
    const context = fixture({
      epoch,
      options: { settlementTimeoutMs: 1_000 },
    });
    context.adapter.enqueueMiner(new FakeNativeMiner());
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root');
    epoch.update('epoch-2');
    context.timer.advanceBy(1_000);
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'BACKOFF',
      terminalOutcome: 'TIMEOUT',
      quarantined: false,
      disposalStatus: 'SUCCEEDED',
    });
    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(16);
    expect(context.adapter.inputs).toHaveLength(2);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      miniEpoch: 'epoch-2',
      quarantined: false,
    });
  });

  it('bounds reward with a timeout while preserving ACCEPTED', async () => {
    const reward = deferredValue<void>();
    const context = fixture({
      miner: new FakeNativeMiner({ reward: reward.promise }),
      options: { rewardTimeoutMs: 1_000 },
    });
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks();
    expect(context.worker.snapshot().state).toBe('REWARDING');
    context.timer.advanceBy(1_000);
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'ACCEPTED',
      rewardStatus: 'TIMED_OUT',
    });
  });

  it('keeps accepted mining accepted when reward fails', async () => {
    const context = fixture({
      miner: new FakeNativeMiner({ reward: Promise.reject(new Error('synthetic')) }),
    });
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot()).toMatchObject({
      terminalOutcome: 'ACCEPTED',
      rewardStatus: 'FAILED',
    });
  });

  it('quarantines the wallet after free failure', async () => {
    const context = fixture({ miner: new FakeNativeMiner({ freeFailure: true }) });
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'DISPOSING',
      terminalOutcome: 'ACCEPTED',
      disposalStatus: 'FAILED',
      quarantined: true,
    });
    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('FAILED');
  });

  it('rebuilds the native Miner for the next confirmed epoch', async () => {
    const context = fixture();
    const replacement = new FakeNativeMiner();
    context.adapter.enqueueMiner(replacement);
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    context.epoch.update('epoch-2');
    await flushMiningMicrotasks(20);
    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(20);
    expect(context.adapter.inputs).toHaveLength(2);
    expect(context.miner.startCalls).toBe(1);
    expect(context.miner.freeCalls).toBe(1);
    expect(replacement.startCalls).toBe(1);
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      miniEpoch: 'epoch-2',
    });
  });

  it('waits for native duration at the target and an operator stop issues exactly once', async () => {
    const context = fixture();
    await start(context);
    await queueTaps(context, 70);
    expect(context.miner.stopCalls).toBe(0);
    const stopping = context.worker.stop('OPERATOR');
    expect(context.miner.stopCalls).toBe(1);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await stopping;
  });

  it('never issues duplicate reward across terminal callbacks', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'session_accepted');
    emit(context, 'removed');
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(context.miner.rewardCalls).toBe(1);
  });

  it('does not create a duplicate generation for repeated same-epoch updates', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    context.epoch.update('epoch-1');
    context.epoch.update('epoch-1');
    await flushMiningMicrotasks();
    expect(context.adapter.inputs).toHaveLength(1);
  });

  it('keeps one failed wallet isolated while twelve start successfully', async () => {
    const workers: WalletMiningWorker[] = [];
    const starts: Promise<unknown>[] = [];
    for (let index = 0; index < 13; index += 1) {
      const walletId = `wallet-${index}`;
      const adapter = new FakeMiningNativeAdapter();
      if (index === 4) {
        adapter.enqueueFailure({
          failureStage: 'PREPARE',
          errorCategory: 'SYNTHETIC_FAILURE',
        });
      } else {
        adapter.enqueueMiner(new FakeNativeMiner());
      }
      const worker = new WalletMiningWorker(walletId, {
        nativeAdapter: adapter,
        epochSource: new DeterministicMiniEpochSource(),
        identitySource: new DeterministicIdentitySource(),
        timerSource: new DeterministicTimerSource(),
        randomSource: new DeterministicRandomSource(),
      });
      workers.push(worker);
      starts.push(
        worker.start({ ...SYNTHETIC_IDENTITY, walletId }),
      );
    }
    const results = await Promise.allSettled(starts);
    expect(results).toHaveLength(13);
    expect(workers.filter((worker) => worker.snapshot().state === 'MINING')).toHaveLength(12);
    expect(workers[4]!.snapshot().state).toBe('BACKOFF');
  });

  it('lets thirteen independent workers cross an epoch without a global owner', async () => {
    const epoch = new DeterministicMiniEpochSource();
    const workers: WalletMiningWorker[] = [];
    const firstMiners: FakeNativeMiner[] = [];
    const adapters: FakeMiningNativeAdapter[] = [];
    const timers: DeterministicTimerSource[] = [];
    for (let index = 0; index < 13; index += 1) {
      const first = new FakeNativeMiner();
      const adapter = new FakeMiningNativeAdapter();
      const timer = new DeterministicTimerSource();
      adapter.enqueueMiner(first);
      adapter.enqueueMiner(new FakeNativeMiner());
      const walletId = `wallet-${index}`;
      const worker = new WalletMiningWorker(walletId, {
        nativeAdapter: adapter,
        epochSource: epoch,
        identitySource: new DeterministicIdentitySource(),
        timerSource: timer,
        randomSource: new DeterministicRandomSource(),
      });
      firstMiners.push(first);
      adapters.push(adapter);
      timers.push(timer);
      workers.push(worker);
      await worker.start({ ...SYNTHETIC_IDENTITY, walletId });
    }
    epoch.update('epoch-2');
    expect(firstMiners.every((miner) => miner.stopCalls === 1)).toBe(true);
    firstMiners.forEach((miner, index) => {
      miner.emit({ action: 'session_accepted', sequence: index + 1 });
    });
    await flushMiningMicrotasks(30);
    timers.forEach((timer) => timer.advanceBy(5_000));
    await flushMiningMicrotasks(30);
    expect(adapters.every((adapter) => adapter.inputs.length === 2)).toBe(true);
    expect(firstMiners.every((miner) => miner.startCalls === 1)).toBe(true);
    expect(firstMiners.every((miner) => miner.freeCalls === 1)).toBe(true);
    expect(workers.every((worker) => worker.snapshot().state === 'MINING')).toBe(true);
  });

  it('supports one-second START ALL prepare offsets without shared lifecycle ownership', async () => {
    const timer = new DeterministicTimerSource();
    const callTimes: number[] = [];
    const starts: Promise<unknown>[] = [];
    for (let index = 0; index < 13; index += 1) {
      const walletId = `wallet-${index}`;
      const adapter = new FakeMiningNativeAdapter();
      adapter.enqueueMiner(new FakeNativeMiner());
      const original = adapter.createMiner.bind(adapter);
      adapter.createMiner = async (input) => {
        callTimes.push(timer.nowMs());
        return original(input);
      };
      const worker = new WalletMiningWorker(walletId, {
        nativeAdapter: adapter,
        epochSource: new DeterministicMiniEpochSource(),
        identitySource: new DeterministicIdentitySource(),
        timerSource: new DeterministicTimerSource(),
        randomSource: new DeterministicRandomSource(),
      });
      starts.push(
        new Promise((resolve) => {
          timer.setTimeout(() => {
            void worker
              .start({ ...SYNTHETIC_IDENTITY, walletId })
              .then(resolve);
          }, index * 1_000);
        }),
      );
    }
    while (timer.runNext()) {
      await flushMiningMicrotasks(16);
    }
    await Promise.all(starts);
    expect(callTimes).toEqual(Array.from({ length: 13 }, (_, index) => index * 1_000));
  });

  it('prevents a stale callback from mutating the current UI snapshot', async () => {
    const context = fixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    const snapshots: string[] = [];
    context.worker.subscribe((snapshot) => {
      snapshots.push(`${snapshot.generationToken}:${snapshot.state}:${snapshot.terminalOutcome}`);
    });
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    context.epoch.update('epoch-2');
    await flushMiningMicrotasks(16);
    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(16);
    const before = context.worker.snapshot();
    context.miner.emitForStart(0, {
      action: 'session_rejected',
      sequence: 800,
    });
    expect(context.worker.snapshot()).toEqual(before);
    expect(snapshots.at(-1)).toContain('generation:2:MINING:null');
  });

  it('disposes idempotently from IDLE and DISPOSED', async () => {
    const context = fixture();
    await context.worker.dispose();
    await context.worker.dispose();
    expect(context.worker.snapshot().state).toBe('DISPOSED');
  });

  it('disposes from READY without starting the native worker', async () => {
    const context = fixture();
    let disposal: Promise<void> | null = null;
    const unsubscribe = context.worker.subscribe((snapshot) => {
      if (snapshot.state === 'READY' && !disposal) {
        disposal = context.worker.dispose();
      }
    });
    await context.worker.start(SYNTHETIC_IDENTITY);
    await disposal;
    unsubscribe();
    expect(context.worker.snapshot().state).toBe('DISPOSED');
    expect(context.miner.startCalls).toBe(0);
  });

  it('disposes while Miner.new is unresolved and frees the late result', async () => {
    const allocation = deferredValue<FakeNativeMiner>();
    const adapter = new FakeMiningNativeAdapter([allocation.promise]);
    const context = fixture({ adapter });
    const starting = context.worker.start(SYNTHETIC_IDENTITY);
    await flushMiningMicrotasks();
    const disposing = context.worker.dispose();
    allocation.resolve(context.miner);
    await Promise.all([starting, disposing]);
    expect(context.worker.snapshot().state).toBe('DISPOSED');
    expect(context.miner.startCalls).toBe(0);
    expect(context.miner.freeCalls).toBe(1);
  });

  it('disposes from MINING only after native terminal ownership', async () => {
    const context = fixture();
    await start(context);
    const disposing = context.worker.dispose();
    expect(context.miner.stopCalls).toBe(1);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_rejected');
    await disposing;
    expect(context.worker.snapshot().state).toBe('DISPOSED');
  });

  it('disposes safely while STOP_REQUESTED is awaiting terminal callback', async () => {
    const context = fixture();
    await start(context);
    context.worker.stop('OPERATOR').catch(() => undefined);
    const disposal = context.worker.dispose();
    expect(context.worker.snapshot().state).toBe('STOP_REQUESTED');
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_rejected');
    await disposal;
    expect(context.worker.snapshot().state).toBe('DISPOSED');
    expect(context.miner.stopCalls).toBe(1);
  });

  it('does not interrupt ROOT when disposal is requested', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    const disposing = context.worker.dispose();
    expect(context.miner.stopCalls).toBe(0);
    emit(context, 'submit_session_root', { errorPresent: true });
    emit(context, 'session_rejected');
    await disposing;
    expect(context.worker.snapshot().state).toBe('DISPOSED');
  });

  it('disposes from WAITING_INTERVAL without synthesizing a proof action', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    expect(context.worker.snapshot().state).toBe('WAITING_INTERVAL');
    const disposal = context.worker.dispose();
    emit(context, 'session_rejected');
    await disposal;
    expect(context.worker.snapshot().state).toBe('DISPOSED');
    expect(context.miner.stopCalls).toBe(0);
  });

  it('disposes from observation-derived SUBMITTING_PROOF', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    let disposal: Promise<void> | null = null;
    const unsubscribe = context.worker.subscribe((snapshot) => {
      if (snapshot.state === 'SUBMITTING_PROOF' && !disposal) {
        disposal = context.worker.dispose();
      }
    });
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await disposal;
    unsubscribe();
    expect(context.worker.snapshot().state).toBe('DISPOSED');
  });

  it('disposes from WAITING_RESULT without interrupting Bee', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    const disposal = context.worker.dispose();
    emit(context, 'session_accepted');
    await disposal;
    expect(context.worker.snapshot().state).toBe('DISPOSED');
    expect(context.miner.stopCalls).toBe(0);
  });

  it('disposes from TERMINAL and waits through reward and free', async () => {
    const reward = deferredValue<void>();
    const context = fixture({
      miner: new FakeNativeMiner({ reward: reward.promise }),
    });
    await start(context);
    let disposal: Promise<void> | null = null;
    const unsubscribe = context.worker.subscribe((snapshot) => {
      if (snapshot.state === 'TERMINAL' && !disposal) {
        disposal = context.worker.dispose();
      }
    });
    emit(context, 'session_accepted');
    await flushMiningMicrotasks();
    expect(context.worker.snapshot().state).toBe('REWARDING');
    reward.resolve(undefined);
    await disposal;
    unsubscribe();
    expect(context.worker.snapshot().state).toBe('DISPOSED');
  });

  it('waits for the accepted-session free barrier during disposal', async () => {
    const free = deferredValue<void>();
    const context = fixture({
      miner: new FakeNativeMiner({ free: free.promise }),
    });
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(12);
    expect(context.worker.snapshot().state).toBe('DISPOSING');
    const disposal = context.worker.dispose();
    expect(context.worker.snapshot().state).toBe('DISPOSING');
    free.resolve(undefined);
    await disposal;
    expect(context.worker.snapshot().state).toBe('DISPOSED');
  });

  it('disposes directly from WAITING_EPOCH and BACKOFF', async () => {
    const waiting = fixture();
    await start(waiting);
    emit(waiting, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(waiting.worker.snapshot().state).toBe('WAITING_EPOCH');
    await waiting.worker.dispose();
    expect(waiting.worker.snapshot().state).toBe('DISPOSED');

    const adapter = new FakeMiningNativeAdapter();
    adapter.enqueueFailure({
      failureStage: 'PREPARE',
      errorCategory: 'SYNTHETIC_PREPARE_FAILURE',
    });
    const backoff = fixture({ adapter });
    await backoff.worker.start(SYNTHETIC_IDENTITY);
    await flushMiningMicrotasks(16);
    expect(backoff.worker.snapshot().state).toBe('BACKOFF');
    await backoff.worker.dispose();
    expect(backoff.worker.snapshot().state).toBe('DISPOSED');
  });

  it('supports cancellation while Miner.new remains unresolved', async () => {
    const allocation = deferredValue<FakeNativeMiner>();
    const adapter = new FakeMiningNativeAdapter([allocation.promise]);
    const context = fixture({ adapter });
    const starting = context.worker.start(SYNTHETIC_IDENTITY);
    await flushMiningMicrotasks();
    const stopping = context.worker.stop('OPERATOR');
    expect(context.worker.snapshot()).toMatchObject({
      state: 'TERMINAL',
      terminalOutcome: 'CANCELLED',
    });
    allocation.resolve(context.miner);
    await Promise.all([starting, stopping]);
  });

  it('frees Miner.new returned after cancellation without calling start', async () => {
    const allocation = deferredValue<FakeNativeMiner>();
    const adapter = new FakeMiningNativeAdapter([allocation.promise]);
    const context = fixture({ adapter });
    const starting = context.worker.start(SYNTHETIC_IDENTITY);
    await flushMiningMicrotasks();
    const stopping = context.worker.stop('OPERATOR');
    allocation.resolve(context.miner);
    await Promise.all([starting, stopping]);
    expect(context.miner).toMatchObject({ startCalls: 0, freeCalls: 1 });
  });

  it('remembers an epoch change during ROOT without interrupting submission', async () => {
    const context = fixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    context.epoch.update('epoch-2');
    expect(context.miner.stopCalls).toBe(0);
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(20);
    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(20);
    expect(context.adapter.inputs).toHaveLength(2);
    expect(context.miner.startCalls).toBe(1);
    expect(context.miner.freeCalls).toBe(1);
  });

  it('remembers an epoch change during PROOF without interrupting submission', async () => {
    const context = fixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    context.epoch.update('epoch-2');
    expect(context.miner.stopCalls).toBe(0);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(20);
    context.timer.advanceBy(5_000);
    await flushMiningMicrotasks(20);
    expect(context.adapter.inputs).toHaveLength(2);
    expect(context.miner.startCalls).toBe(1);
    expect(context.miner.freeCalls).toBe(1);
  });

  it('operator stop during ROOT prevents the next generation', async () => {
    const context = fixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    context.epoch.update('epoch-2');
    const stopping = context.worker.stop('OPERATOR');
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await stopping;
    expect(context.adapter.inputs).toHaveLength(1);
  });

  it('operator stop during PROOF prevents next generation without duplicate stop', async () => {
    const context = fixture();
    context.adapter.enqueueMiner(new FakeNativeMiner());
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    context.epoch.update('epoch-2');
    let stopping: Promise<unknown> | null = null;
    const unsubscribe = context.worker.subscribe((snapshot) => {
      if (snapshot.state === 'SUBMITTING_PROOF' && !stopping) {
        stopping = context.worker.stop('OPERATOR');
      }
    });
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await stopping;
    unsubscribe();
    expect(context.miner.stopCalls).toBe(0);
    expect(context.adapter.inputs).toHaveLength(1);
  });

  it('keeps ACCEPTED immutable when get_reward fails', async () => {
    const context = fixture({
      miner: new FakeNativeMiner({
        reward: Promise.reject(new MiningNativeAdapterError({
          failureStage: 'REWARD',
          errorCategory: 'REWARD_FAILED',
        })),
      }),
    });
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    emit(context, 'session_rejected');
    expect(context.worker.snapshot().terminalOutcome).toBe('ACCEPTED');
  });

  it('does not use zero tap_sum delta to alter accepted outcome', async () => {
    const context = fixture({ miner: new FakeNativeMiner({ tapSum: 0n }) });
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(16);
    expect(context.worker.snapshot().terminalOutcome).toBe('ACCEPTED');
    // One read captures the baseline and a second read captures the later
    // cumulative tap_sum observation; each native data object is freed.
    expect(context.miner.dataFreeCalls).toBe(2);
  });

  it('uses proven coordinates with an immediate first tap and fixed 1730 ms pacing', async () => {
    const context = fixture({
      random: new DeterministicRandomSource({ x: 40, y: 640 }, 400),
    });
    await start(context);
    expect(context.miner.coordinates[0]).toEqual({ x: 40, y: 640 });
    expect(context.miner.addTapCalls).toBe(1);
    expect(context.timer.nextDelayMs()).toBe(1_730);
  });

  it('queues 70 taps early and lets the native session finish naturally', async () => {
    const context = fixture();

    await start(context);
    await queueTaps(context, 70);

    expect(context.timer.nowMs()).toBe(69 * 1_730);
    expect(context.miner.stopCalls).toBe(0);
    expect(context.miner.durations).toEqual([135_000]);
    expect(context.worker.snapshot().state).toBe('MINING');
  });

  it('keeps 70 taps inside 135 seconds with jitter disabled', async () => {
    const context = fixture({
      random: new DeterministicRandomSource({ x: 40, y: 640 }, 100),
    });

    await start(context);
    await queueTaps(context, 70);

    expect(context.timer.nowMs()).toBe(69 * 1_730);
    expect(context.timer.nowMs()).toBeLessThan(135_000);
    expect(context.miner.addTapCalls).toBe(70);
    expect(context.miner.durations).toEqual([135_000]);
  });

  it('uses the native duration only as an overdue-session watchdog', async () => {
    const context = fixture({
      epoch: new DeterministicMiniEpochSource('epoch-1', 600_000),
      options: { targetTaps: 1_000 },
    });

    await start(context);

    expect(context.miner.durations).toEqual([135_000]);
    expect(context.miner.stopCalls).toBe(0);
    context.timer.advanceBy(164_999);
    expect(context.miner.stopCalls).toBe(0);
    context.timer.advanceBy(1);
    expect(context.miner.stopCalls).toBe(1);
  });

  it('shortens a mid-epoch native session to preserve the 35 second settlement margin', async () => {
    const epoch = new DeterministicMiniEpochSource('epoch-1', 65_000);
    const context = fixture({ epoch, options: { targetTaps: 1_000 } });
    await start(context);

    expect(context.miner.durations).toEqual([30_000]);
    expect(context.miner.stopCalls).toBe(0);
  });

  it('does not shorten a partial session to create synthetic settlement slots', async () => {
    const firstSlot = fixture({
      epoch: new DeterministicMiniEpochSource('0', 165_000),
      options: {
        fleetStartSlotIndex: 0,
        fleetStartSlotCount: 13,
      },
    });
    await start(firstSlot);
    expect(firstSlot.miner.durations).toEqual([130_000]);

    const lastSlot = fixture({
      epoch: new DeterministicMiniEpochSource('0', 165_000),
      options: {
        fleetStartSlotIndex: 12,
        fleetStartSlotCount: 13,
      },
    });
    await start(lastSlot);
    expect(lastSlot.miner.durations).toEqual([130_000]);
  });

  it('rotates automatic next-epoch start priority without changing session length', async () => {
    const replacement = new FakeNativeMiner();
    const context = fixture({
      epoch: new DeterministicMiniEpochSource('0', 330_000),
      options: {
        fleetStartSlotIndex: 12,
        fleetStartSlotCount: 13,
      },
    });
    context.adapter.enqueueMiner(replacement);
    await start(context);
    emit(context, 'session_accepted');
    await flushMiningMicrotasks(20);

    context.epoch.update('1', 330_000);
    await flushMiningMicrotasks(10);
    context.timer.advanceBy(4_999);
    await flushMiningMicrotasks(10);
    expect(replacement.startCalls).toBe(0);

    context.timer.advanceBy(1);
    await flushMiningMicrotasks(20);
    expect(replacement.startCalls).toBe(1);
    expect(replacement.durations).toEqual([135_000]);
  });

  it('does not recreate timers or stop on an unchanged smooth-clock tick', async () => {
    const epoch = new DeterministicMiniEpochSource('epoch-1', 180_000);
    const context = fixture({ epoch, options: { targetTaps: 1_000 } });
    await start(context);
    const scheduledBeforeTick = context.timer.scheduledCount();

    epoch.update('epoch-1', 180_000);

    expect(context.timer.scheduledCount()).toBe(scheduledBeforeTick);
    expect(context.worker.snapshot().state).toBe('MINING');
    expect(context.miner.stopCalls).toBe(0);
  });

  it('starts immediately even when the UI countdown is near the boundary', async () => {
    const epoch = new DeterministicMiniEpochSource('epoch-1', 34_000);
    const context = fixture({ epoch });

    expect((await context.worker.start(SYNTHETIC_IDENTITY)).status).toBe('STARTED');
    expect(context.worker.snapshot()).toMatchObject({
      state: 'MINING',
      desiredMining: true,
      miniEpoch: 'epoch-1',
    });
    expect(context.adapter.inputs).toHaveLength(1);
    expect(context.miner.durations).toEqual([1_000]);
  });

  it('records observation-derived proof state without claiming a Bee pre-send event', async () => {
    const context = fixture();
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 1 });
    emit(context, 'submit_session_root');
    emit(context, 'submit_session_proof');
    expect(
      context.diagnostics.events.some(
        (event) =>
          event.workerState === 'SUBMITTING_PROOF' &&
          event.observationDerived === true,
      ),
    ).toBe(true);
  });

  it('covers every declared state through legal transitions', async () => {
    const reward = deferredValue<void>();
    const free = deferredValue<void>();
    const context = fixture({
      miner: new FakeNativeMiner({ reward: reward.promise, free: free.promise }),
    });
    const observed = new Set<WalletMiningWorkerState>();
    context.worker.subscribe((snapshot) => observed.add(snapshot.state));
    await start(context);
    emit(context, 'computation_completed', { computationCompletedTaps: 70 });
    emit(context, 'submit_session_root');
    let proofObserved = false;
    const unsubscribe = context.worker.subscribe((snapshot) => {
      if (snapshot.state === 'SUBMITTING_PROOF') proofObserved = true;
    });
    emit(context, 'submit_session_proof');
    emit(context, 'session_accepted');
    await flushMiningMicrotasks();
    reward.resolve(undefined);
    await flushMiningMicrotasks();
    free.resolve(undefined);
    await flushMiningMicrotasks(16);
    unsubscribe();
    expect(proofObserved).toBe(true);
    expect(observed).toEqual(
      expect.objectContaining({
        has: expect.any(Function),
      }),
    );
    for (const state of [
      'IDLE',
      'PREPARING',
      'READY',
      'MINING',
      'SUBMITTING_ROOT',
      'WAITING_INTERVAL',
      'SUBMITTING_PROOF',
      'WAITING_RESULT',
      'TERMINAL',
      'REWARDING',
      'DISPOSING',
      'WAITING_EPOCH',
    ] satisfies WalletMiningWorkerState[]) {
      expect(observed.has(state)).toBe(true);
    }
  });
});
