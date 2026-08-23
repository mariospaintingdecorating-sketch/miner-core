import {
  CORE_EVENT_TYPES,
  type CoreEvent,
  type CoreEventType,
  type EventObserver,
} from '../shared/events';
import type { DiagnosticsHistoryStorageContract } from '../storage/contracts';
import {
  classifyBeeFailureText,
  type BeeFailureClassification,
} from '../shared/beeFailures';

export type RuntimeDiagnosticLevel = 'debug' | 'info' | 'warning' | 'error';

export type RuntimeDiagnosticCategory =
  | 'SYSTEM'
  | 'MINING'
  | 'WALLET'
  | 'BEE'
  | 'SETTLEMENT'
  | 'REWARD'
  | 'EPOCH'
  | 'NETWORK'
  | 'UI'
  | 'ERROR';

export type RuntimeDiagnosticDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface RuntimeDiagnostic {
  readonly id: string;
  readonly timestamp: string;
  readonly eventType: CoreEventType;
  readonly level: RuntimeDiagnosticLevel;
  readonly category: RuntimeDiagnosticCategory;
  readonly title: string;
  readonly detail: string;
  readonly walletId: string | null;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly miniEpoch: string | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly details: RuntimeDiagnosticDetails;
}

export type RuntimeDiagnosticListener = (
  diagnostics: readonly RuntimeDiagnostic[],
) => void;

export interface RuntimeDiagnosticsSource {
  entries(): readonly RuntimeDiagnostic[];
  latestError(): RuntimeDiagnostic | null;
  subscribe(listener: RuntimeDiagnosticListener): () => void;
  dispose?(): void;
}

export class RuntimeDiagnostics implements RuntimeDiagnosticsSource {
  private diagnostics: readonly RuntimeDiagnostic[];
  private readonly listeners = new Set<RuntimeDiagnosticListener>();
  private readonly unsubscribeFromEvents: readonly (() => void)[];

  constructor(
    eventObserver: EventObserver,
    private readonly capacity = 500,
    initialDiagnostics: readonly unknown[] = [],
    private readonly storage?: Pick<
      DiagnosticsHistoryStorageContract<RuntimeDiagnostic>,
      'appendDiagnostic'
    >,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Diagnostics capacity must be a positive integer.');
    }

    const restoredDiagnostics: RuntimeDiagnostic[] = [];

    for (const diagnostic of initialDiagnostics) {
      const restored = this.restoreDiagnostic(diagnostic);

      if (restored) {
        restoredDiagnostics.push(restored);
      }

      if (restoredDiagnostics.length === capacity) {
        break;
      }
    }

    this.diagnostics = Object.freeze(restoredDiagnostics);
    this.unsubscribeFromEvents = CORE_EVENT_TYPES.map((type) =>
      eventObserver.subscribe(type, (event) => this.observe(event)),
    );
  }

  entries(): readonly RuntimeDiagnostic[] {
    return this.diagnostics;
  }

  latestError(): RuntimeDiagnostic | null {
    return this.diagnostics.find((entry) => entry.level === 'error') ?? null;
  }

  subscribe(listener: RuntimeDiagnosticListener): () => void {
    this.listeners.add(listener);
    this.deliver(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribeFromEvents) {
      unsubscribe();
    }

    this.listeners.clear();
  }

  private observe(event: CoreEvent): void {
    if (
      event.type === 'tap-progress' &&
      event.payload.completedTapCount !== 1 &&
      event.payload.completedTapCount % 10 !== 0
    ) {
      return;
    }

    const diagnostic = this.translate(event);
    this.diagnostics = Object.freeze(
      [diagnostic, ...this.diagnostics].slice(0, this.capacity),
    );
    void this.storage?.appendDiagnostic(diagnostic).catch(() => undefined);

    for (const listener of [...this.listeners]) {
      this.deliver(listener);
    }
  }

  private deliver(listener: RuntimeDiagnosticListener): void {
    try {
      listener(this.diagnostics);
    } catch {
      // Diagnostic observers cannot control Core or other observers.
    }
  }

  private translate(event: CoreEvent): RuntimeDiagnostic {
    const identity = identityFromEvent(event);

    if (event.type === 'wallet-runtime-created') {
      return createDiagnostic(event, 'info', 'SYSTEM', {
        ...identity,
        title: 'wallet runtime created',
        detail: event.payload.walletId
          ? `Wallet runtime ${event.payload.walletId} created`
          : 'Unbound Core runtime created',
      });
    }

    if (event.type === 'wallet-runtime-start-stage') {
      return createDiagnostic(event, 'info', 'MINING', {
        ...identity,
        title: `wallet runtime start ${event.payload.stage}`,
        detail: `Wallet ${event.payload.walletId} · ${event.payload.stage}`,
        details: { stage: event.payload.stage },
      });
    }

    if (event.type === 'runtime-error') {
      return createDiagnostic(event, 'error', 'ERROR', {
        ...identity,
        title: 'runtime error',
        detail: `${event.payload.code}: ${event.payload.message}`,
        code: event.payload.code,
        message: event.payload.message,
      });
    }

    if (event.type === 'epoch-changed') {
      return createDiagnostic(event, 'info', 'EPOCH', {
        ...identity,
        title: 'epoch changed',
        detail: `Mini epoch ${event.payload.previousMiniEpoch ?? 'unknown'} → ${event.payload.miniEpoch}`,
        details: {
          previousMiniEpoch: event.payload.previousMiniEpoch,
          mainEpoch: event.payload.mainEpoch,
          currentBlock: event.payload.currentBlock,
          confidence: event.payload.confidence,
          lastFailureCode: event.payload.lastFailureCode,
        },
      });
    }

    if (event.type === 'bee-sdk-ready' || event.type === 'bee-sdk-failed') {
      return createDiagnostic(
        event,
        event.type === 'bee-sdk-failed' ? 'error' : 'info',
        'BEE',
        {
          ...identity,
          title: event.type.replaceAll('-', ' '),
          detail:
            event.type === 'bee-sdk-ready'
              ? `Bee SDK ready${event.payload.version ? ` · ${event.payload.version}` : ''}`
              : `${event.payload.code}: ${event.payload.message}`,
          code: event.payload.code,
          message: event.payload.message,
          details: { version: event.payload.version },
        },
      );
    }

    if (
      event.type === 'bee-wallet-connection-started' ||
      event.type === 'bee-wallet-connected' ||
      event.type === 'bee-wallet-connection-failed'
    ) {
      return createDiagnostic(
        event,
        event.type === 'bee-wallet-connection-failed' ? 'error' : 'info',
        'WALLET',
        {
          ...identity,
          title: event.type.replaceAll('-', ' '),
          detail: event.payload.walletName
            ? `Wallet ${event.payload.walletName} · ${event.payload.state}`
            : `Wallet connection · ${event.payload.state}`,
          code: event.payload.code,
          message: event.payload.message,
          details: { state: event.payload.state },
        },
      );
    }

    if (
      event.type === 'bee-mining-started' ||
      event.type === 'bee-mining-failed'
    ) {
      const classification =
        event.payload.classification ??
        classifyBeeFailureText(event.payload.code, event.payload.message);
      const operation = operationFromId(event.payload.operationId);
      return createDiagnostic(
        event,
        event.type === 'bee-mining-failed' ? 'error' : 'info',
        'BEE',
        {
          ...identity,
          title: event.type.replaceAll('-', ' '),
          detail: `Wallet ${event.payload.walletId} · operation ${operation}${classification ? ` · reason: ${classification}` : ''}`,
          code: event.payload.code,
          message: event.payload.message,
          details: {
            operation,
            classification,
            messageHash: event.payload.messageHash ?? null,
          },
        },
      );
    }

    if (event.type === 'bee-graphql-pool-timeout') {
      return createDiagnostic(event, 'error', 'NETWORK', {
        ...identity,
        title: 'bee graphql pool timeout',
        detail: `Wallet ${event.payload.walletId} · ${event.payload.operation}`,
        code: event.payload.code,
        message: 'Bee miner-events GraphQL request reported a pool timeout.',
        details: {
          operation: event.payload.operation,
          category: event.payload.category,
        },
      });
    }

    if (event.type === 'bee-settlement-outcome') {
      const level: RuntimeDiagnosticLevel =
        event.payload.outcome === 'accepted' ||
        event.payload.outcome === 'completed'
          ? 'info'
          : event.payload.outcome === 'unknown'
            ? 'warning'
          : 'error';
      const reason = classifyBeeFailureReason(
        event.payload.code,
        event.payload.message,
        event.payload.classification,
        event.payload.outcome === 'native_error',
      );
      const operation = operationFromId(event.payload.operationId);
      return createDiagnostic(event, level, 'SETTLEMENT', {
        ...identity,
        title: 'bee settlement outcome',
        detail: `Wallet ${event.payload.walletId} · ${event.payload.outcome}${reason ? ` · reason: ${reason}` : ''}`,
        code: event.payload.code,
        message: event.payload.message,
        details: {
          operation,
          outcome: event.payload.outcome,
          reason,
          messageHash: event.payload.messageHash ?? null,
        },
      });
    }

    if (event.type === 'bee-settlement-trace') {
      return createDiagnostic(event, 'debug', 'SETTLEMENT', {
        ...identity,
        title: 'bee settlement trace',
        detail: `Wallet ${event.payload.walletId} · ${event.payload.stage}`,
        details: {
          operation: operationFromId(event.payload.operationId),
          operationId: event.payload.operationId,
          stage: event.payload.stage,
          completedTapCount: event.payload.completedTapCount,
          baselineTapSum: event.payload.baselineTapSum,
          latestTapSum: event.payload.latestTapSum,
          submissionStaggerMs: event.payload.submissionStaggerMs,
          callbackAction: event.payload.callbackAction,
          callbackStatus: event.payload.callbackStatus,
          callbackErrorPresent: event.payload.callbackErrorPresent,
          errorPresent: event.payload.errorPresent,
          callbackSequence: event.payload.callbackSequence,
          submitSessionProofCount: event.payload.submitSessionProofCount,
          terminalStatus: event.payload.terminalStatus,
          classification: event.payload.classification,
          stopToCallbackMs: event.payload.stopToCallbackMs,
          settlementToTerminalMs: event.payload.settlementToTerminalMs,
          errorCode: event.payload.errorCode,
          errorCategory: event.payload.errorCategory,
          nativeTopLevelMessage: event.payload.nativeTopLevelMessage,
          tvmCode: event.payload.tvmCode,
          tvmCodeName: event.payload.tvmCodeName,
          kitModule: event.payload.kitModule,
          kitCode: event.payload.kitCode,
          serverCode: event.payload.serverCode,
          nodeExtensionCode: event.payload.nodeExtensionCode,
          nodeExtensionMessage: event.payload.nodeExtensionMessage,
          tvmExitCode: event.payload.tvmExitCode,
          transactionAborted: event.payload.transactionAborted,
          messageHash: event.payload.messageHash,
          transactionHash: event.payload.transactionHash,
          accountId: event.payload.accountId,
          dappId: event.payload.dappId,
          threadId: event.payload.threadId,
          producerFingerprint: event.payload.producerFingerprint,
          coreVersion: event.payload.coreVersion,
          failureStage: event.payload.failureStage,
          durationMs: event.payload.durationMs,
        },
      });
    }

    if (event.type === 'wallet-mining-worker-diagnostic') {
      const failed = walletMiningDiagnosticFailed(event.payload);
      return createDiagnostic(
        event,
        failed ? 'error' : 'debug',
        event.payload.failureStage ? 'SETTLEMENT' : 'MINING',
        {
          ...identity,
          title: 'new wallet mining worker diagnostic',
          detail: `Wallet ${event.payload.walletId} · ${event.payload.stage ?? event.payload.workerState}`,
          code: event.payload.errorCategory,
          message: event.payload.nativeTopLevelMessage,
          details: {
            engine: event.payload.engine,
            stage: event.payload.stage,
            workerState: event.payload.workerState,
            queuedLocalTaps: event.payload.queuedLocalTaps,
            nativeComputedTaps: event.payload.nativeComputedTaps,
            computationCompletedTaps:
              event.payload.computationCompletedTaps,
            baselineTapSum: event.payload.baselineTapSum,
            latestTapSum: event.payload.latestTapSum,
            confirmedTapDelta: event.payload.confirmedTapDelta,
            submissionStaggerMs: event.payload.submissionStaggerMs,
            callbackAction: event.payload.callbackAction,
            callbackSequence: event.payload.callbackSequence,
            errorPresent: event.payload.errorPresent,
            nativeTopLevelMessage: event.payload.nativeTopLevelMessage,
            tvmCode: event.payload.tvmCode,
            tvmCodeName: event.payload.tvmCodeName,
            kitModule: event.payload.kitModule,
            kitCode: event.payload.kitCode,
            serverCode: event.payload.serverCode,
            nodeExtensionCode: event.payload.nodeExtensionCode,
            nodeExtensionMessage: event.payload.nodeExtensionMessage,
            tvmExitCode: event.payload.tvmExitCode,
            transactionAborted: event.payload.transactionAborted,
            messageHash: event.payload.messageHash,
            transactionHash: event.payload.transactionHash,
            accountId: event.payload.accountId,
            dappId: event.payload.dappId,
            threadId: event.payload.threadId,
            producerFingerprint: event.payload.producerFingerprint,
            coreVersion: event.payload.coreVersion,
            failureStage: event.payload.failureStage,
            errorCategory: event.payload.errorCategory,
            terminalOutcome: event.payload.terminalOutcome,
            rewardStatus: event.payload.rewardStatus,
            disposalStatus: event.payload.disposalStatus,
            quarantined: event.payload.quarantined,
            stale: event.payload.stale,
            observationDerived: event.payload.observationDerived,
          },
        },
      );
    }

    if (event.type === 'bee-reward-sync-completed') {
      return createDiagnostic(
        event,
        event.payload.code ? 'error' : 'info',
        'REWARD',
        {
          ...identity,
          title: 'bee reward sync completed',
          detail: `Wallet ${event.payload.walletId} · ${event.payload.confirmedRewardCount} confirmed rewards`,
          code: event.payload.code,
          message: event.payload.message,
          details: {
            confirmedRewardCount: event.payload.confirmedRewardCount,
          },
        },
      );
    }

    if (event.type === 'tap-execution-failed') {
      return createDiagnostic(event, 'error', 'MINING', {
        ...identity,
        title: 'tap execution failed',
        detail: `${event.payload.code}: ${event.payload.message} · execution ${event.payload.executionId}`,
        code: event.payload.code,
        message: event.payload.message,
        details: { executionId: event.payload.executionId },
      });
    }

    if (
      event.type === 'warning' ||
      event.type === 'recovery-started' ||
      event.type === 'recovery-completed'
    ) {
      const level: RuntimeDiagnosticLevel =
        event.type === 'recovery-completed'
          ? 'info'
          : event.type === 'warning' || event.payload.severity === 'warning'
            ? 'warning'
            : 'error';

      return createDiagnostic(event, level, 'ERROR', {
        ...identity,
        title: event.type.replaceAll('-', ' '),
        detail: `${event.payload.code}: ${event.payload.message}`,
        code: event.payload.code,
        message: event.payload.message,
        details: {
          operation: event.payload.operation ?? null,
          attempt: event.payload.attempt ?? null,
          maximumAttempts: event.payload.maximumAttempts ?? null,
          delayMs: event.payload.delayMs ?? null,
          errorType: event.payload.errorType ?? null,
          classification: event.payload.classification ?? null,
          messageHash: event.payload.messageHash ?? null,
        },
      });
    }

    if (
      event.type === 'reward-received' ||
      event.type === 'reward-recorded'
    ) {
      return createDiagnostic(event, 'info', 'REWARD', {
        ...identity,
        title: event.type.replaceAll('-', ' '),
        detail: `Wallet ${event.payload.walletId} · reward ${event.payload.rewardId} · ${event.payload.amount} ${event.payload.unit}`,
        details: {
          rewardId: event.payload.rewardId,
          amount: event.payload.amount,
          unit: event.payload.unit,
        },
      });
    }

    const isTapProgress = event.type === 'tap-progress';
    const category: RuntimeDiagnosticCategory =
      event.type === 'boundary-reached'
        ? 'EPOCH'
        : event.type === 'settlement-started' ||
            event.type === 'settlement-completed'
          ? 'SETTLEMENT'
          : event.type === 'reward-sync-started'
            ? 'REWARD'
            : 'MINING';
    const tapDetail = isTapProgress
      ? ` · ${event.payload.completedTapCount} completed taps`
      : '';

    return createDiagnostic(event, isTapProgress ? 'debug' : 'info', category, {
      ...identity,
      title: event.type.replaceAll('-', ' '),
      detail: `Session ${event.payload.sessionId} · generation ${event.payload.generation}${tapDetail}`,
      details: isTapProgress
        ? { completedTapCount: event.payload.completedTapCount }
        : {},
    });
  }

  private restoreDiagnostic(value: unknown): RuntimeDiagnostic | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const diagnostic = value as Record<string, unknown>;
    const timestamp =
      typeof diagnostic.timestamp === 'string'
        ? diagnostic.timestamp
        : diagnostic.occurredAt;
    const validEventType =
      typeof diagnostic.eventType === 'string' &&
      CORE_EVENT_TYPES.includes(diagnostic.eventType as CoreEventType);
    const validNullableString = (field: unknown) =>
      field === null || typeof field === 'string';
    const validOptionalNullableString = (field: unknown) =>
      field === undefined || validNullableString(field);
    const validGeneration =
      diagnostic.generation === null ||
      (typeof diagnostic.generation === 'number' &&
        Number.isInteger(diagnostic.generation) &&
        diagnostic.generation >= 1);

    if (
      typeof diagnostic.id !== 'string' ||
      typeof timestamp !== 'string' ||
      !validEventType ||
      typeof diagnostic.title !== 'string' ||
      typeof diagnostic.detail !== 'string' ||
      !validOptionalNullableString(diagnostic.walletId) ||
      !validNullableString(diagnostic.sessionId) ||
      !validGeneration ||
      !validOptionalNullableString(diagnostic.miniEpoch) ||
      !validNullableString(diagnostic.code) ||
      !validNullableString(diagnostic.message)
    ) {
      return null;
    }

    const eventType = diagnostic.eventType as CoreEventType;
    const level = restoreLevel(diagnostic);
    const category = restoreCategory(diagnostic, eventType);

    if (!level || !category) {
      return null;
    }

    const restoredMessage = diagnostic.message === null
      ? null
      : publicDiagnosticMessage(
          diagnostic.message as string,
          diagnostic.code as string | null,
        );
    const restoredDetail = restoredMessage && diagnostic.message
      ? diagnostic.detail.replace(diagnostic.message as string, restoredMessage)
      : diagnostic.detail;

    return Object.freeze({
      id: diagnostic.id,
      timestamp,
      eventType,
      level,
      category,
      title: redactDiagnosticText(diagnostic.title),
      detail: redactDiagnosticText(restoredDetail),
      walletId: (diagnostic.walletId as string | null | undefined) ?? null,
      sessionId: diagnostic.sessionId as string | null,
      generation: diagnostic.generation as number | null,
      miniEpoch: (diagnostic.miniEpoch as string | null | undefined) ?? null,
      code: diagnostic.code === null
        ? null
        : redactDiagnosticText(diagnostic.code as string),
      message: restoredMessage,
      details: restoreDetails(diagnostic.details),
    });
  }
}

interface DiagnosticFields {
  readonly title: string;
  readonly detail: string;
  readonly walletId?: string | null;
  readonly sessionId?: string | null;
  readonly generation?: number | null;
  readonly miniEpoch?: string | null;
  readonly code?: string | null;
  readonly message?: string | null;
  readonly details?: RuntimeDiagnosticDetails;
}

function createDiagnostic(
  event: CoreEvent,
  level: RuntimeDiagnosticLevel,
  category: RuntimeDiagnosticCategory,
  fields: DiagnosticFields,
): RuntimeDiagnostic {
  const safeMessage = fields.message
    ? publicDiagnosticMessage(fields.message, fields.code)
    : null;
  const safeDetail = fields.message && safeMessage
    ? fields.detail.replace(fields.message, safeMessage)
    : fields.detail;
  return Object.freeze({
    id: event.id,
    timestamp: event.occurredAt,
    eventType: event.type,
    level,
    category,
    title: redactDiagnosticText(fields.title),
    detail: redactDiagnosticText(safeDetail),
    walletId: fields.walletId ?? null,
    sessionId: fields.sessionId ?? null,
    generation: fields.generation ?? null,
    miniEpoch: fields.miniEpoch ?? null,
    code: fields.code ? redactDiagnosticText(fields.code) : null,
    message: safeMessage,
    details: restoreDetails(fields.details),
  });
}

function identityFromEvent(event: CoreEvent): Readonly<{
  walletId: string | null;
  sessionId: string | null;
  generation: number | null;
  miniEpoch: string | null;
}> {
  const payload = event.payload as unknown as Record<string, unknown>;
  return Object.freeze({
    walletId: typeof payload.walletId === 'string' ? payload.walletId : null,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null,
    generation:
      typeof payload.generation === 'number' ? payload.generation : null,
    miniEpoch:
      typeof payload.miniEpoch === 'string'
        ? payload.miniEpoch
        : event.type === 'epoch-changed'
          ? event.payload.miniEpoch
          : null,
  });
}

function restoreLevel(
  diagnostic: Record<string, unknown>,
): RuntimeDiagnosticLevel | null {
  if (
    diagnostic.level === 'debug' ||
    diagnostic.level === 'info' ||
    diagnostic.level === 'warning' ||
    diagnostic.level === 'error'
  ) {
    return diagnostic.level;
  }

  if (
    diagnostic.category === 'info' ||
    diagnostic.category === 'warning' ||
    diagnostic.category === 'error'
  ) {
    return diagnostic.category;
  }

  return diagnostic.category === 'recovery' ? 'info' : null;
}

function restoreCategory(
  diagnostic: Record<string, unknown>,
  eventType: CoreEventType,
): RuntimeDiagnosticCategory | null {
  if (DIAGNOSTIC_CATEGORIES.includes(diagnostic.category as RuntimeDiagnosticCategory)) {
    return diagnostic.category as RuntimeDiagnosticCategory;
  }

  return categoryForEvent(eventType);
}

function categoryForEvent(eventType: CoreEventType): RuntimeDiagnosticCategory {
  if (eventType === 'wallet-runtime-created') return 'SYSTEM';
  if (eventType === 'wallet-runtime-start-stage') return 'MINING';
  if (eventType === 'runtime-error' || eventType.startsWith('recovery-') || eventType === 'warning') return 'ERROR';
  if (eventType === 'epoch-changed' || eventType === 'boundary-reached') return 'EPOCH';
  if (eventType.includes('settlement')) return 'SETTLEMENT';
  if (eventType.includes('reward')) return 'REWARD';
  if (eventType === 'wallet-mining-worker-diagnostic') return 'MINING';
  if (eventType.startsWith('bee-wallet-')) return 'WALLET';
  if (eventType.startsWith('bee-')) return 'BEE';
  return 'MINING';
}

function restoreDetails(value: unknown): RuntimeDiagnosticDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze({});
  }

  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, detail] of Object.entries(value)) {
    if (isSensitiveDiagnosticKey(key)) {
      continue;
    }
    if (
      detail === null ||
      typeof detail === 'number' ||
      typeof detail === 'boolean'
    ) {
      safe[key] = detail;
    } else if (typeof detail === 'string') {
      safe[key] = redactDiagnosticText(detail);
    }
  }
  return Object.freeze(safe);
}

export function redactDiagnosticText(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const redacted = normalized
    .replace(
      /(["']?(?:seed|private[ _-]?key|credential|secret|password|token)["']?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]\s]+)/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /\b(seed|private[ _-]?key|credential|secret|password|token)\b\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    );

  return redacted.length <= MAX_DIAGNOSTIC_TEXT_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}… [truncated]`;
}

function publicDiagnosticMessage(
  value: string,
  code: string | null | undefined,
): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim();

  if (looksLikeStructuredPayload(normalized)) {
    const safeCode = code ? redactDiagnosticText(code) : null;
    return safeCode
      ? `Native payload omitted (${safeCode}).`
      : 'Native payload omitted.';
  }

  return redactDiagnosticText(normalized);
}

function looksLikeStructuredPayload(value: string): boolean {
  if (!value.startsWith('{') && !value.startsWith('[')) {
    return false;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return /["'][^"']+["']\s*:/.test(value);
  }
}

function isSensitiveDiagnosticKey(key: string): boolean {
  return /seed|private.?key|credential|secret|password|token/i.test(key);
}

export function classifyBeeFailureReason(
  code: string | null | undefined,
  message: string | null | undefined,
  classification?: BeeFailureClassification | null,
  nativeError = false,
): string | null {
  const normalizedCode = code?.trim().toUpperCase() ?? '';
  if (
    normalizedCode === 'ROOT_SUBMIT' ||
    normalizedCode === 'PROOF_SUBMIT'
  ) {
    return normalizedCode;
  }
  return (
    classification ??
    classifyBeeFailureText(code, message) ??
    (nativeError ? 'UNKNOWN_NATIVE_ERROR' : null)
  );
}

function walletMiningDiagnosticFailed(
  payload: Readonly<
    CoreEvent<'wallet-mining-worker-diagnostic'>['payload']
  >,
): boolean {
  if (payload.errorPresent === true || payload.quarantined) return true;
  if (
    payload.stage === 'TERMINAL' &&
    payload.terminalOutcome !== null &&
    payload.terminalOutcome !== 'ACCEPTED' &&
    payload.terminalOutcome !== 'CANCELLED' &&
    payload.terminalOutcome !== 'AMBIGUOUS'
  ) {
    return true;
  }
  if (
    payload.stage === 'NATIVE_FREE_RESULT' &&
    payload.disposalStatus === 'FAILED'
  ) {
    return true;
  }
  if (
    payload.stage === 'REWARD_RESULT' &&
    (payload.rewardStatus === 'FAILED' || payload.rewardStatus === 'TIMED_OUT')
  ) {
    return true;
  }
  return Boolean(
    payload.failureStage &&
    (payload.stage === 'NATIVE_PREPARE_RESULT' ||
      payload.stage === 'MINER_STOP_RETURN'),
  );
}

function operationFromId(operationId: string): string {
  const [operation] = operationId.split(':', 1);
  return operation?.trim() || 'runtime';
}

const DIAGNOSTIC_CATEGORIES: readonly RuntimeDiagnosticCategory[] = [
  'SYSTEM',
  'MINING',
  'WALLET',
  'BEE',
  'SETTLEMENT',
  'REWARD',
  'EPOCH',
  'NETWORK',
  'UI',
  'ERROR',
];

const MAX_DIAGNOSTIC_TEXT_LENGTH = 4_000;
