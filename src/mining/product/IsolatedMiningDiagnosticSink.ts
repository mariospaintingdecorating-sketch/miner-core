import type {
  SafeMiningFailure,
  WalletMiningDiagnosticEvent,
  WalletMiningDiagnosticSink,
} from '../WalletMiningRuntime';

/** Rebuilds every event from the neutral allowlist before forwarding it. */
export class IsolatedMiningDiagnosticSink
  implements WalletMiningDiagnosticSink
{
  constructor(private readonly destination: WalletMiningDiagnosticSink) {}

  record(event: Readonly<WalletMiningDiagnosticEvent>): void {
    this.destination.record(allowlistedDiagnosticEvent(event));
  }
}

export function allowlistedDiagnosticEvent(
  event: Readonly<WalletMiningDiagnosticEvent>,
): Readonly<WalletMiningDiagnosticEvent> {
  return Object.freeze({
    occurredAtMs: event.occurredAtMs,
    kind: event.kind,
    walletId: event.walletId,
    sessionId: event.sessionId,
    generationToken: event.generationToken,
    miniEpoch: event.miniEpoch,
    workerState: event.workerState,
    queuedLocalTaps: event.queuedLocalTaps,
    nativeComputedTaps: event.nativeComputedTaps,
    computationCompletedTaps: event.computationCompletedTaps,
    stage: event.stage ?? null,
    baselineTapSum: event.baselineTapSum ?? null,
    latestTapSum: event.latestTapSum ?? null,
    confirmedTapDelta: event.confirmedTapDelta ?? null,
    submissionStaggerMs: event.submissionStaggerMs ?? null,
    callbackAction: event.callbackAction ?? null,
    callbackSequence: event.callbackSequence ?? null,
    errorPresent: event.errorPresent ?? null,
    nativeTopLevelMessage: event.nativeTopLevelMessage ?? null,
    tvmCode: event.tvmCode ?? null,
    tvmCodeName: event.tvmCodeName ?? null,
    kitModule: event.kitModule ?? null,
    kitCode: event.kitCode ?? null,
    serverCode: event.serverCode ?? null,
    nodeExtensionCode: event.nodeExtensionCode ?? null,
    nodeExtensionMessage: event.nodeExtensionMessage ?? null,
    tvmExitCode: event.tvmExitCode ?? null,
    transactionAborted: event.transactionAborted ?? null,
    messageHash: event.messageHash ?? null,
    transactionHash: event.transactionHash ?? null,
    accountId: event.accountId ?? null,
    dappId: event.dappId ?? null,
    threadId: event.threadId ?? null,
    producerFingerprint: event.producerFingerprint ?? null,
    coreVersion: event.coreVersion ?? null,
    failureStage: event.failureStage ?? null,
    errorCategory: event.errorCategory ?? null,
    terminalOutcome: event.terminalOutcome ?? null,
    rewardStatus: event.rewardStatus ?? null,
    disposalStatus: event.disposalStatus ?? null,
    quarantined: event.quarantined ?? false,
    failure: event.failure ? allowlistedFailure(event.failure) : null,
    stale: event.stale ?? false,
    observationDerived: event.observationDerived ?? false,
  });
}

function allowlistedFailure(
  failure: Readonly<SafeMiningFailure>,
): Readonly<SafeMiningFailure> {
  return Object.freeze({
    failureStage: failure.failureStage,
    errorCategory: failure.errorCategory,
    nativeTopLevelMessage: failure.nativeTopLevelMessage ?? null,
    tvmCode: failure.tvmCode ?? null,
    tvmCodeName: failure.tvmCodeName ?? null,
    kitModule: failure.kitModule ?? null,
    kitCode: failure.kitCode ?? null,
    serverCode: failure.serverCode ?? null,
    nodeExtensionCode: failure.nodeExtensionCode ?? null,
    nodeExtensionMessage: failure.nodeExtensionMessage ?? null,
    tvmExitCode: failure.tvmExitCode ?? null,
    transactionAborted: failure.transactionAborted ?? null,
    exitCode: failure.exitCode ?? null,
    aborted: failure.aborted ?? null,
    messageHash: failure.messageHash ?? null,
    transactionHash: failure.transactionHash ?? null,
    accountId: failure.accountId ?? null,
    dappId: failure.dappId ?? null,
    threadId: failure.threadId ?? null,
    producerFingerprint: failure.producerFingerprint ?? null,
    coreVersion: failure.coreVersion ?? null,
  });
}
