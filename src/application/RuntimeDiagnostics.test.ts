import { describe, expect, it, vi } from 'vitest';
import {
  CoreEventEmitter,
  type WalletMiningWorkerDiagnosticEventPayload,
} from '../shared/events';
import { RuntimeDiagnostics } from './RuntimeDiagnostics';

describe('RuntimeDiagnostics', () => {
  it('observes lifecycle and progress data without becoming a state owner', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'session-started:session-3:3',
      occurredAt: '2026-08-04T12:00:00.000Z',
      type: 'session-started',
      payload: {
        walletId: 'wallet-3',
        sessionId: 'session-3',
        generation: 3,
        miniEpoch: '12000',
      },
    });
    events.publish({
      id: 'tap-progress:session-3:3:1',
      occurredAt: '2026-08-04T12:00:03.400Z',
      type: 'tap-progress',
      payload: {
        sessionId: 'session-3',
        generation: 3,
        walletId: 'wallet-3',
        miniEpoch: '12000',
        completedTapCount: 1,
      },
    });

    expect(diagnostics.entries()).toMatchObject([
      {
        timestamp: '2026-08-04T12:00:03.400Z',
        eventType: 'tap-progress',
        level: 'debug',
        category: 'MINING',
        walletId: 'wallet-3',
        sessionId: 'session-3',
        generation: 3,
        miniEpoch: '12000',
        detail: expect.stringContaining('1 completed taps'),
      },
      {
        eventType: 'session-started',
        sessionId: 'session-3',
        generation: 3,
      },
    ]);
    expect(Object.isFrozen(diagnostics.entries())).toBe(true);
    expect('start' in diagnostics).toBe(false);
    expect('stop' in diagnostics).toBe(false);
    expect('restart' in diagnostics).toBe(false);
  });

  it('classifies warnings, errors, and recovery completion from real events', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'warning:network-slow:1',
      occurredAt: '2026-08-04T12:01:00.000Z',
      type: 'warning',
      payload: {
        code: 'network-slow',
        message: 'Network response is slow',
        severity: 'warning',
      },
    });
    events.publish({
      id: 'recovery-started:runtime-error:2',
      occurredAt: '2026-08-04T12:02:00.000Z',
      type: 'recovery-started',
      payload: {
        code: 'runtime-error',
        message: 'Runtime failed',
        severity: 'error',
      },
    });
    events.publish({
      id: 'recovery-completed:runtime-error:3',
      occurredAt: '2026-08-04T12:03:00.000Z',
      type: 'recovery-completed',
      payload: {
        code: 'runtime-error',
        message: 'Runtime failed',
        severity: 'error',
      },
    });

    expect(diagnostics.entries().map((entry) => entry.level)).toEqual([
      'info',
      'error',
      'warning',
    ]);
    expect(diagnostics.entries().map((entry) => entry.category)).toEqual([
      'ERROR',
      'ERROR',
      'ERROR',
    ]);
    expect(diagnostics.latestError()).toMatchObject({
      code: 'runtime-error',
      message: 'Runtime failed',
      timestamp: '2026-08-04T12:02:00.000Z',
    });
  });

  it('keeps execution failures attached to their session generation', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'tap-execution-failed:session-8:8:tap-4',
      occurredAt: '2026-08-04T12:04:00.000Z',
      type: 'tap-execution-failed',
      payload: {
        sessionId: 'session-8',
        generation: 8,
        executionId: 'tap-4',
        code: 'driver-unavailable',
        message: 'Driver unavailable',
      },
    });

    expect(diagnostics.entries()[0]).toMatchObject({
      level: 'error',
      category: 'MINING',
      sessionId: 'session-8',
      generation: 8,
      code: 'driver-unavailable',
      detail: expect.stringContaining('tap-4'),
    });
  });

  it('preserves wallet and session identity for reward diagnostics', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'reward-recorded:wallet-a:reward-a',
      occurredAt: '2026-08-04T14:00:00.000Z',
      type: 'reward-recorded',
      payload: {
        rewardId: 'reward-a',
        walletId: 'wallet-a',
        amount: '12',
        unit: 'ACKI',
        sessionId: 'session-a',
        generation: 2,
      },
    });

    expect(diagnostics.entries()[0]).toMatchObject({
      eventType: 'reward-recorded',
      sessionId: 'session-a',
      generation: 2,
      detail: expect.stringContaining('wallet-a'),
    });
  });

  it('keeps a bounded history and isolates diagnostic listeners', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events, 2);
    const throwingListener = vi.fn(() => {
      throw new Error('Presentation failed');
    });
    const listener = vi.fn();
    diagnostics.subscribe(throwingListener);
    diagnostics.subscribe(listener);

    for (let generation = 1; generation <= 3; generation += 1) {
      events.publish({
        id: `session-created:session-${generation}:${generation}`,
        occurredAt: `2026-08-04T12:0${generation}:00.000Z`,
        type: 'session-created',
        payload: { sessionId: `session-${generation}`, generation },
      });
    }

    expect(diagnostics.entries()).toHaveLength(2);
    expect(diagnostics.entries().map((entry) => entry.generation)).toEqual([3, 2]);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(throwingListener).toHaveBeenCalledTimes(4);
  });

  it('bounds oversized native error text retained in memory', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'runtime-error:large-native-payload',
      occurredAt: '2026-08-08T10:00:00.000Z',
      type: 'runtime-error',
      payload: {
        code: 'native-error',
        message: 'x'.repeat(100_000),
      },
    });

    const diagnostic = diagnostics.entries()[0];
    expect(diagnostic?.message?.length).toBeLessThan(4_100);
    expect(diagnostic?.detail.length).toBeLessThan(4_100);
    expect(diagnostic?.message?.endsWith('[truncated]')).toBe(true);
  });

  it.each([
    ['621', 'Message queue is full.', 'QUEUE_OVERFLOW'],
    ['621', 'Unknown error', 'UNKNOWN_NODE_ERROR'],
    ['11', 'Failed to fetch', 'FAILED_TO_FETCH'],
    [
      '12',
      'Can not parse http request: Body is not a valid JSON: EOF while parsing a value',
      'INVALID_JSON',
    ],
  ])('adds a short native settlement reason for code %s', (code, message, reason) => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: `bee-settlement-outcome:${code}`,
      occurredAt: '2026-08-08T10:00:00.000Z',
      type: 'bee-settlement-outcome',
      payload: {
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 1,
        operationId: 'settlement:1',
        outcome: 'native_error',
        submissionReference: null,
        confirmedTaps: null,
        code,
        message,
      },
    });

    expect(diagnostics.entries()[0]).toMatchObject({
      detail: expect.stringContaining(`reason: ${reason}`),
      details: { reason },
    });
  });

  it('keeps the precise native failure reason and message hash in bounded diagnostics', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'bee-settlement-outcome:duplicate',
      occurredAt: '2026-08-08T10:00:00.000Z',
      type: 'bee-settlement-outcome',
      payload: {
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 1,
        operationId: 'settlement:1',
        outcome: 'native_error',
        submissionReference: null,
        confirmedTaps: null,
        code: 'bee-session-native-failed',
        message: 'Unknown error',
        classification: 'DUPLICATE_MESSAGE',
        messageHash: 'duplicate-message-hash',
      },
    });

    expect(diagnostics.entries()[0]).toMatchObject({
      detail: expect.stringContaining('reason: DUPLICATE_MESSAGE'),
      details: expect.objectContaining({
        operation: 'settlement',
        reason: 'DUPLICATE_MESSAGE',
        messageHash: 'duplicate-message-hash',
      }),
    });
    expect(diagnostics.entries()[0]?.details).not.toHaveProperty('operationId');
    expect(diagnostics.entries()[0]?.details).not.toHaveProperty(
      'submissionReference',
    );
  });

  it('records reward operation classification and message hash without native payloads', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'bee-mining-failed:reward',
      occurredAt: '2026-08-08T10:00:00.000Z',
      type: 'bee-mining-failed',
      payload: {
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 1,
        operationId: 'reward:2',
        code: 'bee-reward-sync-failed',
        message: 'Unknown error',
        classification: 'DUPLICATE_MESSAGE',
        messageHash: 'duplicate-message-hash',
      },
    });

    expect(diagnostics.entries()[0]).toMatchObject({
      walletId: 'wallet-a',
      sessionId: 'session-a',
      generation: 1,
      details: expect.objectContaining({
        operation: 'reward',
        classification: 'DUPLICATE_MESSAGE',
        messageHash: 'duplicate-message-hash',
      }),
    });
    expect(diagnostics.entries()[0]?.details).not.toHaveProperty('operationId');
  });

  it('omits structured native payloads and retains only useful failure metadata', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);
    const nativeMessage = JSON.stringify({
      error: 'queue full',
      credential: 'credential-secret',
      seed: 'one two three four',
      privateKey: 'private-key-secret',
      nested: { token: 'token-secret', payload: 'x'.repeat(20_000) },
    }) + '\u0000\u0007';

    events.publish({
      id: 'bee-mining-failed:redaction',
      occurredAt: '2026-08-08T10:00:00.000Z',
      type: 'bee-mining-failed',
      payload: {
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 4,
        operationId: 'reward:private-operation-reference',
        code: '621',
        message: nativeMessage,
        classification: 'QUEUE_OVERFLOW',
        messageHash: 'safe-message-hash',
      },
    });

    const diagnostic = diagnostics.entries()[0]!;
    const serialized = JSON.stringify(diagnostic);
    expect(diagnostic.message).toBe('Native payload omitted (621).');
    expect(diagnostic.details).toEqual({
      operation: 'reward',
      classification: 'QUEUE_OVERFLOW',
      messageHash: 'safe-message-hash',
    });
    expect(serialized).not.toContain('credential-secret');
    expect(serialized).not.toContain('private-key-secret');
    expect(serialized).not.toContain('token-secret');
    expect(serialized).not.toContain('private-operation-reference');
    expect(serialized).not.toContain('\\u0000');
  });

  it('uses UNKNOWN_NATIVE_ERROR when native settlement has no better reason', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'bee-settlement-outcome:unknown',
      occurredAt: '2026-08-08T10:00:00.000Z',
      type: 'bee-settlement-outcome',
      payload: {
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 1,
        operationId: 'settlement:1',
        outcome: 'native_error',
        submissionReference: null,
        confirmedTaps: null,
        code: 'bee-session-native-failed',
        message: 'Native operation failed.',
      },
    });

    expect(diagnostics.entries()[0]).toMatchObject({
      details: expect.objectContaining({ reason: 'UNKNOWN_NATIVE_ERROR' }),
    });
  });

  it('retains a root submission stage for an ambiguous settlement result', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'bee-settlement-outcome:root-submit',
      occurredAt: '2026-08-12T21:18:26.870Z',
      type: 'bee-settlement-outcome',
      payload: {
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 21,
        miniEpoch: '78126000',
        operationId: 'new-worker:ROOT_SUBMIT:session-a',
        outcome: 'unknown',
        submissionReference: null,
        confirmedTaps: 0,
        code: 'ROOT_SUBMIT',
        message: 'New wallet worker terminal outcome: AMBIGUOUS.',
        classification: null,
        messageHash: null,
      },
    });

    expect(diagnostics.entries()[0]).toMatchObject({
      level: 'warning',
      detail: expect.stringContaining('reason: ROOT_SUBMIT'),
      details: expect.objectContaining({ reason: 'ROOT_SUBMIT' }),
    });
  });

  it('marks only the failing callback red and leaves ambiguous cleanup diagnostic', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'worker:root-error',
      occurredAt: '2026-08-12T21:17:56.850Z',
      type: 'wallet-mining-worker-diagnostic',
      payload: workerDiagnosticPayload({
        stage: 'ROOT_CALLBACK',
        callbackAction: 'submit_session_root',
        callbackSequence: 74,
        errorPresent: true,
        serverCode: 11,
        failureStage: 'ROOT_SUBMIT',
        errorCategory: 'NETWORK',
      }),
    });
    events.publish({
      id: 'worker:terminal',
      occurredAt: '2026-08-12T21:18:26.870Z',
      type: 'wallet-mining-worker-diagnostic',
      payload: workerDiagnosticPayload({
        stage: 'TERMINAL',
        terminalOutcome: 'AMBIGUOUS',
        failureStage: 'ROOT_SUBMIT',
        errorCategory: 'NETWORK',
      }),
    });
    events.publish({
      id: 'worker:free',
      occurredAt: '2026-08-12T21:18:26.871Z',
      type: 'wallet-mining-worker-diagnostic',
      payload: workerDiagnosticPayload({
        stage: 'NATIVE_FREE_RESULT',
        terminalOutcome: 'AMBIGUOUS',
        disposalStatus: 'SUCCEEDED',
      }),
    });

    expect(diagnostics.entries().map((entry) => entry.level)).toEqual([
      'debug',
      'debug',
      'error',
    ]);
  });

  it('retains only safe bounded settlement timing metadata', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events, 2);

    events.publish({
      id: 'bee-settlement-trace:1',
      occurredAt: '2026-08-10T22:00:00.000Z',
      type: 'bee-settlement-trace',
      payload: {
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 3,
        operationId: 'settlement:8',
        stage: 'terminal-result',
        completedTapCount: 70,
        baselineTapSum: '120',
        latestTapSum: '190',
        submissionStaggerMs: null,
        callbackAction: 'session_accepted',
        callbackStatus: null,
        callbackErrorPresent: true,
        errorPresent: true,
        callbackSequence: 6,
        submitSessionProofCount: 2,
        terminalStatus: 'accepted',
        classification: null,
        stopToCallbackMs: 2_400,
        settlementToTerminalMs: 3_100,
        errorCode: 'QUEUE_OVERFLOW',
        errorCategory: 'QUEUE',
        nativeTopLevelMessage: 'Submit session root failed',
        tvmCode: null,
        tvmCodeName: null,
        kitModule: 'MvSystem(Miner)',
        kitCode: -1,
        serverCode: 621,
        nodeExtensionCode: 'QUEUE_OVERFLOW',
        nodeExtensionMessage: 'Message queue is full',
        tvmExitCode: 0,
        transactionAborted: false,
        messageHash: 'message-hash',
        transactionHash: null,
        accountId: 'account-id',
        dappId: 'dapp-id',
        threadId: 'thread-id',
        producerFingerprint: 'fnv1a-12345678',
        coreVersion: '3.0.2',
        failureStage: 'PROOF_SUBMIT',
        durationMs: 1_000,
      },
    });

    expect(diagnostics.entries()).toEqual([
      expect.objectContaining({
        eventType: 'bee-settlement-trace',
        category: 'SETTLEMENT',
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 3,
        details: expect.objectContaining({
          stage: 'terminal-result',
          operationId: 'settlement:8',
          completedTapCount: 70,
          baselineTapSum: '120',
          latestTapSum: '190',
          callbackSequence: 6,
          errorCode: 'QUEUE_OVERFLOW',
          errorCategory: 'QUEUE',
          nativeTopLevelMessage: 'Submit session root failed',
          serverCode: 621,
          nodeExtensionCode: 'QUEUE_OVERFLOW',
          nodeExtensionMessage: 'Message queue is full',
          failureStage: 'PROOF_SUBMIT',
          durationMs: 1_000,
          submitSessionProofCount: 2,
          stopToCallbackMs: 2_400,
          settlementToTerminalMs: 3_100,
        }),
      }),
    ]);
    expect(JSON.stringify(diagnostics.entries())).not.toMatch(
      /credential|private.?key|secret|requestBody|authorization|cookie/i,
    );
  });

  it('stores only normalized identity for Bee GraphQL pool timeouts', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    events.publish({
      id: 'bee-graphql-pool-timeout:1',
      occurredAt: '2026-08-10T22:00:00.000Z',
      type: 'bee-graphql-pool-timeout',
      payload: {
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 3,
        operation: 'miner-events-query',
        code: '601',
        category: 'graphql-pool-timeout',
      },
    });

    expect(diagnostics.entries()).toEqual([
      expect.objectContaining({
        eventType: 'bee-graphql-pool-timeout',
        level: 'error',
        category: 'NETWORK',
        walletId: 'wallet-a',
        sessionId: 'session-a',
        generation: 3,
        code: '601',
        details: {
          operation: 'miner-events-query',
          category: 'graphql-pool-timeout',
        },
      }),
    ]);
    expect(JSON.stringify(diagnostics.entries())).not.toMatch(
      /query\s*\{|variables|authorization|cookie|credential|secret/i,
    );
  });

  it('retains tap milestones instead of persisting every progress update', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    for (const completedTapCount of [1, 2, 9, 10, 11, 70]) {
      events.publish({
        id: `tap-progress:session-1:1:${completedTapCount}`,
        occurredAt: '2026-08-04T12:00:00.000Z',
        type: 'tap-progress',
        payload: {
          walletId: 'wallet-a',
          sessionId: 'session-1',
          generation: 1,
          miniEpoch: '12000',
          completedTapCount,
        },
      });
    }

    expect(
      diagnostics.entries().map((entry) => entry.details.completedTapCount),
    ).toEqual([70, 10, 1]);
  });

  it('projects runtime, epoch, boundary, settlement, and reward observation events', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);
    const session = {
      walletId: 'wallet-a',
      sessionId: 'session-a',
      generation: 4,
      miniEpoch: '13000',
    };

    events.publish({
      id: 'runtime-created:1',
      occurredAt: '2026-08-06T10:00:00.000Z',
      type: 'wallet-runtime-created',
      payload: { walletId: 'wallet-a' },
    });
    events.publish({
      id: 'epoch-changed:2',
      occurredAt: '2026-08-06T10:01:00.000Z',
      type: 'epoch-changed',
      payload: {
        previousMiniEpoch: '12000',
        miniEpoch: '13000',
        mainEpoch: '0',
        currentBlock: '13000',
        confidence: 'canonical',
        lastFailureCode: null,
      },
    });
    events.publish({
      id: 'boundary-reached:3',
      occurredAt: '2026-08-06T10:01:00.000Z',
      type: 'boundary-reached',
      payload: session,
    });
    events.publish({
      id: 'settlement-started:4',
      occurredAt: '2026-08-06T10:01:01.000Z',
      type: 'settlement-started',
      payload: session,
    });
    events.publish({
      id: 'reward-sync-started:5',
      occurredAt: '2026-08-06T10:01:02.000Z',
      type: 'reward-sync-started',
      payload: session,
    });

    expect(
      diagnostics.entries().map((entry) => [
        entry.eventType,
        entry.category,
        entry.walletId,
        entry.miniEpoch,
      ]),
    ).toEqual([
      ['reward-sync-started', 'REWARD', 'wallet-a', '13000'],
      ['settlement-started', 'SETTLEMENT', 'wallet-a', '13000'],
      ['boundary-reached', 'EPOCH', 'wallet-a', '13000'],
      ['epoch-changed', 'EPOCH', null, '13000'],
      ['wallet-runtime-created', 'SYSTEM', 'wallet-a', null],
    ]);
  });

  it('records wallet-scoped fleet start stages without sensitive data', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);

    for (const [index, stage] of (
      [
        'requested',
        'prepare-started',
        'running-reached',
      ] as const
    ).entries()) {
      events.publish({
        id: `wallet-runtime-start-stage:${index + 1}`,
        occurredAt: `2026-08-08T10:00:0${index}.000Z`,
        type: 'wallet-runtime-start-stage',
        payload: { walletId: 'wallet-a', stage },
      });
    }

    expect(
      diagnostics.entries().map((entry) => ({
        timestamp: entry.timestamp,
        walletId: entry.walletId,
        category: entry.category,
        stage: entry.details.stage,
      })),
    ).toEqual([
      {
        timestamp: '2026-08-08T10:00:02.000Z',
        walletId: 'wallet-a',
        category: 'MINING',
        stage: 'running-reached',
      },
      {
        timestamp: '2026-08-08T10:00:01.000Z',
        walletId: 'wallet-a',
        category: 'MINING',
        stage: 'prepare-started',
      },
      {
        timestamp: '2026-08-08T10:00:00.000Z',
        walletId: 'wallet-a',
        category: 'MINING',
        stage: 'requested',
      },
    ]);
    expect(JSON.stringify(diagnostics.entries())).not.toMatch(
      /secret|credential/i,
    );
  });

  it('stops observing after disposal without controlling the event source', () => {
    const events = new CoreEventEmitter();
    const diagnostics = new RuntimeDiagnostics(events);
    diagnostics.dispose();

    events.publish({
      id: 'session-created:session-1:1',
      occurredAt: '2026-08-04T12:00:00.000Z',
      type: 'session-created',
      payload: { sessionId: 'session-1', generation: 1 },
    });

    expect(diagnostics.entries()).toEqual([]);
  });

  it('hydrates and persists bounded diagnostics without controlling events', async () => {
    const events = new CoreEventEmitter();
    const appendDiagnostic = vi.fn(async () => undefined);
    const diagnostics = new RuntimeDiagnostics(
      events,
      2,
      [
        { id: 'invalid-stored-entry' },
        {
          id: 'restored',
          occurredAt: '2026-08-04T11:00:00.000Z',
          eventType: 'session-started',
          category: 'info',
          title: 'session started',
          detail: 'Restored diagnostic',
          sessionId: 'session-1',
          generation: 1,
          code: null,
          message: null,
        },
      ],
      { appendDiagnostic },
    );

    events.publish({
      id: 'session-created:session-2:2',
      occurredAt: '2026-08-04T12:00:00.000Z',
      type: 'session-created',
      payload: { sessionId: 'session-2', generation: 2 },
    });
    await Promise.resolve();

    expect(diagnostics.entries().map((entry) => entry.id)).toEqual([
      'session-created:session-2:2',
      'restored',
    ]);
    expect(appendDiagnostic).toHaveBeenCalledOnce();
  });
});

function workerDiagnosticPayload(
  patch: Partial<WalletMiningWorkerDiagnosticEventPayload> = {},
): WalletMiningWorkerDiagnosticEventPayload {
  return {
    engine: 'NEW_WALLET_WORKER',
    stage: null,
    walletId: 'wallet-a',
    sessionId: 'session-a',
    generation: 21,
    miniEpoch: '78126000',
    workerState: 'WAITING_RESULT',
    queuedLocalTaps: 70,
    nativeComputedTaps: 70,
    computationCompletedTaps: 70,
    baselineTapSum: '140',
    latestTapSum: null,
    confirmedTapDelta: null,
    submissionStaggerMs: null,
    callbackAction: null,
    callbackSequence: null,
    errorPresent: null,
    nativeTopLevelMessage: null,
    tvmCode: null,
    tvmCodeName: null,
    kitModule: null,
    kitCode: null,
    serverCode: null,
    nodeExtensionCode: null,
    nodeExtensionMessage: null,
    tvmExitCode: null,
    transactionAborted: null,
    messageHash: null,
    transactionHash: null,
    accountId: null,
    dappId: null,
    threadId: null,
    producerFingerprint: null,
    coreVersion: null,
    failureStage: null,
    errorCategory: null,
    terminalOutcome: null,
    rewardStatus: 'NOT_REQUESTED',
    disposalStatus: 'NOT_STARTED',
    quarantined: false,
    stale: false,
    observationDerived: false,
    ...patch,
  };
}
