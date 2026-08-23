export type BeeFailureClassification =
  | 'QUEUE_OVERFLOW'
  | 'DUPLICATE_MESSAGE'
  | 'TIMEOUT'
  | 'FAILED_TO_FETCH'
  | 'INVALID_JSON'
  | 'UNKNOWN_NODE_ERROR';

export interface BeeFailureMetadata {
  readonly classification: BeeFailureClassification | null;
  readonly messageHash: string | null;
  readonly detail: string | null;
}

const MAX_ERROR_WALK_DEPTH = 6;
const MAX_ERROR_DETAIL_LENGTH = 1_000;
const MAX_MESSAGE_HASH_LENGTH = 256;

export function inspectBeeFailure(error: unknown): Readonly<BeeFailureMetadata> {
  const messages: string[] = [];
  const codes: string[] = [];
  const extensionCodes: string[] = [];
  const messageHashes: string[] = [];
  const visited = new Set<object>();

  inspectValue(
    error,
    0,
    visited,
    messages,
    codes,
    extensionCodes,
    messageHashes,
  );

  const extensionCode = extensionCodes[0]?.trim().toUpperCase() ?? null;
  const textClassification = classifyBeeFailureText(
    codes.join(' '),
    messages.join(' '),
  );
  const classification = extensionCode
    ? classificationFromExtensionCode(extensionCode)
    : textClassification;

  return Object.freeze({
    classification,
    messageHash: truncate(messageHashes[0], MAX_MESSAGE_HASH_LENGTH),
    detail:
      truncate(messages[0], MAX_ERROR_DETAIL_LENGTH) ?? fallbackDetail(error),
  });
}

export function classifyBeeFailureText(
  code: string | null | undefined,
  message: string | null | undefined,
): BeeFailureClassification | null {
  const detail = `${code ?? ''} ${message ?? ''}`;

  if (/DUPLICATE[_ -]?MESSAGE/i.test(detail)) {
    return 'DUPLICATE_MESSAGE';
  }
  if (/QUEUE[_ -]?OVERFLOW|message queue is full/i.test(detail)) {
    return 'QUEUE_OVERFLOW';
  }
  if (/\b(?:timed out|timeout)\b/i.test(detail)) {
    return 'TIMEOUT';
  }
  if (/\bcode\s*11\b|failed to fetch/i.test(detail)) {
    return 'FAILED_TO_FETCH';
  }
  if (/\bcode\s*12\b|body is not a valid JSON|EOF while parsing/i.test(detail)) {
    return 'INVALID_JSON';
  }
  if (/\b621\b/.test(detail)) {
    return 'UNKNOWN_NODE_ERROR';
  }

  return null;
}

function classificationFromExtensionCode(
  extensionCode: string,
): BeeFailureClassification {
  if (extensionCode === 'QUEUE_OVERFLOW') {
    return 'QUEUE_OVERFLOW';
  }
  if (extensionCode === 'DUPLICATE_MESSAGE') {
    return 'DUPLICATE_MESSAGE';
  }

  return 'UNKNOWN_NODE_ERROR';
}

function inspectValue(
  value: unknown,
  depth: number,
  visited: Set<object>,
  messages: string[],
  codes: string[],
  extensionCodes: string[],
  messageHashes: string[],
): void {
  if (depth > MAX_ERROR_WALK_DEPTH || value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    remember(messages, value);
    return;
  }

  if (typeof value !== 'object' || visited.has(value)) {
    return;
  }

  visited.add(value);
  if (value instanceof Error) {
    remember(messages, value.message);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      inspectValue(
        item,
        depth + 1,
        visited,
        messages,
        codes,
        extensionCodes,
        messageHashes,
      );
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const extensions = record.extensions;
  if (isRecord(extensions)) {
    remember(extensionCodes, extensions.code);
    remember(messageHashes, extensions.message_hash);
    remember(messageHashes, extensions.messageHash);
  }

  for (const [key, item] of Object.entries(record)) {
    if (/^(?:message|reason|description|error_message|error)$/i.test(key)) {
      remember(messages, item);
    }
    if (/^(?:code|error_code)$/i.test(key)) {
      remember(codes, item);
    }
    if (/^(?:message_hash|messageHash)$/i.test(key)) {
      remember(messageHashes, item);
    }

    if (item && typeof item === 'object') {
      inspectValue(
        item,
        depth + 1,
        visited,
        messages,
        codes,
        extensionCodes,
        messageHashes,
      );
    }
  }
}

function remember(target: string[], value: unknown): void {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return;
  }

  const normalized = String(value).trim();
  if (normalized && !target.includes(normalized)) {
    target.push(normalized);
  }
}

function fallbackDetail(value: unknown): string | null {
  if (value === false || value === null || value === undefined) {
    return null;
  }

  try {
    const serialized = JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item,
    );
    if (!serialized || serialized === '{}') {
      return null;
    }
    return serialized.length <= MAX_ERROR_DETAIL_LENGTH
      ? serialized
      : `${serialized.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`;
  } catch {
    return null;
  }
}

function truncate(value: string | undefined, limit: number): string | null {
  if (!value) {
    return null;
  }
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
