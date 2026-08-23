import type { RewardRecord } from '../shared/rewards';
import type { WalletDefinition, WalletId } from '../shared/wallets';
import type {
  WalletBalanceSnapshot,
  WalletSessionResult,
} from '../application/runtimeAnalytics';

export interface DiagnosticsHistoryStorageContract<TDiagnostic> {
  appendDiagnostic(diagnostic: TDiagnostic): Promise<void>;
  recentDiagnostics(limit: number): Promise<readonly TDiagnostic[]>;
}

export interface WalletConfigurationStorageContract {
  listWallets(): Promise<readonly WalletDefinition[]>;
  saveWallet(wallet: WalletDefinition): Promise<void>;
  /** Removes the wallet, its secure references, and wallet-scoped local history. */
  removeWallet(walletId: WalletId): Promise<void>;
}

export interface RewardHistoryStorageContract {
  appendReward(reward: RewardRecord): Promise<void>;
  rewardsForWallet(
    walletId: WalletId,
    limit?: number,
  ): Promise<readonly RewardRecord[]>;
}

export interface WalletAnalyticsStorageContract {
  appendWalletBalanceSnapshot(snapshot: WalletBalanceSnapshot): Promise<void>;
  walletBalanceSnapshots(
    walletId: WalletId,
    limit?: number,
  ): Promise<readonly WalletBalanceSnapshot[]>;
  saveWalletSessionResult(result: WalletSessionResult): Promise<void>;
  walletSessionResults(
    walletId: WalletId,
    limit?: number,
  ): Promise<readonly WalletSessionResult[]>;
}

export interface GlobalMiningUptimePersistenceSnapshot {
  readonly completedTodayMs: number;
  readonly activeStartedAt: number | null;
  /** Completed interval overlap for exactly the three previous local days. */
  readonly history: readonly Readonly<GlobalMiningUptimeHistoryEntry>[];
}

export interface GlobalMiningUptimeHistoryEntry {
  /** Local calendar date in YYYY-MM-DD form. */
  readonly date: string;
  readonly durationMs: number;
}

/** Persists the single application-wide mining-intent interval. */
export interface GlobalMiningUptimeStorageContract {
  globalMiningUptimeSnapshot(
    at: number,
  ): Promise<Readonly<GlobalMiningUptimePersistenceSnapshot>>;
  startGlobalMiningUptime(startedAt: number): Promise<void>;
  heartbeatGlobalMiningUptime(activeAt: number): Promise<void>;
  stopGlobalMiningUptime(endedAt: number): Promise<void>;
}

export interface MainEpochStartPersistenceSnapshot {
  readonly status: 'waiting-for-main-epoch' | 'waiting-for-delay';
  readonly armedAt: number;
  readonly baselineMainEpoch: string;
  readonly delayHours: number;
  readonly detectedMainEpoch: string | null;
  readonly epochDetectedAt: number | null;
  readonly targetStartAt: number | null;
}

/** Persists only an armed, not-yet-executed delayed mining start. */
export interface MainEpochStartStorageContract {
  loadMainEpochStartSchedule(): Promise<
    Readonly<MainEpochStartPersistenceSnapshot> | null
  >;
  saveMainEpochStartSchedule(
    snapshot: Readonly<MainEpochStartPersistenceSnapshot> | null,
  ): Promise<void>;
}

/**
 * Stores opaque sensitive payloads behind non-secret references. The desktop
 * implementation encrypts payloads before persistence.
 */
export interface SecureReferenceStorageContract {
  saveSecureValue(reference: string, value: string): Promise<void>;
  hasSecureValue(reference: string): Promise<boolean>;
  loadSecureValue(reference: string): Promise<string | null>;
  removeSecureValue(reference: string): Promise<void>;
}

export interface ApplicationStorageContract<TDiagnostic>
  extends DiagnosticsHistoryStorageContract<TDiagnostic>,
    WalletConfigurationStorageContract,
    RewardHistoryStorageContract {}
