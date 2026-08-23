const MAX_EXPORT_JSON_BYTES = 25 * 1024 * 1024;
const SENSITIVE_KEY =
  /seed|private.?key|credential|secret|password|token|connection.?reference|mining.?reference|secure.?reference|deep.?link|session.?state|client.?dh/i;

export interface DiagnosticsArchiveBundle {
  readonly logs: unknown;
  readonly runtimeState: unknown;
  readonly walletSummary: unknown;
  readonly epochState: unknown;
  readonly systemMetrics: unknown;
  readonly recoveryHistory: unknown;
  readonly rewardHistory: unknown;
  readonly balanceSnapshots: unknown;
  readonly sessionResults: unknown;
}

export function diagnosticsArchiveFileName(now: Date = new Date()): string {
  return `core-miner-diagnostics-${now.toISOString().slice(0, 10)}.zip`;
}

export function sanitizeDiagnosticsBundle(
  value: unknown,
): Readonly<DiagnosticsArchiveBundle> {
  if (!isRecord(value)) {
    throw new TypeError('Invalid diagnostics export payload.');
  }

  return Object.freeze({
    logs: redact(value.logs),
    runtimeState: redact(value.runtimeState),
    walletSummary: redact(value.walletSummary),
    epochState: redact(value.epochState),
    systemMetrics: redact(value.systemMetrics),
    recoveryHistory: redact(value.recoveryHistory),
    rewardHistory: redact(value.rewardHistory),
    balanceSnapshots: redact(value.balanceSnapshots),
    sessionResults: redact(value.sessionResults),
  });
}

export function createDiagnosticsArchive(value: unknown): Buffer {
  const bundle = sanitizeDiagnosticsBundle(value);
  const files = [
    ['logs.json', bundle.logs],
    ['runtime-state.json', bundle.runtimeState],
    ['wallet-summary.json', bundle.walletSummary],
    ['epoch-state.json', bundle.epochState],
    ['system-metrics.json', bundle.systemMetrics],
    ['recovery-history.json', bundle.recoveryHistory],
    ['reward-history.json', bundle.rewardHistory],
    ['balance-snapshots.json', bundle.balanceSnapshots],
    ['session-results.json', bundle.sessionResults],
  ] as const;
  const encoded = files.map(([name, contents]) => {
    const data = Buffer.from(`${JSON.stringify(contents, null, 2)}\n`, 'utf8');
    if (data.length > MAX_EXPORT_JSON_BYTES) {
      throw new RangeError(`Diagnostics file ${name} is too large.`);
    }
    return { name, data };
  });
  return createStoredZip(encoded);
}

function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 30) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen, depth + 1));
  }
  if (!isRecord(value)) return null;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      safe[key] = '[REDACTED]';
      continue;
    }
    safe[key] = redact(entry, seen, depth + 1);
  }
  seen.delete(value);
  return safe;
}

function redactText(value: string): string {
  return value.replace(
    /\b(seed|private[ _-]?key|credential|secret|password|token)\b\s*[:=]\s*[^\s,;]+/gi,
    '$1=[REDACTED]',
  );
}

function createStoredZip(
  files: readonly Readonly<{ name: string; data: Buffer }>[],
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + file.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
