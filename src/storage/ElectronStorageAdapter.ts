import type { RewardRecord } from '../shared/rewards';
import type { WalletDefinition, WalletId } from '../shared/wallets';
import type {
  ApplicationStorageContract,
  GlobalMiningUptimePersistenceSnapshot,
  GlobalMiningUptimeStorageContract,
  MainEpochStartPersistenceSnapshot,
  MainEpochStartStorageContract,
  SecureReferenceStorageContract,
  WalletAnalyticsStorageContract,
} from './contracts';
import type {
  WalletBalanceSnapshot,
  WalletSessionResult,
} from '../application/runtimeAnalytics';

export interface MinerStorageBridge {
  listWallets(): Promise<readonly WalletDefinition[]>;
  saveWallet(wallet: WalletDefinition): Promise<void>;
  removeWallet(walletId: WalletId): Promise<void>;
  appendReward(reward: RewardRecord): Promise<void>;
  rewardsForWallet(walletId: WalletId, limit?: number): Promise<readonly RewardRecord[]>;
  appendWalletBalanceSnapshot(snapshot: WalletBalanceSnapshot): Promise<void>;
  walletBalanceSnapshots(walletId: WalletId, limit?: number): Promise<readonly WalletBalanceSnapshot[]>;
  saveWalletSessionResult(result: WalletSessionResult): Promise<void>;
  walletSessionResults(walletId: WalletId, limit?: number): Promise<readonly WalletSessionResult[]>;
  appendDiagnostic(diagnostic: unknown): Promise<void>;
  recentDiagnostics(limit: number): Promise<readonly unknown[]>;
  saveSecureValue(reference: string, value: string): Promise<void>;
  hasSecureValue(reference: string): Promise<boolean>;
  loadSecureValue(reference: string): Promise<string | null>;
  removeSecureValue(reference: string): Promise<void>;
  globalMiningUptimeSnapshot(
    at: number,
  ): Promise<Readonly<GlobalMiningUptimePersistenceSnapshot>>;
  startGlobalMiningUptime(startedAt: number): Promise<void>;
  heartbeatGlobalMiningUptime(activeAt: number): Promise<void>;
  stopGlobalMiningUptime(endedAt: number): Promise<void>;
  loadMainEpochStartSchedule(): Promise<
    Readonly<MainEpochStartPersistenceSnapshot> | null
  >;
  saveMainEpochStartSchedule(
    snapshot: Readonly<MainEpochStartPersistenceSnapshot> | null,
  ): Promise<void>;
}

declare global {
  interface Window {
    readonly minerCoreStorage?: MinerStorageBridge;
  }
}

export class ElectronStorageAdapter<TDiagnostic>
  implements
    ApplicationStorageContract<TDiagnostic>,
    WalletAnalyticsStorageContract,
    GlobalMiningUptimeStorageContract,
    MainEpochStartStorageContract,
    SecureReferenceStorageContract
{
  readonly #bridge: MinerStorageBridge;

  constructor(bridge: MinerStorageBridge | undefined = window.minerCoreStorage) {
    if (!bridge) {
      throw new Error('Core Miner storage bridge is not available.');
    }

    this.#bridge = bridge;
  }

  listWallets(): Promise<readonly WalletDefinition[]> {
    return this.#bridge.listWallets();
  }

  saveWallet(wallet: WalletDefinition): Promise<void> {
    return this.#bridge.saveWallet(wallet);
  }

  removeWallet(walletId: WalletId): Promise<void> {
    return this.#bridge.removeWallet(walletId);
  }

  appendReward(reward: RewardRecord): Promise<void> {
    return this.#bridge.appendReward(reward);
  }

  rewardsForWallet(
    walletId: WalletId,
    limit?: number,
  ): Promise<readonly RewardRecord[]> {
    return this.#bridge.rewardsForWallet(walletId, limit);
  }

  appendWalletBalanceSnapshot(snapshot: WalletBalanceSnapshot): Promise<void> {
    return this.#bridge.appendWalletBalanceSnapshot(snapshot);
  }

  walletBalanceSnapshots(
    walletId: WalletId,
    limit?: number,
  ): Promise<readonly WalletBalanceSnapshot[]> {
    return this.#bridge.walletBalanceSnapshots(walletId, limit);
  }

  saveWalletSessionResult(result: WalletSessionResult): Promise<void> {
    return this.#bridge.saveWalletSessionResult(result);
  }

  walletSessionResults(
    walletId: WalletId,
    limit?: number,
  ): Promise<readonly WalletSessionResult[]> {
    return this.#bridge.walletSessionResults(walletId, limit);
  }

  appendDiagnostic(diagnostic: TDiagnostic): Promise<void> {
    return this.#bridge.appendDiagnostic(diagnostic);
  }

  async recentDiagnostics(limit: number): Promise<readonly TDiagnostic[]> {
    return (await this.#bridge.recentDiagnostics(limit)) as readonly TDiagnostic[];
  }

  saveSecureValue(reference: string, value: string): Promise<void> {
    return this.#bridge.saveSecureValue(reference, value);
  }

  hasSecureValue(reference: string): Promise<boolean> {
    return this.#bridge.hasSecureValue(reference);
  }

  loadSecureValue(reference: string): Promise<string | null> {
    return this.#bridge.loadSecureValue(reference);
  }

  removeSecureValue(reference: string): Promise<void> {
    return this.#bridge.removeSecureValue(reference);
  }

  globalMiningUptimeSnapshot(
    at: number,
  ): Promise<Readonly<GlobalMiningUptimePersistenceSnapshot>> {
    return this.#bridge.globalMiningUptimeSnapshot(at);
  }

  startGlobalMiningUptime(startedAt: number): Promise<void> {
    return this.#bridge.startGlobalMiningUptime(startedAt);
  }

  heartbeatGlobalMiningUptime(activeAt: number): Promise<void> {
    return this.#bridge.heartbeatGlobalMiningUptime(activeAt);
  }

  stopGlobalMiningUptime(endedAt: number): Promise<void> {
    return this.#bridge.stopGlobalMiningUptime(endedAt);
  }

  loadMainEpochStartSchedule(): Promise<
    Readonly<MainEpochStartPersistenceSnapshot> | null
  > {
    return this.#bridge.loadMainEpochStartSchedule();
  }

  saveMainEpochStartSchedule(
    snapshot: Readonly<MainEpochStartPersistenceSnapshot> | null,
  ): Promise<void> {
    return this.#bridge.saveMainEpochStartSchedule(snapshot);
  }

}
