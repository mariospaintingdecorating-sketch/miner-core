import type { RewardRecord } from '../shared/rewards';

export const TOKEN_DECIMALS = 9;
export const USDC_DECIMALS = 6;

export type WalletRecoveryState =
  | 'healthy'
  | 'detecting-issue'
  | 'recovery-pending'
  | 'recovering'
  | 'recovered'
  | 'recovery-failed'
  | 'manual-stop';

export interface WalletRecoveryPresentation {
  readonly walletId: string;
  readonly state: WalletRecoveryState;
  readonly attempt: number;
  readonly maximumAttempts: number;
  readonly issueCode: string | null;
  readonly issueMessage: string | null;
  readonly nextAttemptAt: string | null;
  readonly updatedAt: string;
}

export interface WalletRecoveryHistoryEntry
  extends WalletRecoveryPresentation {
  readonly id: string;
}

export type WalletStopReason =
  | 'operator-stop'
  | 'epoch-boundary'
  | 'settlement-completed'
  | 'settlement-failed'
  | 'native-error'
  | 'timeout'
  | 'wallet-not-ready'
  | 'propagation-failed'
  | 'unknown';

export type SessionSettlementOutcome =
  | 'pending'
  | 'accepted'
  | 'completed'
  | 'rejected'
  | 'timeout'
  | 'native_error'
  | 'unknown';

export interface WalletSessionResult {
  readonly walletId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly miniEpoch: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly completedTaps: number;
  readonly targetTaps: number;
  /** Null until a canonical Bee tap_sum-style source is available. */
  readonly verifiedTaps: number | null;
  /** Null until a canonical rejection source is available. */
  readonly rejectedTaps: number | null;
  readonly settlementOutcome: SessionSettlementOutcome;
  readonly stopReason: WalletStopReason;
  readonly rewardDeltaRaw: string | null;
  readonly recoveryUsed: boolean;
}

export interface WalletRewardDelta {
  readonly id: string;
  readonly walletId: string;
  readonly amountRaw: string;
  readonly detectedAt: string;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly lockedNacklBeforeRaw: string;
  readonly lockedNacklAfterRaw: string;
  /** False for history hydrated from disk, so presentation effects do not replay. */
  readonly observedInCurrentRun: boolean;
  readonly source:
    | 'settlement'
    | 'reward-sync'
    | 'epoch'
    | 'manual'
    | 'monitoring';
}

export interface WalletBalanceValues {
  readonly nacklLockedRaw: string;
  readonly nacklAvailableRaw: string;
  readonly usdcRaw: string;
  readonly shellRaw: string;
}

export type WalletBalanceDataStatus = 'fresh' | 'partial' | 'error';

export interface WalletBalanceSnapshot {
  readonly walletId: string;
  readonly values: Readonly<WalletBalanceValues> | null;
  readonly synchronizedAt: string;
  readonly status: WalletBalanceDataStatus;
  readonly errorCode: string | null;
}

/** Read-only infrastructure boundary. It never controls a wallet or mining. */
export interface WalletBalanceSource {
  synchronize(
    walletId: string,
    walletAddress: string,
  ): Promise<Readonly<WalletBalanceValues>>;
}

export interface FinancialAssetSummary {
  readonly rawTotal: string | null;
  readonly formattedTotal: string | null;
  readonly walletCount: number;
  readonly lastUpdatedAt: string | null;
  readonly status: WalletBalanceDataStatus;
}

export interface WalletFinancialOverview {
  readonly nacklTotal: Readonly<FinancialAssetSummary>;
  readonly nacklLocked: Readonly<FinancialAssetSummary>;
  readonly nacklAvailable: Readonly<FinancialAssetSummary>;
  readonly usdc: Readonly<FinancialAssetSummary>;
  readonly shell: Readonly<FinancialAssetSummary>;
  readonly dailyRewards: readonly Readonly<DailyNacklRewardSummary>[];
}

export interface DailyNacklRewardSummary {
  /** Operator-local calendar date in YYYY-MM-DD format. */
  readonly date: string;
  readonly amountRaw: string;
  readonly rewardCount: number;
}

export function positiveLockedNacklDelta(
  previousRaw: string,
  currentRaw: string,
): string | null {
  const previous = parseRawAmount(previousRaw);
  const current = parseRawAmount(currentRaw);

  if (previous === null || current === null || current <= previous) {
    return null;
  }

  return (current - previous).toString();
}

export function formatRawAmount(
  raw: string,
  decimals = TOKEN_DECIMALS,
  maximumFractionDigits = 2,
  decimalSeparator = '.',
): string {
  const amount = parseRawAmount(raw);

  if (
    amount === null ||
    decimals < 0 ||
    !Number.isInteger(decimals) ||
    maximumFractionDigits < 0 ||
    !Number.isInteger(maximumFractionDigits)
  ) {
    return raw;
  }

  const rawUnit = 10n ** BigInt(decimals);
  const displayUnit = 10n ** BigInt(maximumFractionDigits);
  const rounded = (amount * displayUnit + rawUnit / 2n) / rawUnit;
  const integer = (rounded / displayUnit).toString();
  const fraction = maximumFractionDigits > 0
    ? (rounded % displayUnit)
        .toString()
        .padStart(maximumFractionDigits, '0')
        .replace(/0+$/, '')
    : '';

  return fraction ? `${integer}${decimalSeparator}${fraction}` : integer;
}

export function aggregateWalletBalances(
  snapshots: readonly Readonly<WalletBalanceSnapshot>[],
  expectedWalletCount: number,
  dailyRewards: readonly Readonly<DailyNacklRewardSummary>[] = [],
): Readonly<WalletFinancialOverview> {
  const available = snapshots.filter(
    (snapshot): snapshot is Readonly<WalletBalanceSnapshot> & {
      readonly values: Readonly<WalletBalanceValues>;
    } => snapshot.values !== null,
  );
  const status: WalletBalanceDataStatus =
    available.length === 0
      ? 'error'
      : available.length < expectedWalletCount ||
          snapshots.some((snapshot) => snapshot.status !== 'fresh')
        ? 'partial'
        : 'fresh';
  const lastUpdatedAt = available.reduce<string | null>(
    (latest, snapshot) =>
      latest === null || snapshot.synchronizedAt > latest
        ? snapshot.synchronizedAt
        : latest,
    null,
  );

  const summary = (
    field: keyof WalletBalanceValues,
  ): Readonly<FinancialAssetSummary> => {
    const total = available.length === 0
      ? null
      : available.reduce<bigint | null>((sum, snapshot) => {
          const value = parseRawAmount(snapshot.values[field]);
          return value === null || sum === null ? null : sum + value;
        }, 0n);

    return Object.freeze({
      rawTotal: total?.toString() ?? null,
      formattedTotal:
        total === null
          ? null
          : formatRawAmount(
              total.toString(),
              field === 'usdcRaw' ? USDC_DECIMALS : TOKEN_DECIMALS,
            ),
      walletCount: available.length,
      lastUpdatedAt,
      status,
    });
  };

  const nacklLocked = summary('nacklLockedRaw');
  const nacklAvailable = summary('nacklAvailableRaw');
  const nacklTotalRaw =
    nacklLocked.rawTotal === null || nacklAvailable.rawTotal === null
      ? null
      : (BigInt(nacklLocked.rawTotal) + BigInt(nacklAvailable.rawTotal)).toString();

  return Object.freeze({
    nacklTotal: Object.freeze({
      rawTotal: nacklTotalRaw,
      formattedTotal:
        nacklTotalRaw === null ? null : formatRawAmount(nacklTotalRaw),
      walletCount: available.length,
      lastUpdatedAt,
      status,
    }),
    nacklLocked,
    nacklAvailable,
    usdc: summary('usdcRaw'),
    shell: summary('shellRaw'),
    dailyRewards: Object.freeze([...dailyRewards]),
  });
}

export function aggregateDailyNacklRewards(
  rewards: readonly Readonly<WalletRewardDelta>[],
  dayCount = 3,
  referenceTime = new Date(),
): readonly Readonly<DailyNacklRewardSummary>[] {
  if (!Number.isInteger(dayCount) || dayCount < 1) {
    return Object.freeze([]);
  }

  const trackedDays = Array.from({ length: dayCount }, (_, index) =>
    localDateKey(
      new Date(
        referenceTime.getFullYear(),
        referenceTime.getMonth(),
        referenceTime.getDate() - index,
      ),
    ),
  );
  const totals = new Map<string, { amount: bigint; count: number }>(
    trackedDays.map((date) => [date, { amount: 0n, count: 0 }]),
  );

  for (const reward of rewards) {
    const date = normalizedLocalDate(reward.detectedAt);
    const amount = parseRawAmount(reward.amountRaw);
    const total = date ? totals.get(date) : undefined;

    if (!total || amount === null) {
      continue;
    }

    total.amount += amount;
    total.count += 1;
  }

  return Object.freeze(
    trackedDays.map((date) => {
      const total = totals.get(date)!;
      return Object.freeze({
        date,
        amountRaw: total.amount.toString(),
        rewardCount: total.count,
      });
    }),
  );
}

export function aggregateDailyNacklRewardRecords(
  rewardsByWallet: Iterable<readonly Readonly<RewardRecord>[]>,
  dayCount = 3,
  referenceTime = new Date(),
): readonly Readonly<DailyNacklRewardSummary>[] {
  if (!Number.isInteger(dayCount) || dayCount < 1) {
    return Object.freeze([]);
  }

  const trackedDays = Array.from({ length: dayCount }, (_, index) =>
    localDateKey(
      new Date(
        referenceTime.getFullYear(),
        referenceTime.getMonth(),
        referenceTime.getDate() - index,
      ),
    ),
  );
  const totals = new Map<string, { amount: bigint; count: number }>(
    trackedDays.map((date) => [date, { amount: 0n, count: 0 }]),
  );

  for (const walletRewards of rewardsByWallet) {
    for (const reward of walletRewards) {
      if (
        reward.kind !== 'locked-nackl-delta' ||
        reward.lockedNacklBeforeRaw == null ||
        reward.lockedNacklAfterRaw == null ||
        !reward.detectionSource
      ) {
        continue;
      }

      const date = localDateKey(new Date(reward.recordedAt));
      const amount = parseRawAmount(reward.amount.value);
      const total = totals.get(date);
      if (!total || amount === null) {
        continue;
      }

      total.amount += amount;
      total.count += 1;
    }
  }

  return Object.freeze(
    trackedDays.map((date) => {
      const total = totals.get(date)!;
      return Object.freeze({
        date,
        amountRaw: total.amount.toString(),
        rewardCount: total.count,
      });
    }),
  );
}

function normalizedLocalDate(value: string): string | null {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? null
    : localDateKey(timestamp);
}

function localDateKey(value: Date): string {
  return [
    value.getFullYear().toString().padStart(4, '0'),
    (value.getMonth() + 1).toString().padStart(2, '0'),
    value.getDate().toString().padStart(2, '0'),
  ].join('-');
}

function parseRawAmount(value: string): bigint | null {
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? BigInt(normalized) : null;
}
