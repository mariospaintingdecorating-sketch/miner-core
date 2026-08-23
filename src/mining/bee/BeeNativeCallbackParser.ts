import type { SafeNativeCallback } from '../WalletMiningRuntime';
import { normalizeBeeNativeError } from './BeeNativeErrorParser';

const MAX_CALLBACK_JSON_LENGTH = 12_000;

export function normalizeBeeNativeCallback(
  nativeArguments: readonly unknown[],
  sequence: number,
): Readonly<SafeNativeCallback> {
  const record = findCallbackRecord(nativeArguments);
  const data = isRecord(record?.data) ? record.data : null;
  const action = canonicalAction(record?.action);
  const status = canonicalStatus(record?.status) ?? canonicalStatus(data?.status);
  const safeError = normalizeBeeNativeError({
    action,
    status,
    rawError: record?.error,
    rawDataMessage: data?.message,
  });
  const normalizedAction =
    action === 'unknown' && safeError.errorPresent ? 'native_error' : action;
  const computationCompletedTaps = normalizedAction === 'computation_completed'
    ? safeTapCount(record?.taps) ?? safeTapCount(data?.taps)
    : null;

  return Object.freeze({
    action: normalizedAction,
    sequence,
    status,
    computationCompletedTaps,
    errorPresent: safeError.errorPresent,
    failureStage: safeError.failureStage,
    errorCategory: safeError.errorCategory,
    nativeTopLevelMessage: safeError.nativeTopLevelMessage,
    tvmCode: safeError.tvmCode,
    tvmCodeName: safeError.tvmCodeName,
    kitModule: safeError.kitModule,
    kitCode: safeError.kitCode,
    serverCode: safeError.serverCode,
    nodeExtensionCode: safeError.nodeExtensionCode,
    nodeExtensionMessage: safeError.nodeExtensionMessage,
    tvmExitCode: safeError.tvmExitCode,
    transactionAborted: safeError.transactionAborted,
    messageHash: safeError.messageHash,
    transactionHash: safeError.transactionHash,
    accountId: safeError.accountId,
    dappId: safeError.dappId,
    threadId: safeError.threadId,
    producerFingerprint: safeError.producerFingerprint,
    coreVersion: safeError.coreVersion,
  });
}

function findCallbackRecord(
  values: readonly unknown[],
): Record<string, unknown> | null {
  const queue: unknown[] = [...values];
  const seen = new Set<object>();
  let inspected = 0;

  while (queue.length > 0 && inspected < 32) {
    inspected += 1;
    const value = queue.shift();
    if (typeof value === 'string') {
      const parsed = parseCallbackJson(value);
      if (parsed !== null) queue.push(parsed);
      continue;
    }
    if (Array.isArray(value)) {
      queue.push(...value.slice(0, 16));
      continue;
    }
    if (!isRecord(value) || seen.has(value)) continue;
    seen.add(value);
    if (
      'action' in value ||
      'status' in value ||
      'error' in value
    ) return value;
    if (isRecord(value.data) || Array.isArray(value.data)) queue.push(value.data);
    if (isRecord(value.payload) || Array.isArray(value.payload)) {
      queue.push(value.payload);
    }
  }
  return null;
}

function parseCallbackJson(value: string): unknown {
  const text = value.trim();
  if (
    text.length === 0 ||
    text.length > MAX_CALLBACK_JSON_LENGTH ||
    !(
      (text.startsWith('{') && text.endsWith('}')) ||
      (text.startsWith('[') && text.endsWith(']'))
    )
  ) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function canonicalAction(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const action = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  switch (action) {
    case 'status_updated':
    case 'tap_computed':
    case 'computation_completed':
    case 'submit_session_root':
    case 'submit_session_proof':
    case 'session_accepted':
    case 'session_rejected':
    case 'finished':
    case 'removed':
    case 'native_error':
      return action;
    default:
      return action.slice(0, 80) || 'unknown';
  }
}

function canonicalStatus(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const status = value.trim().toLowerCase();
  if (!status) return null;
  const safe = status.replace(/[^a-z0-9_-]/g, '_').slice(0, 80);
  return safe || null;
}

function safeTapCount(value: unknown): number | null {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) return value;
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
