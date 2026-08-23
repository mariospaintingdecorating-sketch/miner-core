import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_DATABASE_SCHEMA_VERSION,
  DiagnosticWriteQueue,
  PersistentStorage,
  type StoredRewardRecord,
} from '../../electron/PersistentStorage';

const temporaryDirectories: string[] = [];
const openStorage: PersistentStorage[] = [];

async function createStorage(capacity = 5_000): Promise<{
  directory: string;
  databasePath: string;
  diagnosticsPath: string;
  storage: PersistentStorage;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'miner-core-storage-'));
  const databasePath = join(directory, 'miner-core.sqlite');
  const diagnosticsPath = join(directory, 'diagnostics', 'runtime.jsonl');
  const storage = new PersistentStorage(
    databasePath,
    diagnosticsPath,
    capacity,
  );
  temporaryDirectories.push(directory);
  openStorage.push(storage);
  return { directory, databasePath, diagnosticsPath, storage };
}

afterEach(async () => {
  for (const storage of openStorage.splice(0)) {
    try {
      await storage.close();
    } catch {
      // A test may close a storage instance before reopening it.
    }
  }

  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('PersistentStorage', () => {
  it('exposes the current data schema version for release migrations', () => {
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(5);
  });

  it('persists and clears only the armed Main Epoch start schedule', async () => {
    const { databasePath, diagnosticsPath, storage } = await createStorage();
    const schedule = {
      status: 'waiting-for-delay' as const,
      armedAt: 1_786_000_000_000,
      baselineMainEpoch: '78600000',
      delayHours: 2,
      detectedMainEpoch: '78862000',
      epochDetectedAt: 1_786_000_330_000,
      targetStartAt: 1_786_007_530_000,
    };

    storage.saveMainEpochStartSchedule(schedule);
    expect(storage.loadMainEpochStartSchedule()).toEqual(schedule);
    await storage.close();
    openStorage.splice(openStorage.indexOf(storage), 1);

    const reopened = new PersistentStorage(databasePath, diagnosticsPath);
    openStorage.push(reopened);
    expect(reopened.loadMainEpochStartSchedule()).toEqual(schedule);
    reopened.saveMainEpochStartSchedule(null);
    expect(reopened.loadMainEpochStartSchedule()).toBeNull();
  });

  it('rejects inconsistent Main Epoch start schedules', async () => {
    const { storage } = await createStorage();
    expect(() => storage.saveMainEpochStartSchedule({
      status: 'waiting-for-delay',
      armedAt: 1,
      baselineMainEpoch: '262000',
      delayHours: 1,
      detectedMainEpoch: null,
      epochDetectedAt: null,
      targetStartAt: null,
    })).toThrow('Main Epoch start schedule is invalid.');
  });

  it('preserves the compatibility settings table while persisting wallet configuration and isolated reward history', async () => {
    const { databasePath, diagnosticsPath, storage } = await createStorage();
    const reward: StoredRewardRecord = {
      id: 'reward-a',
      walletId: 'wallet-a',
      amount: { value: '12', unit: 'ACKI' },
      recordedAt: 1_786_000_000_000,
      sessionId: 'session-a',
      generation: 2,
    };
    storage.saveWallet({
      id: 'wallet-a',
      name: 'Alpha',
      status: 'idle',
      mamaBoardLevel: 25,
    });
    storage.saveWallet({ id: 'wallet-b', name: 'Beta', status: 'offline' });
    storage.appendReward(reward);
    await storage.close();
    openStorage.splice(openStorage.indexOf(storage), 1);

    const reopened = new PersistentStorage(databasePath, diagnosticsPath);
    openStorage.push(reopened);

    const compatibilityDatabase = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      expect(
        compatibilityDatabase
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
          .get(),
      ).toMatchObject({ name: 'settings' });
    } finally {
      compatibilityDatabase.close();
    }
    expect(reopened.listWallets()).toEqual([
      {
        id: 'wallet-a',
        name: 'Alpha',
        status: 'idle',
        walletAddress: null,
        onboardingStatus: 'disconnected',
        connectionReference: null,
        miningCredentialReference: null,
        mamaBoardLevel: 25,
      },
      {
        id: 'wallet-b',
        name: 'Beta',
        status: 'offline',
        walletAddress: null,
        onboardingStatus: 'disconnected',
        connectionReference: null,
        miningCredentialReference: null,
        mamaBoardLevel: null,
      },
    ]);
    expect(reopened.rewardsForWallet('wallet-a')).toEqual([reward]);
    expect(reopened.rewardsForWallet('wallet-b')).toEqual([]);
    expect('startMining' in reopened).toBe(false);
  });

  it('bounds diagnostics history while preserving generation data', async () => {
    const { storage } = await createStorage(2);

    for (let generation = 1; generation <= 3; generation += 1) {
      await storage.appendDiagnostic({
        id: `diagnostic-${generation}`,
        generation,
      });
    }

    expect(await storage.recentDiagnostics(10)).toEqual([
      { id: 'diagnostic-3', generation: 3 },
    ]);
  });

  it('bounds pending diagnostic writes, retains terminal errors and isolates writer failures', async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const written: string[] = [];
    const queue = new DiagnosticWriteQueue<Readonly<{ id: string }>>(
      5,
      async ({ id }) => {
        if (id === 'first') {
          await firstWrite;
        }
        if (id === 'write-failure') {
          throw new Error('disk unavailable');
        }
        written.push(id);
      },
    );
    const operations = [
      queue.enqueue({ id: 'first' }, 'normal'),
      ...Array.from({ length: 20 }, (_, index) =>
        queue.enqueue({ id: `progress-${index}` }, 'low')),
      queue.enqueue({ id: 'terminal-error' }, 'high'),
      queue.enqueue({ id: 'write-failure' }, 'high'),
    ];

    expect(queue.snapshot().pending).toBeLessThanOrEqual(5);
    expect(queue.snapshot().dropped).toBeGreaterThan(0);
    expect(queue.settled()).toBe(queue.settled());

    const outcomes = Promise.allSettled(operations);
    releaseFirstWrite?.();
    await outcomes;
    await queue.settled();

    expect(written).toContain('terminal-error');
    expect(queue.snapshot()).toMatchObject({
      capacity: 5,
      pending: 0,
      writeFailures: 1,
    });
  });

  it('removes only the selected wallet and all of its wallet-scoped history', async () => {
    const { storage } = await createStorage();
    const reward: StoredRewardRecord = {
      id: 'reward-a',
      walletId: 'wallet-a',
      amount: { value: '3', unit: 'ACKI' },
      recordedAt: 1_786_000_000_000,
      sessionId: null,
      generation: null,
    };
    const otherReward: StoredRewardRecord = {
      ...reward,
      id: 'reward-b',
      walletId: 'wallet-b',
    };
    storage.saveWallet({ id: 'wallet-a', name: 'Alpha' });
    storage.saveWallet({ id: 'wallet-b', name: 'Beta' });
    storage.appendReward(reward);
    storage.appendReward(otherReward);
    storage.appendWalletBalanceSnapshot({
      walletId: 'wallet-a',
      values: null,
      synchronizedAt: '2026-08-08T10:00:00.000Z',
      status: 'error',
      errorCode: 'unavailable',
    });
    storage.saveWalletSessionResult({
      walletId: 'wallet-a',
      sessionId: 'session-a',
      generation: 1,
      miniEpoch: null,
      startedAt: '2026-08-08T09:50:00.000Z',
      completedAt: '2026-08-08T10:00:00.000Z',
      completedTaps: 40,
      targetTaps: 70,
      verifiedTaps: 40,
      rejectedTaps: 0,
      settlementOutcome: 'accepted',
      stopReason: 'operator-stop',
      rewardDeltaRaw: null,
      recoveryUsed: false,
    });

    storage.removeWallet('wallet-a');

    expect(storage.listWallets()).toEqual([
      expect.objectContaining({ id: 'wallet-b' }),
    ]);
    expect(storage.rewardsForWallet('wallet-a')).toEqual([]);
    expect(storage.walletBalanceSnapshots('wallet-a')).toEqual([]);
    expect(storage.walletSessionResults('wallet-a')).toEqual([]);
    expect(storage.rewardsForWallet('wallet-b')).toEqual([otherReward]);
    storage.appendReward(reward);
    expect(storage.rewardsForWallet('wallet-a')).toEqual([]);
  });

  it('rolls back every wallet deletion when one transactional step fails', async () => {
    const { databasePath, storage } = await createStorage();
    const reward: StoredRewardRecord = {
      id: 'reward-a',
      walletId: 'wallet-a',
      amount: { value: '3', unit: 'NACKL' },
      recordedAt: Date.parse('2026-08-08T10:00:00.000Z'),
      sessionId: null,
      generation: null,
    };
    storage.saveWallet({
      id: 'wallet-a',
      name: 'Alpha',
      connectionReference: 'connection-a',
      miningCredentialReference: 'credential-a',
    });
    storage.saveSecureValue('connection-a', 'encrypted-connection');
    storage.saveSecureValue('credential-a', 'encrypted-credential');
    storage.appendReward(reward);
    storage.saveWalletSessionResult({
      walletId: 'wallet-a',
      sessionId: 'session-a',
      generation: 1,
      miniEpoch: null,
      startedAt: '2026-08-08T09:50:00.000Z',
      completedAt: '2026-08-08T10:00:00.000Z',
      completedTaps: 70,
      targetTaps: 70,
      verifiedTaps: 70,
      rejectedTaps: 0,
      settlementOutcome: 'accepted',
      stopReason: 'settlement-completed',
      rewardDeltaRaw: '3',
      recoveryUsed: false,
    });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER reject_wallet_session_deletion
      BEFORE DELETE ON session_results
      WHEN OLD.wallet_id = 'wallet-a'
      BEGIN
        SELECT RAISE(ABORT, 'forced deletion failure');
      END;
    `);
    database.close();

    expect(() => storage.removeWallet('wallet-a')).toThrow(
      'forced deletion failure',
    );
    expect(storage.listWallets()).toEqual([
      expect.objectContaining({ id: 'wallet-a' }),
    ]);
    expect(storage.rewardsForWallet('wallet-a')).toEqual([reward]);
    expect(storage.walletSessionResults('wallet-a')).toHaveLength(1);
    expect(storage.hasSecureValue('connection-a')).toBe(true);
    expect(storage.hasSecureValue('credential-a')).toBe(true);
  });

  it('persists public Bee references separately from opaque encrypted payloads', async () => {
    const { storage } = await createStorage();
    storage.saveWallet({
      id: 'wallet-a',
      name: 'Alpha',
      walletAddress: '0:wallet-address',
      onboardingStatus: 'ready',
      connectionReference: 'connection-ref',
      miningCredentialReference: 'credential-ref',
    });
    storage.saveSecureValue('connection-ref', 'base64-encrypted-connection');
    storage.saveSecureValue('credential-ref', 'base64-encrypted-payload');

    expect(storage.listWallets()).toEqual([
      {
        id: 'wallet-a',
        name: 'Alpha',
        status: 'idle',
        walletAddress: '0:wallet-address',
        onboardingStatus: 'ready',
        connectionReference: 'connection-ref',
        miningCredentialReference: 'credential-ref',
        mamaBoardLevel: null,
      },
    ]);
    expect(storage.loadSecureValue('credential-ref')).toBe(
      'base64-encrypted-payload',
    );
    expect(storage.hasSecureValue('credential-ref')).toBe(true);

    storage.removeWallet('wallet-a');
    expect(storage.loadSecureValue('connection-ref')).toBeNull();
    expect(storage.loadSecureValue('credential-ref')).toBeNull();
    expect(storage.hasSecureValue('connection-ref')).toBe(false);
    expect(storage.hasSecureValue('credential-ref')).toBe(false);
  });

  it('migrates schema version 1 wallet rows to the current schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'miner-core-storage-'));
    const databasePath = join(directory, 'miner-core.sqlite');
    const diagnosticsPath = join(directory, 'diagnostics.jsonl');
    temporaryDirectories.push(directory);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE wallets (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
      CREATE TABLE rewards (id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX rewards_wallet_history ON rewards (wallet_id, recorded_at, id);
      INSERT INTO wallets (id, name, status) VALUES ('wallet-a', 'Alpha', 'idle');
      PRAGMA user_version = 1;
    `);
    database.close();

    const migrated = new PersistentStorage(databasePath, diagnosticsPath);
    openStorage.push(migrated);
    expect(migrated.listWallets()).toMatchObject([
      {
        id: 'wallet-a',
        onboardingStatus: 'disconnected',
        connectionReference: null,
        miningCredentialReference: null,
        mamaBoardLevel: null,
      },
    ]);
    migrated.saveSecureValue('connection-ref', 'encrypted');
    expect(migrated.loadSecureValue('connection-ref')).toBe('encrypted');
  });

  it('persists reward evidence, balance baselines, and confirmed session results across restart', async () => {
    const { databasePath, diagnosticsPath, storage } = await createStorage();
    const reward: StoredRewardRecord = {
      id: 'locked-nackl:wallet-a:100:142:2026-08-07T11:00:00.000Z',
      walletId: 'wallet-a',
      amount: { value: '42', unit: 'NACKL' },
      recordedAt: new Date(2026, 7, 7, 12).getTime(),
      sessionId: 'session-a',
      generation: 1,
      kind: 'locked-nackl-delta',
      lockedNacklBeforeRaw: '100',
      lockedNacklAfterRaw: '142',
      detectionSource: 'reward-sync',
    };
    const snapshot = {
      walletId: 'wallet-a',
      values: {
        nacklLockedRaw: '142',
        nacklAvailableRaw: '5',
        usdcRaw: '6',
        shellRaw: '7',
      },
      synchronizedAt: '2026-08-07T12:00:00.000Z',
      status: 'fresh' as const,
      errorCode: null,
    };
    const result = {
      walletId: 'wallet-a',
      sessionId: 'session-a',
      generation: 1,
      miniEpoch: '12000',
      startedAt: '2026-08-07T11:50:00.000Z',
      completedAt: '2026-08-07T12:00:00.000Z',
      completedTaps: 70,
      targetTaps: 70,
      verifiedTaps: 68,
      rejectedTaps: 2,
      settlementOutcome: 'accepted',
      stopReason: 'settlement-completed',
      rewardDeltaRaw: '42',
      recoveryUsed: false,
    };

    storage.saveWallet({ id: 'wallet-a', name: 'Alpha' });
    storage.appendReward(reward);
    storage.appendReward(reward);
    storage.appendWalletBalanceSnapshot(snapshot);
    storage.saveWalletSessionResult(result);
    await storage.close();
    openStorage.splice(openStorage.indexOf(storage), 1);

    const reopened = new PersistentStorage(databasePath, diagnosticsPath);
    openStorage.push(reopened);
    expect(reopened.rewardsForWallet('wallet-a')).toEqual([reward]);
    expect(reopened.walletBalanceSnapshots('wallet-a')).toEqual([snapshot]);
    expect(reopened.walletSessionResults('wallet-a')).toEqual([result]);
  });

  it('loads bounded hot windows without deleting complete SQLite history', async () => {
    const { storage } = await createStorage();
    storage.saveWallet({ id: 'wallet-a', name: 'Alpha' });

    for (let index = 1; index <= 3; index += 1) {
      storage.appendReward({
        id: `reward-${index}`,
        walletId: 'wallet-a',
        amount: { value: String(index), unit: 'NACKL' },
        recordedAt: Date.parse(`2026-08-07T12:00:0${index}.000Z`),
        sessionId: `session-${index}`,
        generation: index,
      });
      storage.appendWalletBalanceSnapshot({
        walletId: 'wallet-a',
        values: {
          nacklLockedRaw: String(index),
          nacklAvailableRaw: '0',
          usdcRaw: '0',
          shellRaw: '0',
        },
        synchronizedAt: `2026-08-07T12:00:0${index}.000Z`,
        status: 'fresh',
        errorCode: null,
      });
      storage.saveWalletSessionResult({
        walletId: 'wallet-a',
        sessionId: `session-${index}`,
        generation: index,
        miniEpoch: String(12_000 + index),
        startedAt: `2026-08-07T11:50:0${index}.000Z`,
        completedAt: `2026-08-07T12:00:0${index}.000Z`,
        completedTaps: 70,
        targetTaps: 70,
        verifiedTaps: 70,
        rejectedTaps: 0,
        settlementOutcome: 'accepted',
        stopReason: 'settlement-completed',
        rewardDeltaRaw: String(index),
        recoveryUsed: false,
      });
    }

    expect(storage.rewardsForWallet('wallet-a')).toHaveLength(3);
    expect(storage.rewardsForWallet('wallet-a', 2).map((entry) => entry.id)).toEqual([
      'reward-2',
      'reward-3',
    ]);
    expect(
      storage.walletBalanceSnapshots('wallet-a', 1)[0]?.values?.nacklLockedRaw,
    ).toBe('3');
    expect(
      storage.walletSessionResults('wallet-a', 2).map((entry) => entry.sessionId),
    ).toEqual(['session-2', 'session-3']);
    expect(() => storage.rewardsForWallet('wallet-a', 0)).toThrow(RangeError);
  });

  it('migrates schema version 2 wallet rows without inventing a level', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'miner-core-storage-'));
    const databasePath = join(directory, 'miner-core.sqlite');
    const diagnosticsPath = join(directory, 'diagnostics.jsonl');
    temporaryDirectories.push(directory);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE wallets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        wallet_address TEXT,
        connection_status TEXT NOT NULL DEFAULT 'disconnected',
        connection_reference TEXT,
        mining_credential_reference TEXT
      );
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
      CREATE TABLE rewards (id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX rewards_wallet_history ON rewards (wallet_id, recorded_at, id);
      CREATE TABLE secure_values (reference TEXT PRIMARY KEY, encrypted_payload TEXT NOT NULL);
      INSERT INTO wallets (id, name, status) VALUES ('wallet-a', 'Alpha', 'idle');
      PRAGMA user_version = 2;
    `);
    database.close();

    const migrated = new PersistentStorage(databasePath, diagnosticsPath);
    openStorage.push(migrated);
    expect(migrated.listWallets()).toEqual([
      expect.objectContaining({
        id: 'wallet-a',
        mamaBoardLevel: null,
      }),
    ]);
    migrated.saveWallet({
      ...migrated.listWallets()[0],
      mamaBoardLevel: 72,
    });
    expect(migrated.listWallets()[0]?.mamaBoardLevel).toBe(72);
  });

  it('refuses a newer unknown schema instead of rewriting its version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'miner-core-storage-'));
    const databasePath = join(directory, 'miner-core.sqlite');
    const diagnosticsPath = join(directory, 'diagnostics.jsonl');
    temporaryDirectories.push(directory);
    const database = new DatabaseSync(databasePath);
      database.exec('PRAGMA user_version = 6;');
    database.close();

    expect(
      () => new PersistentStorage(databasePath, diagnosticsPath),
    ).toThrow('Unsupported Core Miner database version 6');
  });

  it('persists global uptime intervals and splits them at local midnight', async () => {
    const { storage } = await createStorage();
    const start = new Date(2026, 7, 8, 23, 30).getTime();
    const end = new Date(2026, 7, 9, 0, 30).getTime();
    storage.startGlobalMiningUptime(start);
    storage.startGlobalMiningUptime(start + 1_000);
    storage.stopGlobalMiningUptime(end);
    expect(storage.globalMiningUptimeSnapshot(new Date(2026, 7, 8, 23, 59).getTime()))
      .toEqual({
        completedTodayMs: 30 * 60_000,
        activeStartedAt: null,
        history: [
          { date: '2026-08-07', durationMs: 0 },
          { date: '2026-08-06', durationMs: 0 },
          { date: '2026-08-05', durationMs: 0 },
        ],
      });
    expect(storage.globalMiningUptimeSnapshot(new Date(2026, 7, 9, 1).getTime()))
      .toEqual({
        completedTodayMs: 30 * 60_000,
        activeStartedAt: null,
        history: [
          { date: '2026-08-08', durationMs: 30 * 60_000 },
          { date: '2026-08-07', durationMs: 0 },
          { date: '2026-08-06', durationMs: 0 },
        ],
      });
  });

  it('restores exactly three previous local uptime days from intervals', async () => {
    const { storage } = await createStorage();
    for (const [day, minutes] of [[6, 37], [7, 0], [8, 78]] as const) {
      if (minutes === 0) continue;
      const startedAt = new Date(2026, 7, day, 10).getTime();
      storage.startGlobalMiningUptime(startedAt);
      storage.stopGlobalMiningUptime(startedAt + minutes * 60_000);
    }

    expect(storage.globalMiningUptimeSnapshot(new Date(2026, 7, 9, 9).getTime()))
      .toEqual({
        completedTodayMs: 0,
        activeStartedAt: null,
        history: [
          { date: '2026-08-08', durationMs: 78 * 60_000 },
          { date: '2026-08-07', durationMs: 0 },
          { date: '2026-08-06', durationMs: 37 * 60_000 },
        ],
    });
  });

  it('updates only the active uptime marker and preserves an exact clean stop', async () => {
    const { databasePath, storage } = await createStorage();
    const startedAt = new Date(2026, 7, 8, 10).getTime();
    const heartbeatAt = startedAt + 60_000;
    const stoppedAt = startedAt + 150_000;

    storage.startGlobalMiningUptime(startedAt);
    storage.heartbeatGlobalMiningUptime(heartbeatAt);
    storage.heartbeatGlobalMiningUptime(heartbeatAt + 30_000);
    expect(storage.globalMiningUptimeSnapshot(heartbeatAt)).toMatchObject({
      completedTodayMs: 0,
      activeStartedAt: startedAt,
    });
    storage.stopGlobalMiningUptime(stoppedAt);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(`
        SELECT COUNT(*) AS count,
               MIN(started_at) AS started_at,
               MAX(ended_at) AS ended_at,
               MAX(last_active_at) AS last_active_at
        FROM global_mining_uptime_intervals
      `).get()).toEqual({
        count: 1,
        started_at: startedAt,
        ended_at: stoppedAt,
        last_active_at: stoppedAt,
      });
    } finally {
      database.close();
    }
  });

  it('normalizes a crash-open interval without counting offline time', async () => {
    const { databasePath, diagnosticsPath, storage } = await createStorage();
    await storage.close();
    openStorage.splice(openStorage.indexOf(storage), 1);
    const startedAt = new Date(2026, 7, 8, 10).getTime();
    const lastActiveAt = new Date(2026, 7, 8, 12, 37).getTime();
    const database = new DatabaseSync(databasePath);
    database.prepare(`
      INSERT INTO global_mining_uptime_intervals (
        started_at, ended_at, last_active_at
      ) VALUES (?, NULL, ?)
    `).run(startedAt, lastActiveAt);
    database.close();

    const reopened = new PersistentStorage(databasePath, diagnosticsPath);
    openStorage.push(reopened);
    expect(reopened.globalMiningUptimeSnapshot(startedAt + 6 * 60 * 60_000))
      .toEqual({
        completedTodayMs: 157 * 60_000,
        activeStartedAt: null,
        history: [
          { date: '2026-08-07', durationMs: 0 },
          { date: '2026-08-06', durationMs: 0 },
          { date: '2026-08-05', durationMs: 0 },
        ],
      });
  });
});
