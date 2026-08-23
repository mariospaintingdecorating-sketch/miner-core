import { describe, expect, it } from 'vitest';
import type {
  WalletMiningDiagnosticEvent,
  WalletMiningSnapshot,
  WalletMiningTerminalOutcome,
  WalletMiningWorkerState,
} from '../mining/WalletMiningRuntime';
import type {
  CoreEvent,
  CoreEventType,
  EventPublisher,
} from '../shared/events';
import { WalletRegistry } from './WalletRegistry';
import {
  WalletMiningWorkerDiagnosticBridge,
  WalletMiningWorkerProductAdapter,
  confirmedTapDeltaAsNumber,
  productSettlementOutcome,
} from './WalletMiningWorkerProductAdapter';
import type { RuntimePresentationState } from './runtimeState';

class CapturingPublisher implements EventPublisher {
  readonly events: CoreEvent[] = [];

  publish<TType extends CoreEventType>(event: CoreEvent<TType>): void {
    this.events.push(event as CoreEvent);
  }
}

class ObservableRuntime {
  readonly listeners = new Set<(snapshot: Readonly<WalletMiningSnapshot>) => void>();
  current = initialSnapshot();

  snapshot(): Readonly<WalletMiningSnapshot> {
    return this.current;
  }

  subscribe(listener: (snapshot: Readonly<WalletMiningSnapshot>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<WalletMiningSnapshot>): void {
    this.current = Object.freeze({ ...this.current, ...patch });
    for (const listener of [...this.listeners]) listener(this.current);
  }
}

function fixture(initialGeneration = 0) {
  const runtime = new ObservableRuntime();
  const publisher = new CapturingPublisher();
  const registry = new WalletRegistry([{ id: 'wallet-a', name: 'Wallet A' }]);
  const adapter = new WalletMiningWorkerProductAdapter(runtime, {
    eventPublisher: publisher,
    walletRegistry: registry,
    initialGeneration,
    now: () => Date.parse('2026-08-12T12:00:00.000Z'),
  });
  return { runtime, publisher, registry, adapter };
}

function beginSession(context: ReturnType<typeof fixture>, token = 'token-1'): void {
  context.runtime.update({
    state: 'MINING',
    sessionId: `session:${token}`,
    generationToken: token,
    miniEpoch: '1000',
    desiredMining: true,
  });
}

function finishSession(
  context: ReturnType<typeof fixture>,
  outcome: WalletMiningTerminalOutcome,
  confirmedTapDelta: string | null = null,
): void {
  context.runtime.update({
    state: 'TERMINAL',
    terminalOutcome: outcome,
    confirmedTapDelta,
  });
  context.runtime.update({
    state: 'IDLE',
    desiredMining: false,
    rewardStatus: outcome === 'ACCEPTED' ? 'SUCCEEDED' : 'SKIPPED',
    disposalStatus: 'SUCCEEDED',
  });
}

describe('WalletMiningWorkerProductAdapter Phase 6 semantics', () => {
  it('bounds completed generation retention while keeping recent stale correlation', () => {
    const context = fixture();
    const generations = new Map<string, number>();

    for (let index = 1; index <= 10; index += 1) {
      const token = `token-${index}`;
      context.runtime.update({
        state: 'MINING',
        sessionId: `session:${token}`,
        generationToken: token,
        miniEpoch: String(index),
        desiredMining: true,
        terminalOutcome: null,
        rewardStatus: 'NOT_REQUESTED',
        disposalStatus: 'NOT_STARTED',
      });
      generations.set(token, context.adapter.generationForToken(token)!);
      finishSession(context, 'CANCELLED');
    }

    expect(context.adapter.generationForToken('token-3')).toBe(
      generations.get('token-3'),
    );
    expect(context.adapter.generationForToken('token-1')).toBeGreaterThan(10);
  });

  it.each([
    ['ACCEPTED', 'accepted'],
    ['REJECTED', 'rejected'],
    ['TIMEOUT', 'timeout'],
    ['NATIVE_ERROR', 'native_error'],
    ['PARTIAL_NATIVE_SESSION', 'native_error'],
    ['CANCELLED', 'unknown'],
    ['AMBIGUOUS', 'unknown'],
  ] as const)('28-31. maps authoritative terminal %s to %s', (native, product) => {
    expect(productSettlementOutcome(native)).toBe(product);
  });

  it('30-31. DISPOSED lifecycle without terminal authority never maps accepted', () => {
    const context = fixture();
    beginSession(context);
    context.runtime.update({
      state: 'DISPOSED',
      desiredMining: false,
      disposalStatus: 'SUCCEEDED',
      terminalOutcome: null,
    });
    expect(
      context.publisher.events.filter((event) => event.type === 'bee-settlement-outcome'),
    ).toEqual([]);
  });

  it.each([
    ['submit_session_root', 'ROOT_SUBMIT'],
    ['submit_session_proof', 'PROOF_SUBMIT'],
  ] as const)('32-33. preserves %s diagnostic stage %s', (action, stage) => {
    const publisher = new CapturingPublisher();
    const bridge = new WalletMiningWorkerDiagnosticBridge(publisher, () => 4);
    bridge.record(diagnosticEvent({
      callbackAction: action,
      callbackSequence: 2,
      errorPresent: true,
      nativeTopLevelMessage: 'safe native message',
      failureStage: stage as 'ROOT_SUBMIT' | 'PROOF_SUBMIT',
      errorCategory: 'NODE_ERROR',
    }));
    const event = publisher.events[0];
    expect(event?.type).toBe('wallet-mining-worker-diagnostic');
    if (event?.type === 'wallet-mining-worker-diagnostic') {
      expect(event.payload).toMatchObject({
        callbackAction: action,
        callbackSequence: 2,
        failureStage: stage,
        errorCategory: 'NODE_ERROR',
      });
    }
  });

  it('34. misleading proof text remains PROOF_SUBMIT', () => {
    const publisher = new CapturingPublisher();
    const bridge = new WalletMiningWorkerDiagnosticBridge(publisher, () => 5);
    bridge.record(diagnosticEvent({
      callbackAction: 'submit_session_proof',
      nativeTopLevelMessage: 'Submit session root failed',
      failureStage: 'PROOF_SUBMIT',
      errorCategory: 'CONTRACT_ERROR',
    }));
    const event = publisher.events[0];
    if (event?.type !== 'wallet-mining-worker-diagnostic') {
      throw new Error('Expected a safe new-worker diagnostic event.');
    }
    expect(event.payload.failureStage).toBe('PROOF_SUBMIT');
    expect(event.payload.nativeTopLevelMessage).toBe('Submit session root failed');
  });

  it('35. queued, native-computed and computation-completed counters remain distinct', () => {
    const publisher = new CapturingPublisher();
    const bridge = new WalletMiningWorkerDiagnosticBridge(publisher, () => 1);
    bridge.record(diagnosticEvent({
      queuedLocalTaps: 70,
      nativeComputedTaps: 69,
      computationCompletedTaps: 68,
    }));
    const event = publisher.events[0];
    if (event?.type !== 'wallet-mining-worker-diagnostic') {
      throw new Error('Expected a safe new-worker diagnostic event.');
    }
    expect(event.payload).toMatchObject({
      queuedLocalTaps: 70,
      nativeComputedTaps: 69,
      computationCompletedTaps: 68,
    });
  });

  it('filters per-tap worker diagnostics while preserving settlement callbacks', () => {
    const publisher = new CapturingPublisher();
    const bridge = new WalletMiningWorkerDiagnosticBridge(publisher, () => 1);

    bridge.record(diagnosticEvent({ kind: 'TAP_QUEUED' }));
    bridge.record(diagnosticEvent({
      kind: 'CALLBACK',
      callbackAction: 'tap_computed',
      callbackSequence: 1,
    }));
    bridge.record(diagnosticEvent({
      kind: 'CALLBACK',
      callbackAction: 'submit_session_root',
      callbackSequence: 2,
    }));

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]).toMatchObject({
      type: 'wallet-mining-worker-diagnostic',
      payload: {
        callbackAction: 'submit_session_root',
        callbackSequence: 2,
      },
    });
  });

  it('36. confirmedTapDelta never changes authoritative ACCEPTED mapping', () => {
    const context = fixture();
    beginSession(context);
    finishSession(context, 'ACCEPTED', '0');
    const outcome = context.publisher.events.find(
      (event) => event.type === 'bee-settlement-outcome',
    );
    if (outcome?.type !== 'bee-settlement-outcome') {
      throw new Error('Expected settlement outcome event.');
    }
    expect(outcome.payload.outcome).toBe('accepted');
    expect(outcome.payload.confirmedTaps).toBe(0);
  });

  it('37. history bridge keeps completed taps local and verified taps observational', () => {
    const context = fixture(7);
    beginSession(context);
    context.runtime.update({
      queuedLocalTaps: 70,
      nativeComputedTaps: 69,
      computationCompletedTaps: 68,
    });
    finishSession(context, 'ACCEPTED', '6');
    const tap = context.publisher.events.find((event) => event.type === 'tap-progress');
    const outcome = context.publisher.events.find(
      (event) => event.type === 'bee-settlement-outcome',
    );
    if (tap?.type !== 'tap-progress' || outcome?.type !== 'bee-settlement-outcome') {
      throw new Error('Expected product history bridge events.');
    }
    expect(tap.payload.completedTapCount).toBe(70);
    expect(outcome.payload.confirmedTaps).toBe(6);
    expect(outcome.payload.generation).toBe(8);
    expect(context.registry.wallet('wallet-a')?.session).toBeNull();
  });

  it('38. reward success maps without fabricating a reward delta', () => {
    const context = fixture();
    beginSession(context);
    context.runtime.update({ state: 'TERMINAL', terminalOutcome: 'ACCEPTED' });
    context.runtime.update({ state: 'REWARDING', rewardStatus: 'PENDING' });
    context.runtime.update({
      state: 'IDLE',
      rewardStatus: 'SUCCEEDED',
      disposalStatus: 'SUCCEEDED',
    });
    const reward = context.publisher.events.find(
      (event) => event.type === 'bee-reward-sync-completed',
    );
    if (reward?.type !== 'bee-reward-sync-completed') {
      throw new Error('Expected reward result event.');
    }
    expect(reward.payload.confirmedRewardCount).toBe(0);
    expect(reward.payload.code).toBeNull();
  });

  it('maps every worker state onto the existing product presentation vocabulary', () => {
    const context = fixture();
    beginSession(context);
    const expectations: readonly [WalletMiningWorkerState, string][] = [
      ['PREPARING', 'starting'],
      ['READY', 'starting'],
      ['MINING', 'running'],
      ['STOP_REQUESTED', 'stopping'],
      ['SUBMITTING_ROOT', 'stopping'],
      ['WAITING_INTERVAL', 'stopping'],
      ['SUBMITTING_PROOF', 'stopping'],
      ['WAITING_RESULT', 'stopping'],
      ['TERMINAL', 'stopping'],
      ['REWARDING', 'stopping'],
      ['DISPOSING', 'stopping'],
      ['WAITING_EPOCH', 'waiting'],
      ['BACKOFF', 'waiting'],
      ['DISPOSED', 'disposed'],
    ];
    for (const [state, product] of expectations) {
      context.runtime.update({ state });
      expect(context.adapter.presentation(BASE_PRESENTATION).runtimeStatus).toBe(product);
    }
  });

  it('allocates deterministic wallet-local numeric generations', () => {
    const context = fixture(10);
    beginSession(context, 'token-a');
    expect(context.adapter.generationForToken('token-a')).toBe(11);
    finishSession(context, 'CANCELLED');
    context.runtime.update({
      ...initialSnapshot(),
      state: 'MINING',
      sessionId: 'session:token-b',
      generationToken: 'token-b',
    });
    expect(context.adapter.generationForToken('token-b')).toBe(12);
  });

  it('emits the Core/product close timestamp stage only after safe cleanup', () => {
    const context = fixture();
    beginSession(context);
    context.runtime.update({ state: 'TERMINAL', terminalOutcome: 'REJECTED' });
    expect(
      context.publisher.events.some(
        (event) =>
          event.type === 'wallet-mining-worker-diagnostic' &&
          event.payload.stage === 'PRODUCT_SESSION_CLOSE',
      ),
    ).toBe(false);
    context.runtime.update({ state: 'IDLE', disposalStatus: 'SUCCEEDED' });
    expect(
      context.publisher.events.some(
        (event) =>
          event.type === 'wallet-mining-worker-diagnostic' &&
          event.payload.stage === 'PRODUCT_SESSION_CLOSE',
      ),
    ).toBe(true);
  });

  it('keeps root failure on the settlement result but not on successful cleanup', () => {
    const context = fixture();
    beginSession(context);
    context.runtime.update({
      state: 'TERMINAL',
      terminalOutcome: 'AMBIGUOUS',
      failureStage: 'ROOT_SUBMIT',
      errorCategory: 'NETWORK',
    });
    context.runtime.update({
      state: 'IDLE',
      disposalStatus: 'SUCCEEDED',
    });

    const outcome = context.publisher.events.find(
      (event) => event.type === 'bee-settlement-outcome',
    );
    const productClose = context.publisher.events.find(
      (event) =>
        event.type === 'wallet-mining-worker-diagnostic' &&
        event.payload.stage === 'PRODUCT_SESSION_CLOSE',
    );
    expect(outcome?.payload).toMatchObject({
      outcome: 'unknown',
      code: 'ROOT_SUBMIT',
      classification: null,
    });
    expect(productClose?.payload).toMatchObject({
      stage: 'PRODUCT_SESSION_CLOSE',
      failureStage: null,
      errorCategory: null,
      terminalOutcome: 'AMBIGUOUS',
      disposalStatus: 'SUCCEEDED',
    });
  });

  it('accepts only safe non-negative confirmed delta values', () => {
    expect(confirmedTapDeltaAsNumber('7')).toBe(7);
    expect(confirmedTapDeltaAsNumber('-1')).toBeNull();
    expect(confirmedTapDeltaAsNumber('1.5')).toBeNull();
    expect(confirmedTapDeltaAsNumber('9007199254740992')).toBeNull();
  });
});

function initialSnapshot(): Readonly<WalletMiningSnapshot> {
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

function diagnosticEvent(
  patch: Partial<WalletMiningDiagnosticEvent>,
): Readonly<WalletMiningDiagnosticEvent> {
  return Object.freeze({
    occurredAtMs: Date.parse('2026-08-12T12:00:00.000Z'),
    kind: 'CALLBACK',
    walletId: 'wallet-a',
    sessionId: 'session-a',
    generationToken: 'token-a',
    miniEpoch: '1000',
    workerState: 'SUBMITTING_ROOT',
    queuedLocalTaps: 0,
    nativeComputedTaps: 0,
    computationCompletedTaps: null,
    ...patch,
  });
}

const BASE_PRESENTATION: Readonly<RuntimePresentationState> = Object.freeze({
  runtimeStatus: 'idle',
  miningExecution: null,
  schedulerStatus: 'idle',
  settlementStatus: 'idle',
  boundaryStatus: 'idle',
  recoveryStatus: 'idle',
  recoveryIssue: null,
  epochs: Object.freeze({
    miniEpoch: epoch(),
    mainEpoch: epoch(),
  }),
  health: Object.freeze({ uptimeMs: null, lastError: null }),
});

function epoch() {
  return Object.freeze({
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
  });
}
