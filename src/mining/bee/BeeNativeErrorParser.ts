import {
  MiningNativeAdapterError,
  type SafeMiningFailure,
  type WalletMiningFailureStage,
} from '../WalletMiningRuntime';

export type BeeNativeErrorCategory =
  | 'NETWORK'
  | 'QUEUE'
  | 'CONTRACT'
  | 'PROTOCOL'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface BeeNativeSafeErrorFields {
  readonly errorPresent: boolean;
  readonly nativeTopLevelMessage: string | null;
  readonly tvmCode: number | null;
  readonly tvmCodeName: string | null;
  readonly kitModule: string | null;
  readonly kitCode: number | null;
  readonly serverCode: number | null;
  readonly nodeExtensionCode: string | null;
  readonly nodeExtensionMessage: string | null;
  readonly tvmExitCode: number | null;
  readonly transactionAborted: boolean | null;
  readonly messageHash: string | null;
  readonly transactionHash: string | null;
  readonly accountId: string | null;
  readonly dappId: string | null;
  readonly threadId: string | null;
  readonly producerFingerprint: string | null;
  readonly coreVersion: string | null;
  readonly failureStage: WalletMiningFailureStage;
  readonly errorCategory: BeeNativeErrorCategory | null;
}

export interface BeeNativeErrorInput {
  readonly action: string;
  readonly status: string | null;
  readonly rawError: unknown;
  readonly rawDataMessage: unknown;
}

const MAX_DIAGNOSTIC_INPUT_LENGTH = 12_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240;
const MAX_DIAGNOSTIC_IDENTIFIER_LENGTH = 160;

const NODE_EXTENSION_PATHS = [
  ['extensions'],
  ['node_error', 'extensions'],
  ['nodeError', 'extensions'],
  ['data', 'node_error', 'extensions'],
  ['data', 'nodeError', 'extensions'],
  ['tvm_error', 'data', 'node_error', 'extensions'],
  ['tvm_error', 'data', 'nodeError', 'extensions'],
  ['tvm_erorr', 'data', 'node_error', 'extensions'],
  ['tvm_erorr', 'data', 'nodeError', 'extensions'],
  ['error', 'data', 'node_error', 'extensions'],
] as const;

export function normalizeBeeNativeError(
  input: Readonly<BeeNativeErrorInput>,
): Readonly<BeeNativeSafeErrorFields> {
  const sources = recognizedSources([input.rawError, input.rawDataMessage]);
  const nativeTopLevelMessage = safeTopLevelMessage(input.rawError);
  const diagnosticText = [
    boundedString(input.rawError),
    boundedString(input.rawDataMessage),
    nativeTopLevelMessage,
  ]
    .filter((value): value is string => value !== null)
    .join(' ');
  const statusFailure =
    input.status === 'error' ||
    input.status === 'failed' ||
    /panic|failed|removed_with_error/.test(input.action);
  const errorPresent =
    statusFailure || meaningfulErrorEvidence(input.rawError, sources);

  if (!errorPresent) return emptyBeeNativeSafeErrorFields();

  const kitModule = safeString(
    firstKnownValue(sources, [
      ['kitModule'],
      ['kit_module'],
      ['module'],
      ['kit', 'module'],
    ]),
    80,
  ) ?? regexString(
    diagnosticText,
    /\bKitError\s*\{[^}]{0,500}?\bmodule:\s*([^,}]{1,80})/i,
    80,
  );
  const kitCode = safeNumber(
    firstKnownValue(sources, [
      ['kitCode'],
      ['kit_code'],
      ['kit', 'code'],
    ]),
  ) ?? regexNumber(
    diagnosticText,
    /\bKitError\s*\{[^}]{0,500}?\bcode:\s*(-?\d{1,10})/i,
  );
  const tvmCode = safeNumber(
    firstKnownValue(sources, [
      ['tvmCode'],
      ['tvm_code'],
      ['tvm_error', 'code'],
      ['tvmError', 'code'],
      ['tvm_erorr', 'code'],
    ]),
  ) ?? regexNumber(diagnosticText, /\bTVM[_ -]?(\d{1,5})\b/i) ??
    regexNumber(diagnosticText, /\bClient error code\s+(\d{1,5})\b/i);
  const serverCode = safeNumber(
    firstKnownValue(sources, [
      ['serverCode'],
      ['server_code'],
      ['clientError', 'code'],
      ['client_error', 'code'],
      ['data', 'server_code'],
    ]),
  ) ?? (kitModule ? null : safeNumber(
    firstKnownValue(sources, [['code'], ['data', 'code']]),
  )) ?? regexNumber(
    diagnosticText,
    /\bClientErrorInner\s*\{[^}]{0,500}?\bcode:\s*(-?\d{1,10})/i,
  );
  const nodeExtensionCode = safeIdentifier(
    firstNodeExtensionValue(sources, 'code'),
    80,
  ) ?? regexString(
    diagnosticText,
    /\bextensions\b.{0,600}?\bcode["']?\s*[:=]\s*(?:String\()?\s*["']([A-Z][A-Z0-9_-]{1,79})["']/is,
    80,
  );
  const nodeExtensionMessage = safeString(
    firstNodeExtensionValue(sources, 'message'),
    MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  ) ?? regexString(
    diagnosticText,
    /\bextensions\b.{0,1200}?\bmessage["']?\s*[:=]\s*(?:String\()?\s*["']([^"'\r\n]{1,500})["']/is,
    MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  );
  const tvmExitCode = safeNumber(
    firstSubmissionDetailValue(sources, ['exit_code', 'exitCode']),
  ) ?? regexNumber(
    diagnosticText,
    /\b(?:exit_code|exitCode)["']?\s*[:=]\s*(?:Number\()?\s*(-?\d{1,10})/i,
  );
  const transactionAborted = safeBoolean(
    firstSubmissionDetailValue(sources, [
      'aborted',
      'transaction_aborted',
      'transactionAborted',
    ]),
  ) ?? regexBoolean(
    diagnosticText,
    /\b(?:transaction_aborted|transactionAborted|aborted)["']?\s*[:=]\s*(?:Bool\()?\s*(true|false)/i,
  );
  const messageHash = identifierField(
    sources,
    diagnosticText,
    ['message_hash', 'messageHash'],
  );
  const transactionHash = identifierField(
    sources,
    diagnosticText,
    ['transaction_hash', 'transactionHash', 'tx_hash', 'txHash'],
  );
  const accountId = identifierField(
    sources,
    diagnosticText,
    ['account_id', 'accountId'],
  );
  const dappId = identifierField(
    sources,
    diagnosticText,
    ['dapp_id', 'dappId'],
  );
  const threadId = identifierField(
    sources,
    diagnosticText,
    ['thread_id', 'threadId'],
  );
  const coreVersion = safeIdentifier(
    firstKnownValue(sources, [
      ['core_version'],
      ['coreVersion'],
      ['data', 'core_version'],
      ['data', 'coreVersion'],
      ['tvm_error', 'data', 'core_version'],
      ['tvm_error', 'data', 'coreVersion'],
      ['tvm_erorr', 'data', 'core_version'],
      ['tvm_erorr', 'data', 'coreVersion'],
    ]) ?? regexStringField(diagnosticText, ['core_version', 'coreVersion']),
    40,
  );
  const producer = firstSubmissionDetailValue(sources, [
    'producers',
    'producer',
  ]) ?? regexProducer(diagnosticText);
  const producerIdentity = Array.isArray(producer) ? producer[0] : producer;
  const producerFingerprint = typeof producerIdentity === 'string'
    ? fingerprint(producerIdentity)
    : null;
  const failureStage = failureStageForBeeAction(input.action);
  const errorCategory = classifyError({
    diagnosticText,
    failureStage,
    nodeExtensionCode,
    nodeExtensionMessage,
    serverCode,
    tvmCode,
    tvmExitCode,
    transactionAborted,
  });

  return Object.freeze({
    errorPresent,
    nativeTopLevelMessage,
    tvmCode,
    tvmCodeName: tvmCode === null ? null : `TVM_${tvmCode}`,
    kitModule,
    kitCode,
    serverCode,
    nodeExtensionCode,
    nodeExtensionMessage,
    tvmExitCode,
    transactionAborted,
    messageHash,
    transactionHash,
    accountId,
    dappId,
    threadId,
    producerFingerprint,
    coreVersion,
    failureStage,
    errorCategory,
  });
}

export function failureStageForBeeAction(
  action: string,
): WalletMiningFailureStage {
  if (action === 'submit_session_root') return 'ROOT_SUBMIT';
  if (action === 'submit_session_proof') return 'PROOF_SUBMIT';
  return null;
}

export function beeMiningNativeAdapterError(
  error: unknown,
  failureStage: Exclude<WalletMiningFailureStage, null>,
): MiningNativeAdapterError {
  if (error instanceof MiningNativeAdapterError) return error;
  const parsed = normalizeBeeNativeError({
    action: 'native_error',
    status: 'failed',
    rawError: error,
    rawDataMessage: null,
  });
  const safeFailure: SafeMiningFailure = Object.freeze({
    failureStage,
    errorCategory: parsed.errorCategory ?? 'UNKNOWN',
    nativeTopLevelMessage: parsed.nativeTopLevelMessage,
    tvmCode: parsed.tvmCode,
    tvmCodeName: parsed.tvmCodeName,
    kitModule: parsed.kitModule,
    kitCode: parsed.kitCode,
    serverCode: parsed.serverCode,
    nodeExtensionCode: parsed.nodeExtensionCode,
    nodeExtensionMessage: parsed.nodeExtensionMessage,
    tvmExitCode: parsed.tvmExitCode,
    transactionAborted: parsed.transactionAborted,
    exitCode: parsed.tvmExitCode,
    aborted: parsed.transactionAborted,
    messageHash: parsed.messageHash,
    transactionHash: parsed.transactionHash,
    accountId: parsed.accountId,
    dappId: parsed.dappId,
    threadId: parsed.threadId,
    producerFingerprint: parsed.producerFingerprint,
    coreVersion: parsed.coreVersion,
  });
  return new MiningNativeAdapterError(safeFailure);
}

function emptyBeeNativeSafeErrorFields(): Readonly<BeeNativeSafeErrorFields> {
  return Object.freeze({
    errorPresent: false,
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
  });
}

function meaningfulErrorEvidence(
  rawError: unknown,
  sources: readonly Record<string, unknown>[],
): boolean {
  if (safeTopLevelMessage(rawError)) return true;
  return firstKnownValue(sources, [
    ['code'],
    ['server_code'],
    ['serverCode'],
    ['tvm_code'],
    ['tvmCode'],
    ['kit_code'],
    ['kitCode'],
    ['extensions', 'code'],
    ['node_error', 'extensions', 'code'],
    ['nodeError', 'extensions', 'code'],
    ['data', 'node_error', 'extensions', 'code'],
    ['data', 'nodeError', 'extensions', 'code'],
    ['exit_code'],
    ['exitCode'],
    ['aborted'],
    ['transaction_aborted'],
    ['transactionAborted'],
  ]) !== null;
}

function classifyError(input: Readonly<{
  diagnosticText: string;
  failureStage: WalletMiningFailureStage;
  nodeExtensionCode: string | null;
  nodeExtensionMessage: string | null;
  serverCode: number | null;
  tvmCode: number | null;
  tvmExitCode: number | null;
  transactionAborted: boolean | null;
}>): BeeNativeErrorCategory {
  const detail = [
    input.nodeExtensionCode,
    input.nodeExtensionMessage,
    input.diagnosticText,
  ].filter(Boolean).join(' ');
  const extensionCode = input.nodeExtensionCode?.trim().toUpperCase() ?? '';
  if (
    extensionCode === 'TVM_ERROR' &&
    (
      input.transactionAborted === true ||
      (input.tvmExitCode !== null && input.tvmExitCode !== 0)
    )
  ) return 'CONTRACT';
  if (
    extensionCode === 'QUEUE_OVERFLOW' ||
    extensionCode === 'DUPLICATE_MESSAGE'
  ) return 'QUEUE';
  if (
    input.transactionAborted === true ||
    (input.tvmExitCode !== null && input.tvmExitCode !== 0) ||
    /contract execution|transaction aborted|exit_code/i.test(detail)
  ) return 'CONTRACT';
  if (
    /QUEUE[_ -]?OVERFLOW|message queue is full|DUPLICATE[_ -]?MESSAGE/i.test(detail)
  ) return 'QUEUE';
  if (/\b(?:timed out|timeout)\b/i.test(detail)) return 'TIMEOUT';
  if (
    input.tvmCode === 11 ||
    /failed to fetch|network|connection|http|transport|invalid server response|<!doctype html|<html\b/i.test(detail)
  ) return 'NETWORK';
  if (
    /serialize|invalid boc|message.*destination|proof|merkle|verify session/i.test(detail)
  ) return 'PROTOCOL';
  return 'UNKNOWN';
}

function recognizedSources(values: readonly unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const value of values) {
    if (isRecord(value)) result.push(value);
    if (typeof value !== 'string') continue;
    const parsed = parseBoundedObject(value);
    if (parsed) result.push(parsed);
  }
  return result;
}

function parseBoundedObject(value: string): Record<string, unknown> | null {
  const text = value.trim().slice(0, MAX_DIAGNOSTIC_INPUT_LENGTH);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstKnownValue(
  sources: readonly Record<string, unknown>[],
  paths: readonly (readonly string[])[],
): unknown {
  for (const source of sources) {
    for (const path of paths) {
      let current: unknown = source;
      for (const segment of path) {
        if (!isRecord(current)) {
          current = undefined;
          break;
        }
        current = current[segment];
      }
      if (current !== null && current !== undefined) return current;
    }
  }
  return null;
}

function firstNodeExtensionValue(
  sources: readonly Record<string, unknown>[],
  key: string,
): unknown {
  return firstKnownValue(
    sources,
    NODE_EXTENSION_PATHS.map((path) => [...path, key]),
  );
}

function firstNodeDetailValue(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[],
): unknown {
  return firstKnownValue(
    sources,
    NODE_EXTENSION_PATHS.flatMap((path) => keys.flatMap((key) => [
      [...path, 'details', key],
      [...path, key],
    ])),
  );
}

function firstSubmissionDetailValue(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[],
): unknown {
  return firstKnownValue(
    sources,
    keys.flatMap((key) => [
      [key],
      ['data', key],
      ['result', key],
      ['data', 'result', key],
    ]),
  ) ?? firstNodeDetailValue(sources, keys);
}

function identifierField(
  sources: readonly Record<string, unknown>[],
  text: string,
  keys: readonly string[],
): string | null {
  return safeIdentifier(
    firstSubmissionDetailValue(sources, keys) ?? regexStringField(text, keys),
  );
}

function safeTopLevelMessage(value: unknown): string | null {
  if (typeof value === 'string') return sanitize(value, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
  if (value instanceof Error) {
    return sanitize(value.message || value.name, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
  }
  if (!isRecord(value)) return null;
  for (const key of ['message', 'error_message', 'reason', 'description']) {
    if (typeof value[key] === 'string') {
      return sanitize(value[key], MAX_DIAGNOSTIC_MESSAGE_LENGTH);
    }
  }
  return null;
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string'
    ? value.slice(0, MAX_DIAGNOSTIC_INPUT_LENGTH)
    : null;
}

function safeString(value: unknown, limit: number): string | null {
  return typeof value === 'string' ? sanitize(value, limit) : null;
}

function safeIdentifier(
  value: unknown,
  limit = MAX_DIAGNOSTIC_IDENTIFIER_LENGTH,
): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return sanitize(String(value), limit);
}

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string' || !/^-?\d{1,10}$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function regexNumber(value: string, pattern: RegExp): number | null {
  return safeNumber(value.match(pattern)?.[1]);
}

function regexBoolean(value: string, pattern: RegExp): boolean | null {
  return safeBoolean(value.match(pattern)?.[1]?.toLowerCase());
}

function regexString(
  value: string,
  pattern: RegExp,
  limit: number,
): string | null {
  return sanitize(value.match(pattern)?.[1] ?? null, limit);
}

function regexStringField(value: string, keys: readonly string[]): string | null {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = value.match(new RegExp(
      `\\b${escaped}["']?\\s*[:=]\\s*(?:String\\()?\\s*["']([^"'\\r\\n]{1,300})["']`,
      'i',
    ));
    if (match?.[1]) return match[1];
  }
  return null;
}

function regexProducer(value: string): string | null {
  return value.match(
    /\bproducers?["']?\s*[:=]\s*(?:Array\s*\[\s*)?(?:String\()?\s*["']([^"'\r\n]{1,300})["']/i,
  )?.[1] ?? null;
}

function sanitize(value: string | null, limit: number): string | null {
  if (!value) return null;
  const redacted = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(
      /\b(?:private[_ -]?key|secret(?:[_ -]?key)?|seed|authorization|cookie|credential|mnemonic)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;})]+)/gi,
      '[redacted]',
    )
    .replace(/\b(?:te6ccg|boc)[a-z0-9_+/=-]{128,}\b/gi, '[redacted-data]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!redacted) return null;
  return redacted.length <= limit
    ? redacted
    : `${redacted.slice(0, Math.max(0, limit - 1))}…`;
}

function fingerprint(value: string): string | null {
  const normalized = sanitize(value, MAX_DIAGNOSTIC_IDENTIFIER_LENGTH);
  if (!normalized) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
