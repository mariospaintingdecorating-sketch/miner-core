import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type WalletStatus = 'running' | 'idle' | 'warning' | 'error' | 'offline';
type WalletOnboardingStatus =
  | 'disconnected'
  | 'awaiting-connection'
  | 'connected'
  | 'awaiting-mining-key-approval'
  | 'propagating-mining-key'
  | 'ready'
  | 'failed';

type StoredWalletOnboardingStatus =
  | WalletOnboardingStatus
  | 'awaiting-approval';

export interface StoredWalletDefinition {
  readonly id: string;
  readonly name: string;
  readonly status?: WalletStatus;
  readonly walletAddress?: string | null;
  readonly onboardingStatus?: WalletOnboardingStatus;
  readonly connectionReference?: string | null;
  readonly miningCredentialReference?: string | null;
  readonly mamaBoardLevel?: number | null;
}

export interface StoredRewardRecord {
  readonly id: string;
  readonly walletId: string;
  readonly amount: {
    readonly value: string;
    readonly unit: string;
  };
  readonly recordedAt: number;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly kind?: 'confirmed-reward' | 'locked-nackl-delta';
  readonly lockedNacklBeforeRaw?: string | null;
  readonly lockedNacklAfterRaw?: string | null;
  readonly detectionSource?:
    | 'settlement'
    | 'reward-sync'
    | 'epoch'
    | 'manual'
    | 'monitoring';
}

export interface StoredWalletBalanceSnapshot {
  readonly walletId: string;
  readonly values: Readonly<{
    nacklLockedRaw: string;
    nacklAvailableRaw: string;
    usdcRaw: string;
    shellRaw: string;
  }> | null;
  readonly synchronizedAt: string;
  readonly status: 'fresh' | 'partial' | 'error';
  readonly errorCode: string | null;
}

export interface StoredWalletSessionResult {
  readonly walletId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly miniEpoch: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly completedTaps: number;
  readonly targetTaps: number;
  readonly verifiedTaps: number | null;
  readonly rejectedTaps: number | null;
  readonly settlementOutcome: string;
  readonly stopReason: string;
  readonly rewardDeltaRaw: string | null;
  readonly recoveryUsed: boolean;
}

interface WalletRow {
  readonly id: string;
  readonly name: string;
  readonly status: WalletStatus;
  readonly wallet_address: string | null;
  readonly connection_status: StoredWalletOnboardingStatus;
  readonly connection_reference: string | null;
  readonly mining_credential_reference: string | null;
  readonly mama_board_level: number | null;
}

interface JsonRow {
  readonly payload: string;
}

interface DatabaseVersionRow {
  readonly user_version: number;
}

interface UptimeTotalRow {
  readonly total_ms: number;
}

interface UptimeOpenRow {
  readonly started_at: number;
}

export interface StoredMainEpochStartSchedule {
  readonly status: 'waiting-for-main-epoch' | 'waiting-for-delay';
  readonly armedAt: number;
  readonly baselineMainEpoch: string;
  readonly delayHours: number;
  readonly detectedMainEpoch: string | null;
  readonly epochDetectedAt: number | null;
  readonly targetStartAt: number | null;
}

const WALLET_STATUSES = new Set<WalletStatus>([
  'running',
  'idle',
  'warning',
  'error',
  'offline',
]);

const WALLET_ONBOARDING_STATUSES = new Set<WalletOnboardingStatus>([
  'disconnected',
  'awaiting-connection',
  'connected',
  'awaiting-mining-key-approval',
  'propagating-mining-key',
  'ready',
  'failed',
]);
const REWARD_DETECTION_SOURCES = new Set<
  NonNullable<StoredRewardRecord['detectionSource']>
>(['settlement', 'reward-sync', 'epoch', 'manual', 'monitoring']);

export const CURRENT_DATABASE_SCHEMA_VERSION = 5;
const DEFAULT_DIAGNOSTIC_WRITE_CAPACITY = 200;

type DiagnosticWritePriority = 'low' | 'normal' | 'high';

interface DiagnosticWriteEntry<T> {
  readonly value: T;
  readonly priority: DiagnosticWritePriority;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export interface DiagnosticWriteQueueMetrics {
  readonly capacity: number;
  readonly pending: number;
  readonly dropped: number;
  readonly writeFailures: number;
}

/**
 * A small, bounded persistence queue. It keeps failures and terminal events in
 * preference to repetitive progress diagnostics without feeding queue failures
 * back into diagnostics and creating a recursive failure path.
 */
export class DiagnosticWriteQueue<T> {
  readonly #capacity: number;
  readonly #writer: (value: T) => Promise<void>;
  readonly #queue: DiagnosticWriteEntry<T>[] = [];
  #active = false;
  #dropped = 0;
  #writeFailures = 0;
  #settledPromise: Promise<void> | null = null;
  #resolveSettled: (() => void) | null = null;

  constructor(capacity: number, writer: (value: T) => Promise<void>) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Diagnostic write capacity must be a positive integer.');
    }

    this.#capacity = capacity;
    this.#writer = writer;
  }

  enqueue(value: T, priority: DiagnosticWritePriority): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry = { value, priority, resolve, reject };
      const pending = this.#queue.length + (this.#active ? 1 : 0);
      const lowPriorityLimit = Math.max(1, Math.floor(this.#capacity * 0.8));

      if (priority === 'low' && pending >= lowPriorityLimit) {
        this.#drop(entry);
        return;
      }

      if (pending >= this.#capacity && !this.#makeRoom(priority)) {
        this.#drop(entry);
        return;
      }

      this.#queue.push(entry);
      this.#drain();
    });
  }

  snapshot(): DiagnosticWriteQueueMetrics {
    return Object.freeze({
      capacity: this.#capacity,
      pending: this.#queue.length + (this.#active ? 1 : 0),
      dropped: this.#dropped,
      writeFailures: this.#writeFailures,
    });
  }

  settled(): Promise<void> {
    if (!this.#active && this.#queue.length === 0) {
      return Promise.resolve();
    }

    if (!this.#settledPromise) {
      this.#settledPromise = new Promise<void>((resolve) => {
        this.#resolveSettled = resolve;
      });
    }

    return this.#settledPromise;
  }

  #makeRoom(priority: DiagnosticWritePriority): boolean {
    const preferred = priority === 'high'
      ? (['low', 'normal', 'high'] as const)
      : (['low'] as const);

    for (const candidate of preferred) {
      const index = this.#queue.findIndex((entry) => entry.priority === candidate);

      if (index >= 0) {
        const [dropped] = this.#queue.splice(index, 1);
        this.#drop(dropped);
        return true;
      }
    }

    return false;
  }

  #drop(entry: DiagnosticWriteEntry<T>): void {
    this.#dropped += 1;
    entry.resolve();
  }

  #drain(): void {
    if (this.#active) {
      return;
    }

    const entry = this.#queue.shift();

    if (!entry) {
      this.#resolveSettled?.();
      this.#settledPromise = null;
      this.#resolveSettled = null;
      return;
    }

    this.#active = true;
    void this.#writer(entry.value)
      .then(entry.resolve, (error) => {
        this.#writeFailures += 1;
        entry.reject(error);
      })
      .finally(() => {
        this.#active = false;
        this.#drain();
      });
  }
}

function diagnosticWritePriority(diagnostic: unknown): DiagnosticWritePriority {
  if (!diagnostic || typeof diagnostic !== 'object') {
    return 'normal';
  }

  const candidate = diagnostic as Readonly<Record<string, unknown>>;

  if (candidate.level === 'error' || candidate.category === 'ERROR') {
    return 'high';
  }

  if (candidate.level === 'debug' || candidate.eventType === 'tap-progress') {
    return 'low';
  }

  return 'normal';
}

export class PersistentStorage {
  readonly #database: DatabaseSync;
  readonly #diagnosticsPath: string;
  readonly #diagnosticsCapacity: number;
  readonly #diagnosticWrites: DiagnosticWriteQueue<unknown>;
  #diagnosticEntryCount: number | null = null;
  #closed = false;

  constructor(
    databasePath: string,
    diagnosticsPath: string,
    diagnosticsCapacity = 5_000,
  ) {
    if (!Number.isInteger(diagnosticsCapacity) || diagnosticsCapacity < 1) {
      throw new RangeError('Diagnostics capacity must be a positive integer.');
    }

    this.#database = new DatabaseSync(databasePath);
    this.#diagnosticsPath = diagnosticsPath;
    this.#diagnosticsCapacity = diagnosticsCapacity;
    this.#diagnosticWrites = new DiagnosticWriteQueue(
      DEFAULT_DIAGNOSTIC_WRITE_CAPACITY,
      (diagnostic) => this.#appendDiagnostic(diagnostic),
    );
    this.#database.exec('PRAGMA journal_mode = WAL;');
    this.#database.exec('PRAGMA synchronous = FULL;');
    const version = (
      this.#database.prepare('PRAGMA user_version').get() as unknown as DatabaseVersionRow
    ).user_version;

    if (version > CURRENT_DATABASE_SCHEMA_VERSION) {
      this.#database.close();
      throw new Error(`Unsupported Core Miner database version ${version}.`);
    }

    if (version === 0) {
      try {
        this.#database.exec(`
          BEGIN;
          CREATE TABLE wallets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            wallet_address TEXT,
            connection_status TEXT NOT NULL DEFAULT 'disconnected',
            connection_reference TEXT,
            mining_credential_reference TEXT,
            mama_board_level INTEGER
          );
          CREATE TABLE settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            payload TEXT NOT NULL
          );
          CREATE TABLE rewards (
            id TEXT PRIMARY KEY,
            wallet_id TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX rewards_wallet_history
            ON rewards (wallet_id, recorded_at, id);
          CREATE TABLE secure_values (
            reference TEXT PRIMARY KEY,
            encrypted_payload TEXT NOT NULL
          );
          CREATE TABLE balance_snapshots (
            id TEXT PRIMARY KEY,
            wallet_id TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX balance_snapshots_wallet_history
            ON balance_snapshots (wallet_id, recorded_at, id);
          CREATE TABLE session_results (
            id TEXT PRIMARY KEY,
            wallet_id TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX session_results_wallet_history
            ON session_results (wallet_id, recorded_at, id);
          CREATE TABLE global_mining_uptime_intervals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            last_active_at INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX global_mining_uptime_single_open
            ON global_mining_uptime_intervals ((1)) WHERE ended_at IS NULL;
          PRAGMA user_version = ${CURRENT_DATABASE_SCHEMA_VERSION};
          COMMIT;
        `);
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK;');
        } catch {
          // The migration may have failed before the transaction began.
        }
        this.#database.close();
        throw error;
      }
    }

    if (version === 1) {
      try {
        this.#database.exec(`
          BEGIN;
          ALTER TABLE wallets ADD COLUMN wallet_address TEXT;
          ALTER TABLE wallets ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'disconnected';
          ALTER TABLE wallets ADD COLUMN connection_reference TEXT;
          ALTER TABLE wallets ADD COLUMN mining_credential_reference TEXT;
          ALTER TABLE wallets ADD COLUMN mama_board_level INTEGER;
          CREATE TABLE secure_values (
            reference TEXT PRIMARY KEY,
            encrypted_payload TEXT NOT NULL
          );
          CREATE TABLE balance_snapshots (
            id TEXT PRIMARY KEY,
            wallet_id TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX balance_snapshots_wallet_history
            ON balance_snapshots (wallet_id, recorded_at, id);
          CREATE TABLE session_results (
            id TEXT PRIMARY KEY,
            wallet_id TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX session_results_wallet_history
            ON session_results (wallet_id, recorded_at, id);
          CREATE TABLE global_mining_uptime_intervals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            last_active_at INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX global_mining_uptime_single_open
            ON global_mining_uptime_intervals ((1)) WHERE ended_at IS NULL;
          PRAGMA user_version = ${CURRENT_DATABASE_SCHEMA_VERSION};
          COMMIT;
        `);
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK;');
        } catch {
          // The migration may have failed before the transaction began.
        }
        this.#database.close();
        throw error;
      }
    }

    if (version === 2) {
      try {
        this.#database.exec(`
          BEGIN;
          ALTER TABLE wallets ADD COLUMN mama_board_level INTEGER;
          CREATE TABLE balance_snapshots (
            id TEXT PRIMARY KEY,
            wallet_id TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX balance_snapshots_wallet_history
            ON balance_snapshots (wallet_id, recorded_at, id);
          CREATE TABLE session_results (
            id TEXT PRIMARY KEY,
            wallet_id TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX session_results_wallet_history
            ON session_results (wallet_id, recorded_at, id);
          CREATE TABLE global_mining_uptime_intervals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            last_active_at INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX global_mining_uptime_single_open
            ON global_mining_uptime_intervals ((1)) WHERE ended_at IS NULL;
          PRAGMA user_version = ${CURRENT_DATABASE_SCHEMA_VERSION};
          COMMIT;
        `);
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK;');
        } catch {
          // The migration may have failed before the transaction began.
        }
        this.#database.close();
        throw error;
      }
    }

    if (version === 3) {
      try {
        this.#database.exec(`
          BEGIN;
          CREATE TABLE balance_snapshots (
            id TEXT PRIMARY KEY,
            wallet_id TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX balance_snapshots_wallet_history
            ON balance_snapshots (wallet_id, recorded_at, id);
          CREATE TABLE session_results (
            id TEXT PRIMARY KEY,
            wallet_id TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX session_results_wallet_history
            ON session_results (wallet_id, recorded_at, id);
          CREATE TABLE global_mining_uptime_intervals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            last_active_at INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX global_mining_uptime_single_open
            ON global_mining_uptime_intervals ((1)) WHERE ended_at IS NULL;
          PRAGMA user_version = ${CURRENT_DATABASE_SCHEMA_VERSION};
          COMMIT;
        `);
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK;');
        } catch {
          // The migration may have failed before the transaction began.
        }
        this.#database.close();
        throw error;
      }
    }

    if (version === 4) {
      try {
        this.#database.exec(`
          BEGIN;
          CREATE TABLE global_mining_uptime_intervals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            last_active_at INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX global_mining_uptime_single_open
            ON global_mining_uptime_intervals ((1)) WHERE ended_at IS NULL;
          PRAGMA user_version = ${CURRENT_DATABASE_SCHEMA_VERSION};
          COMMIT;
        `);
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK;');
        } catch {
          // The migration may have failed before the transaction began.
        }
        this.#database.close();
        throw error;
      }
    }

    // An interval left open before this process started came from an abnormal
    // shutdown. Close it at its last persisted activity marker, never at now.
    this.#database.exec(`
      UPDATE global_mining_uptime_intervals
      SET ended_at = MAX(started_at, last_active_at)
      WHERE ended_at IS NULL;
    `);
  }

  listWallets(): readonly StoredWalletDefinition[] {
    const rows = this.#database
      .prepare(`
        SELECT id, name, status, wallet_address, connection_status,
          connection_reference, mining_credential_reference, mama_board_level
        FROM wallets ORDER BY id
      `)
      .all() as unknown as readonly WalletRow[];

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          id: row.id,
          name: row.name,
          status: row.status,
          walletAddress: row.wallet_address,
          onboardingStatus:
            row.connection_status === 'awaiting-approval'
              ? 'awaiting-connection'
              : row.connection_status,
          connectionReference: row.connection_reference,
          miningCredentialReference: row.mining_credential_reference,
          mamaBoardLevel: row.mama_board_level,
        }),
      ),
    );
  }

  saveWallet(wallet: unknown): void {
    const validated = this.#wallet(wallet);
    this.#database
      .prepare(`
        INSERT INTO wallets (
          id, name, status, wallet_address, connection_status,
          connection_reference, mining_credential_reference, mama_board_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          status = excluded.status,
          wallet_address = excluded.wallet_address,
          connection_status = excluded.connection_status,
          connection_reference = excluded.connection_reference,
          mining_credential_reference = excluded.mining_credential_reference,
          mama_board_level = excluded.mama_board_level
      `)
      .run(
        validated.id,
        validated.name,
        validated.status ?? 'idle',
        validated.walletAddress ?? null,
        validated.onboardingStatus ?? 'disconnected',
        validated.connectionReference ?? null,
        validated.miningCredentialReference ?? null,
        validated.mamaBoardLevel ?? null,
      );
  }

  removeWallet(walletId: unknown): void {
    const validatedId = this.#requiredString(walletId, 'Wallet ID');
    const row = this.#database
      .prepare(`
        SELECT connection_reference, mining_credential_reference
        FROM wallets WHERE id = ?
      `)
      .get(validatedId) as
      | Pick<WalletRow, 'connection_reference' | 'mining_credential_reference'>
      | undefined;

    this.#database.exec('BEGIN;');

    try {
      this.#database
        .prepare('DELETE FROM rewards WHERE wallet_id = ?')
        .run(validatedId);
      this.#database
        .prepare('DELETE FROM balance_snapshots WHERE wallet_id = ?')
        .run(validatedId);
      this.#database
        .prepare('DELETE FROM session_results WHERE wallet_id = ?')
        .run(validatedId);

      for (const reference of [
        row?.connection_reference,
        row?.mining_credential_reference,
      ]) {
        if (reference) {
          this.#database
            .prepare('DELETE FROM secure_values WHERE reference = ?')
            .run(reference);
        }
      }

      this.#database.prepare('DELETE FROM wallets WHERE id = ?').run(validatedId);

      this.#database.exec('COMMIT;');
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  saveSecureValue(reference: unknown, encryptedPayload: unknown): void {
    const validatedReference = this.#requiredString(reference, 'Secure reference');
    const validatedPayload = this.#requiredString(
      encryptedPayload,
      'Encrypted secure payload',
    );
    this.#database
      .prepare(`
        INSERT INTO secure_values (reference, encrypted_payload) VALUES (?, ?)
        ON CONFLICT(reference) DO UPDATE SET
          encrypted_payload = excluded.encrypted_payload
      `)
      .run(validatedReference, validatedPayload);
  }

  loadSecureValue(reference: unknown): string | null {
    const validatedReference = this.#requiredString(reference, 'Secure reference');
    const row = this.#database
      .prepare('SELECT encrypted_payload AS payload FROM secure_values WHERE reference = ?')
      .get(validatedReference) as JsonRow | undefined;

    return row?.payload ?? null;
  }

  hasSecureValue(reference: unknown): boolean {
    const validatedReference = this.#requiredString(reference, 'Secure reference');
    const row = this.#database
      .prepare('SELECT 1 AS present FROM secure_values WHERE reference = ?')
      .get(validatedReference) as { readonly present: number } | undefined;

    return row?.present === 1;
  }

  removeSecureValue(reference: unknown): void {
    const validatedReference = this.#requiredString(reference, 'Secure reference');
    this.#database
      .prepare('DELETE FROM secure_values WHERE reference = ?')
      .run(validatedReference);
  }

  loadMainEpochStartSchedule(): Readonly<StoredMainEpochStartSchedule> | null {
    const candidate = this.#settingsPayload().mainEpochStart;
    return this.#mainEpochStartSchedule(candidate, false);
  }

  saveMainEpochStartSchedule(snapshot: unknown): void {
    const payload = this.#settingsPayload();
    if (snapshot === null) {
      delete payload.mainEpochStart;
    } else {
      payload.mainEpochStart = this.#mainEpochStartSchedule(snapshot, true);
    }
    this.#database.prepare(`
      INSERT INTO settings (id, payload) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `).run(JSON.stringify(payload));
  }

  globalMiningUptimeSnapshot(at: unknown): Readonly<{
    completedTodayMs: number;
    activeStartedAt: number | null;
    history: readonly Readonly<{
      date: string;
      durationMs: number;
    }>[];
  }> {
    const timestamp = this.#timestamp(at, 'Uptime snapshot timestamp');
    const dayStart = localDayStart(timestamp);
    const dayEnd = nextLocalDayStart(dayStart);
    const totalForRange = this.#database.prepare(`
        SELECT COALESCE(SUM(
          MIN(ended_at, ?) - MAX(started_at, ?)
        ), 0) AS total_ms
        FROM global_mining_uptime_intervals
        WHERE ended_at IS NOT NULL
          AND started_at < ?
          AND ended_at > ?
      `);
    const total = totalForRange
      .get(dayEnd, dayStart, dayEnd, dayStart) as unknown as UptimeTotalRow;
    const active = this.#database
      .prepare(`
        SELECT started_at
        FROM global_mining_uptime_intervals
        WHERE ended_at IS NULL
        ORDER BY id DESC
        LIMIT 1
      `)
      .get() as UptimeOpenRow | undefined;
    const history: Readonly<{
      date: string;
      durationMs: number;
    }>[] = [];
    let historyEnd = dayStart;
    for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
      const historyStart = previousLocalDayStart(historyEnd);
      const historyTotal = totalForRange
        .get(
          historyEnd,
          historyStart,
          historyEnd,
          historyStart,
        ) as unknown as UptimeTotalRow;
      history.push(Object.freeze({
        date: localDateKey(historyStart),
        durationMs: Math.max(0, historyTotal.total_ms),
      }));
      historyEnd = historyStart;
    }

    return Object.freeze({
      completedTodayMs: Math.max(0, total.total_ms),
      activeStartedAt: active?.started_at ?? null,
      history: Object.freeze(history),
    });
  }

  startGlobalMiningUptime(startedAt: unknown): void {
    const timestamp = this.#timestamp(startedAt, 'Uptime start timestamp');
    this.#database
      .prepare(`
        INSERT INTO global_mining_uptime_intervals (
          started_at, ended_at, last_active_at
        )
        SELECT ?, NULL, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM global_mining_uptime_intervals WHERE ended_at IS NULL
        )
      `)
      .run(timestamp, timestamp);
  }

  heartbeatGlobalMiningUptime(activeAt: unknown): void {
    const timestamp = this.#timestamp(activeAt, 'Uptime heartbeat timestamp');
    this.#database
      .prepare(`
        UPDATE global_mining_uptime_intervals
        SET last_active_at = MAX(last_active_at, ?)
        WHERE ended_at IS NULL
      `)
      .run(timestamp);
  }

  stopGlobalMiningUptime(endedAt: unknown): void {
    const timestamp = this.#timestamp(endedAt, 'Uptime stop timestamp');
    this.#database
      .prepare(`
        UPDATE global_mining_uptime_intervals
        SET ended_at = MAX(started_at, ?),
            last_active_at = MAX(last_active_at, ?)
        WHERE ended_at IS NULL
      `)
      .run(timestamp, timestamp);
  }

  appendReward(reward: unknown): void {
    const validated = this.#reward(reward);
    this.#database
      .prepare(`
        INSERT OR IGNORE INTO rewards (id, wallet_id, recorded_at, payload)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM wallets WHERE id = ?)
      `)
      .run(
        validated.id,
        validated.walletId,
        validated.recordedAt,
        JSON.stringify(validated),
        validated.walletId,
      );
  }

  rewardsForWallet(
    walletId: unknown,
    limit?: unknown,
  ): readonly StoredRewardRecord[] {
    const validatedId = this.#requiredString(walletId, 'Wallet ID');
    const validatedLimit = this.#historyLimit(limit);
    const rows = validatedLimit === null
      ? (this.#database
          .prepare(`
            SELECT payload FROM rewards
            WHERE wallet_id = ?
            ORDER BY recorded_at, id
          `)
          .all(validatedId) as unknown as readonly JsonRow[])
      : ([...(this.#database
          .prepare(`
            SELECT payload FROM rewards
            WHERE wallet_id = ?
            ORDER BY recorded_at DESC, id DESC
            LIMIT ?
          `)
          .all(validatedId, validatedLimit) as unknown as readonly JsonRow[])]
          .reverse());

    return Object.freeze(
      rows.map((row) => Object.freeze(this.#reward(JSON.parse(row.payload)))),
    );
  }

  appendWalletBalanceSnapshot(snapshot: unknown): void {
    const validated = this.#balanceSnapshot(snapshot);
    const recordedAt = new Date(validated.synchronizedAt).getTime();
    const id = `${validated.walletId}:${validated.synchronizedAt}`;
    this.#database
      .prepare(`
        INSERT OR IGNORE INTO balance_snapshots (
          id, wallet_id, recorded_at, payload
        ) SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM wallets WHERE id = ?)
      `)
      .run(
        id,
        validated.walletId,
        recordedAt,
        JSON.stringify(validated),
        validated.walletId,
      );
  }

  walletBalanceSnapshots(
    walletId: unknown,
    limit?: unknown,
  ): readonly StoredWalletBalanceSnapshot[] {
    const validatedId = this.#requiredString(walletId, 'Wallet ID');
    const validatedLimit = this.#historyLimit(limit);
    const rows = validatedLimit === null
      ? (this.#database
          .prepare(`
            SELECT payload FROM balance_snapshots
            WHERE wallet_id = ?
            ORDER BY recorded_at, id
          `)
          .all(validatedId) as unknown as readonly JsonRow[])
      : ([...(this.#database
          .prepare(`
            SELECT payload FROM balance_snapshots
            WHERE wallet_id = ?
            ORDER BY recorded_at DESC, id DESC
            LIMIT ?
          `)
          .all(validatedId, validatedLimit) as unknown as readonly JsonRow[])]
          .reverse());

    return Object.freeze(
      rows.map((row) => this.#balanceSnapshot(JSON.parse(row.payload))),
    );
  }

  saveWalletSessionResult(result: unknown): void {
    const validated = this.#sessionResult(result);
    const id = `${validated.walletId}:${validated.sessionId}:${validated.generation}`;
    const recordedAt = new Date(
      validated.completedAt ?? validated.startedAt,
    ).getTime();
    this.#database
      .prepare(`
        INSERT INTO session_results (id, wallet_id, recorded_at, payload)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM wallets WHERE id = ?)
        ON CONFLICT(id) DO UPDATE SET
          recorded_at = excluded.recorded_at,
          payload = excluded.payload
      `)
      .run(
        id,
        validated.walletId,
        recordedAt,
        JSON.stringify(validated),
        validated.walletId,
      );
  }

  walletSessionResults(
    walletId: unknown,
    limit?: unknown,
  ): readonly StoredWalletSessionResult[] {
    const validatedId = this.#requiredString(walletId, 'Wallet ID');
    const validatedLimit = this.#historyLimit(limit);
    const rows = validatedLimit === null
      ? (this.#database
          .prepare(`
            SELECT payload FROM session_results
            WHERE wallet_id = ?
            ORDER BY recorded_at, id
          `)
          .all(validatedId) as unknown as readonly JsonRow[])
      : ([...(this.#database
          .prepare(`
            SELECT payload FROM session_results
            WHERE wallet_id = ?
            ORDER BY recorded_at DESC, id DESC
            LIMIT ?
          `)
          .all(validatedId, validatedLimit) as unknown as readonly JsonRow[])]
          .reverse());

    return Object.freeze(
      rows.map((row) => this.#sessionResult(JSON.parse(row.payload))),
    );
  }

  appendDiagnostic(diagnostic: unknown): Promise<void> {
    return this.#diagnosticWrites.enqueue(
      diagnostic,
      diagnosticWritePriority(diagnostic),
    );
  }

  diagnosticQueueMetrics(): DiagnosticWriteQueueMetrics {
    return this.#diagnosticWrites.snapshot();
  }

  async recentDiagnostics(limit: unknown): Promise<readonly unknown[]> {
    if (!Number.isInteger(limit) || (limit as number) < 1) {
      throw new RangeError('Diagnostic history limit must be a positive integer.');
    }

    await this.#diagnosticWrites.settled();
    const lines = await this.#readDiagnosticLines();
    return Object.freeze(
      lines
        .slice(-(limit as number))
        .reverse()
        .map((line) => Object.freeze(JSON.parse(line) as object)),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    await this.#diagnosticWrites.settled();
    this.stopGlobalMiningUptime(Date.now());
    this.#database.close();
    this.#closed = true;
  }

  async #appendDiagnostic(diagnostic: unknown): Promise<void> {
    const serialized = JSON.stringify(diagnostic);

    if (serialized === undefined) {
      throw new TypeError('Diagnostic entry must be JSON serializable.');
    }

    await mkdir(dirname(this.#diagnosticsPath), { recursive: true });

    if (this.#diagnosticEntryCount === null) {
      this.#diagnosticEntryCount = (await this.#readDiagnosticLines()).length;
    }

    await appendFile(this.#diagnosticsPath, `${serialized}\n`, 'utf8');
    this.#diagnosticEntryCount += 1;

    if (this.#diagnosticEntryCount > this.#diagnosticsCapacity) {
      const lines = await this.#readDiagnosticLines();
      const retainedLines = lines.slice(
        -Math.max(1, Math.ceil(this.#diagnosticsCapacity / 2)),
      );
      await writeFile(
        this.#diagnosticsPath,
        `${retainedLines.join('\n')}\n`,
        'utf8',
      );
      this.#diagnosticEntryCount = retainedLines.length;
    }
  }

  async #readDiagnosticLines(): Promise<string[]> {
    try {
      return (await readFile(this.#diagnosticsPath, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .filter((line) => {
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  #wallet(value: unknown): StoredWalletDefinition {
    if (!this.#isRecord(value)) {
      throw new TypeError('Wallet configuration must be an object.');
    }

    const status = value.status ?? 'idle';
    const onboardingStatus = value.onboardingStatus ?? 'disconnected';
    const mamaBoardLevel = value.mamaBoardLevel ?? null;

    if (typeof status !== 'string' || !WALLET_STATUSES.has(status as WalletStatus)) {
      throw new TypeError('Wallet status is invalid.');
    }

    if (
      typeof onboardingStatus !== 'string' ||
      !WALLET_ONBOARDING_STATUSES.has(
        onboardingStatus as WalletOnboardingStatus,
      )
    ) {
      throw new TypeError('Wallet connection status is invalid.');
    }

    if (
      mamaBoardLevel !== null &&
      (!Number.isInteger(mamaBoardLevel) ||
        (mamaBoardLevel as number) < 0 ||
        (mamaBoardLevel as number) > 72)
    ) {
      throw new TypeError('MamaBoard level must be an integer from 0 to 72.');
    }

    const optionalString = (field: unknown, label: string): string | null => {
      if (field === undefined || field === null) {
        return null;
      }

      return this.#requiredString(field, label);
    };

    return Object.freeze({
      id: this.#requiredString(value.id, 'Wallet ID'),
      name: this.#requiredString(value.name, 'Wallet name'),
      status: status as WalletStatus,
      walletAddress: optionalString(value.walletAddress, 'Wallet address'),
      onboardingStatus: onboardingStatus as WalletOnboardingStatus,
      connectionReference: optionalString(
        value.connectionReference,
        'Wallet connection reference',
      ),
      miningCredentialReference: optionalString(
        value.miningCredentialReference,
        'Wallet mining credential reference',
      ),
      mamaBoardLevel: mamaBoardLevel as number | null,
    });
  }

  #reward(value: unknown): StoredRewardRecord {
    if (!this.#isRecord(value) || !this.#isRecord(value.amount)) {
      throw new TypeError('Reward record must be an object.');
    }

    const recordedAt = value.recordedAt;
    const generation = value.generation;
    const sessionId = value.sessionId;

    if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) {
      throw new TypeError('Reward timestamp is invalid.');
    }

    if (
      generation !== null &&
      (typeof generation !== 'number' ||
        !Number.isInteger(generation) ||
        generation < 1)
    ) {
      throw new TypeError('Reward generation is invalid.');
    }

    if (sessionId !== null && typeof sessionId !== 'string') {
      throw new TypeError('Reward session ID is invalid.');
    }

    const kind = value.kind;
    const before = value.lockedNacklBeforeRaw;
    const after = value.lockedNacklAfterRaw;
    const detectionSource = value.detectionSource;

    if (
      kind !== undefined &&
      kind !== 'confirmed-reward' &&
      kind !== 'locked-nackl-delta'
    ) {
      throw new TypeError('Reward kind is invalid.');
    }
    if (
      (before !== undefined && before !== null && !/^\d+$/.test(String(before))) ||
      (after !== undefined && after !== null && !/^\d+$/.test(String(after)))
    ) {
      throw new TypeError('Reward balance evidence is invalid.');
    }
    if (
      detectionSource !== undefined &&
      (typeof detectionSource !== 'string' ||
        !REWARD_DETECTION_SOURCES.has(
          detectionSource as NonNullable<StoredRewardRecord['detectionSource']>,
        ))
    ) {
      throw new TypeError('Reward detection source is invalid.');
    }
    if (
      kind === 'locked-nackl-delta' &&
      (before == null ||
        after == null ||
        detectionSource === undefined ||
        !/^\d+$/.test(String(value.amount.value)))
    ) {
      throw new TypeError('Locked NACKL reward evidence is incomplete.');
    }

    return Object.freeze({
      id: this.#requiredString(value.id, 'Reward ID'),
      walletId: this.#requiredString(value.walletId, 'Reward wallet ID'),
      amount: Object.freeze({
        value: this.#requiredString(value.amount.value, 'Reward amount'),
        unit: this.#requiredString(value.amount.unit, 'Reward unit'),
      }),
      recordedAt,
      sessionId,
      generation: generation as number | null,
      ...(kind ? { kind } : {}),
      ...(before !== undefined
        ? { lockedNacklBeforeRaw: before as string | null }
        : {}),
      ...(after !== undefined
        ? { lockedNacklAfterRaw: after as string | null }
        : {}),
      ...(detectionSource !== undefined
        ? {
            detectionSource:
              detectionSource as NonNullable<StoredRewardRecord['detectionSource']>,
          }
        : {}),
    });
  }

  #balanceSnapshot(value: unknown): Readonly<StoredWalletBalanceSnapshot> {
    if (!this.#isRecord(value)) {
      throw new TypeError('Wallet balance snapshot must be an object.');
    }

    const synchronizedAt = this.#isoTimestamp(
      value.synchronizedAt,
      'Balance snapshot timestamp',
    );
    const status = value.status;
    const errorCode = value.errorCode;
    if (status !== 'fresh' && status !== 'partial' && status !== 'error') {
      throw new TypeError('Wallet balance snapshot status is invalid.');
    }
    if (errorCode !== null && typeof errorCode !== 'string') {
      throw new TypeError('Wallet balance snapshot error code is invalid.');
    }

    let values: StoredWalletBalanceSnapshot['values'] = null;
    if (value.values !== null) {
      const inputValues = value.values;
      if (!this.#isRecord(inputValues)) {
        throw new TypeError('Wallet balance values must be an object.');
      }
      const raw = (name: string): string => {
        const field = inputValues[name];
        if (typeof field !== 'string' || !/^\d+$/.test(field)) {
          throw new TypeError(`Wallet balance ${name} is invalid.`);
        }
        return field;
      };
      values = Object.freeze({
        nacklLockedRaw: raw('nacklLockedRaw'),
        nacklAvailableRaw: raw('nacklAvailableRaw'),
        usdcRaw: raw('usdcRaw'),
        shellRaw: raw('shellRaw'),
      });
    }

    return Object.freeze({
      walletId: this.#requiredString(value.walletId, 'Balance wallet ID'),
      values,
      synchronizedAt,
      status,
      errorCode,
    });
  }

  #sessionResult(value: unknown): Readonly<StoredWalletSessionResult> {
    if (!this.#isRecord(value)) {
      throw new TypeError('Wallet session result must be an object.');
    }

    const integer = (field: unknown, label: string, nullable = false) => {
      if (nullable && field === null) {
        return null;
      }
      if (typeof field !== 'number' || !Number.isInteger(field) || field < 0) {
        throw new TypeError(`${label} is invalid.`);
      }
      return field;
    };
    const optionalString = (field: unknown, label: string): string | null =>
      field === null ? null : this.#requiredString(field, label);

    return Object.freeze({
      walletId: this.#requiredString(value.walletId, 'Session wallet ID'),
      sessionId: this.#requiredString(value.sessionId, 'Session ID'),
      generation: (() => {
        const generation = integer(value.generation, 'Session generation') as number;
        if (generation < 1) {
          throw new TypeError('Session generation is invalid.');
        }
        return generation;
      })(),
      miniEpoch: optionalString(value.miniEpoch, 'Session mini epoch'),
      startedAt: this.#isoTimestamp(value.startedAt, 'Session start timestamp'),
      completedAt:
        value.completedAt === null
          ? null
          : this.#isoTimestamp(value.completedAt, 'Session completion timestamp'),
      completedTaps: integer(value.completedTaps, 'Completed tap count') as number,
      targetTaps: integer(value.targetTaps, 'Target tap count') as number,
      verifiedTaps: integer(value.verifiedTaps, 'Verified tap count', true),
      rejectedTaps: integer(value.rejectedTaps, 'Rejected tap count', true),
      settlementOutcome: this.#requiredString(
        value.settlementOutcome,
        'Settlement outcome',
      ),
      stopReason: this.#requiredString(value.stopReason, 'Session stop reason'),
      rewardDeltaRaw: optionalString(value.rewardDeltaRaw, 'Session reward delta'),
      recoveryUsed: Boolean(value.recoveryUsed),
    });
  }

  #requiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`${name} must not be empty.`);
    }

    return value;
  }

  #settingsPayload(): Record<string, unknown> {
    const row = this.#database
      .prepare('SELECT payload FROM settings WHERE id = 1')
      .get() as JsonRow | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      return this.#isRecord(parsed) ? { ...parsed } : {};
    } catch {
      return {};
    }
  }

  #mainEpochStartSchedule(
    value: unknown,
    strict: boolean,
  ): Readonly<StoredMainEpochStartSchedule> | null {
    const invalid = () => {
      if (strict) {
        throw new TypeError('Main Epoch start schedule is invalid.');
      }
      return null;
    };
    if (!this.#isRecord(value)) return invalid();
    const status = value.status;
    const armedAt = value.armedAt;
    const baselineMainEpoch = value.baselineMainEpoch;
    const delayHours = value.delayHours;
    const detectedMainEpoch = value.detectedMainEpoch;
    const epochDetectedAt = value.epochDetectedAt;
    const targetStartAt = value.targetStartAt;
    if (
      (status !== 'waiting-for-main-epoch' && status !== 'waiting-for-delay') ||
      !Number.isSafeInteger(armedAt) || (armedAt as number) < 0 ||
      typeof baselineMainEpoch !== 'string' || baselineMainEpoch.length === 0 ||
      !Number.isInteger(delayHours) || (delayHours as number) < 1 ||
      (delayHours as number) > 24 ||
      (detectedMainEpoch !== null && typeof detectedMainEpoch !== 'string') ||
      (epochDetectedAt !== null &&
        (!Number.isSafeInteger(epochDetectedAt) || (epochDetectedAt as number) < 0)) ||
      (targetStartAt !== null &&
        (!Number.isSafeInteger(targetStartAt) || (targetStartAt as number) < 0)) ||
      (status === 'waiting-for-main-epoch' &&
        (detectedMainEpoch !== null || epochDetectedAt !== null || targetStartAt !== null)) ||
      (status === 'waiting-for-delay' &&
        (typeof detectedMainEpoch !== 'string' ||
          epochDetectedAt === null || targetStartAt === null))
    ) {
      return invalid();
    }
    return Object.freeze({
      status,
      armedAt: armedAt as number,
      baselineMainEpoch,
      delayHours: delayHours as number,
      detectedMainEpoch,
      epochDetectedAt: epochDetectedAt as number | null,
      targetStartAt: targetStartAt as number | null,
    });
  }

  #historyLimit(value: unknown): number | null {
    if (value === undefined) {
      return null;
    }

    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new RangeError('History limit must be a positive integer.');
    }

    return value as number;
  }

  #isoTimestamp(value: unknown, name: string): string {
    const timestamp = this.#requiredString(value, name);
    if (Number.isNaN(new Date(timestamp).getTime())) {
      throw new TypeError(`${name} is invalid.`);
    }
    return timestamp;
  }

  #timestamp(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new TypeError(`${name} is invalid.`);
    }
    return value as number;
  }

  #isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

function localDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function nextLocalDayStart(dayStart: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

function previousLocalDayStart(dayStart: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() - 1);
  return date.getTime();
}

function localDateKey(dayStart: number): string {
  const date = new Date(dayStart);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
