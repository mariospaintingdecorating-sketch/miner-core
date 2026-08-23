import { describe, expect, it, vi } from 'vitest';
import type { MinerStorageBridge } from './ElectronStorageAdapter';
import { ElectronStorageAdapter } from './ElectronStorageAdapter';

function createBridge(): MinerStorageBridge {
  return {
    listWallets: vi.fn(async () => [{ id: 'wallet-a', name: 'Alpha' }]),
    saveWallet: vi.fn(async () => undefined),
    removeWallet: vi.fn(async () => undefined),
    appendReward: vi.fn(async () => undefined),
    rewardsForWallet: vi.fn(async () => []),
    appendWalletBalanceSnapshot: vi.fn(async () => undefined),
    walletBalanceSnapshots: vi.fn(async () => []),
    saveWalletSessionResult: vi.fn(async () => undefined),
    walletSessionResults: vi.fn(async () => []),
    appendDiagnostic: vi.fn(async () => undefined),
    recentDiagnostics: vi.fn(async () => [{ id: 'diagnostic-1' }]),
    saveSecureValue: vi.fn(async () => undefined),
    hasSecureValue: vi.fn(async () => false),
    loadSecureValue: vi.fn(async () => null),
    removeSecureValue: vi.fn(async () => undefined),
    globalMiningUptimeSnapshot: vi.fn(async () => ({
      completedTodayMs: 0,
      activeStartedAt: null,
      history: [
        { date: '2026-08-08', durationMs: 60_000 },
        { date: '2026-08-07', durationMs: 0 },
        { date: '2026-08-06', durationMs: 120_000 },
      ],
    })),
    startGlobalMiningUptime: vi.fn(async () => undefined),
    heartbeatGlobalMiningUptime: vi.fn(async () => undefined),
    stopGlobalMiningUptime: vi.fn(async () => undefined),
    loadMainEpochStartSchedule: vi.fn(async () => null),
    saveMainEpochStartSchedule: vi.fn(async () => undefined),
  };
}

describe('ElectronStorageAdapter', () => {
  it('forwards persistence operations through the narrow desktop bridge', async () => {
    const bridge = createBridge();
    const storage = new ElectronStorageAdapter<{ id: string }>(bridge);

    expect(await storage.listWallets()).toEqual([
      { id: 'wallet-a', name: 'Alpha' },
    ]);
    expect(await storage.recentDiagnostics(10)).toEqual([
      { id: 'diagnostic-1' },
    ]);
    expect(bridge.recentDiagnostics).toHaveBeenCalledWith(10);
    await storage.rewardsForWallet('wallet-a', 20);
    await storage.walletBalanceSnapshots('wallet-a', 1);
    await storage.walletSessionResults('wallet-a', 5);
    expect(bridge.rewardsForWallet).toHaveBeenCalledWith('wallet-a', 20);
    expect(bridge.walletBalanceSnapshots).toHaveBeenCalledWith('wallet-a', 1);
    expect(bridge.walletSessionResults).toHaveBeenCalledWith('wallet-a', 5);
    expect(await storage.globalMiningUptimeSnapshot(123)).toEqual({
      completedTodayMs: 0,
      activeStartedAt: null,
      history: [
        { date: '2026-08-08', durationMs: 60_000 },
        { date: '2026-08-07', durationMs: 0 },
        { date: '2026-08-06', durationMs: 120_000 },
      ],
    });
    await storage.startGlobalMiningUptime(123);
    await storage.heartbeatGlobalMiningUptime(234);
    await storage.stopGlobalMiningUptime(456);
    expect(bridge.startGlobalMiningUptime).toHaveBeenCalledWith(123);
    expect(bridge.heartbeatGlobalMiningUptime).toHaveBeenCalledWith(234);
    expect(bridge.stopGlobalMiningUptime).toHaveBeenCalledWith(456);
    expect(await storage.loadMainEpochStartSchedule()).toBeNull();
    await storage.saveMainEpochStartSchedule({
      status: 'waiting-for-main-epoch',
      armedAt: 123,
      baselineMainEpoch: '262000',
      delayHours: 2,
      detectedMainEpoch: null,
      epochDetectedAt: null,
      targetStartAt: null,
    });
    expect(bridge.saveMainEpochStartSchedule).toHaveBeenCalledOnce();
    await storage.saveSecureValue('credential-ref', 'sensitive-json');
    expect(bridge.saveSecureValue).toHaveBeenCalledWith(
      'credential-ref',
      'sensitive-json',
    );
    expect(await storage.hasSecureValue('credential-ref')).toBe(false);
    expect(bridge.hasSecureValue).toHaveBeenCalledWith('credential-ref');
    expect('startMining' in storage).toBe(false);
    expect('createSession' in storage).toBe(false);
  });
});
