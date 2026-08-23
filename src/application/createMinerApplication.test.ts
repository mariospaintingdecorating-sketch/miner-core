import { describe, expect, it, vi } from 'vitest';
import type {
  ApplicationStorageContract,
  WalletAnalyticsStorageContract,
} from '../storage';
import { createMinerApplication } from './createMinerApplication';
import { REWARD_HOT_HISTORY_LIMIT_PER_WALLET } from './RewardLedger';
import type { RuntimeDiagnostic } from './RuntimeDiagnostics';

function diagnostic(): RuntimeDiagnostic {
  return {
    id: 'restored-diagnostic',
    timestamp: '2026-08-04T10:00:00.000Z',
    eventType: 'session-started',
    level: 'info',
    category: 'MINING',
    title: 'session started',
    detail: 'Restored lifecycle event',
    walletId: 'wallet-a',
    sessionId: 'session-a',
    generation: 1,
    miniEpoch: '12000',
    code: null,
    message: null,
    details: {},
  };
}

describe('createMinerApplication', () => {
  it('hydrates wallet, reward, and diagnostics presentation from persistence', async () => {
    const rewardsForWallet = vi.fn(async (walletId: string) =>
      walletId === 'wallet-a'
        ? [
            {
              id: 'reward-a',
              walletId,
              amount: { value: '12', unit: 'ACKI' },
              recordedAt: Date.parse('2026-08-04T10:30:00.000Z'),
              sessionId: 'session-a',
              generation: 1,
            },
          ]
        : [],
    );
    const walletBalanceSnapshots = vi.fn(async (walletId: string) => [
      {
        walletId,
        values: {
          nacklLockedRaw: '142',
          nacklAvailableRaw: '5',
          usdcRaw: '6',
          shellRaw: '7',
        },
        synchronizedAt: '2026-08-04T10:35:00.000Z',
        status: 'fresh' as const,
        errorCode: null,
      },
    ]);
    const walletSessionResults = vi.fn(async (walletId: string) => [
      {
        walletId,
        sessionId: 'session-a',
        generation: 1,
        miniEpoch: '12000',
        startedAt: '2026-08-04T10:00:00.000Z',
        completedAt: '2026-08-04T10:30:00.000Z',
        completedTaps: 70,
        targetTaps: 70,
        verifiedTaps: 68,
        rejectedTaps: null,
        settlementOutcome: 'accepted' as const,
        stopReason: 'settlement-completed' as const,
        rewardDeltaRaw: null,
        recoveryUsed: false,
      },
    ]);
    const storage: ApplicationStorageContract<RuntimeDiagnostic> &
      WalletAnalyticsStorageContract = {
      listWallets: async () => [
        { id: 'wallet-a', name: 'Alpha', status: 'offline' },
      ],
      saveWallet: async () => undefined,
      removeWallet: async () => undefined,
      appendReward: async () => undefined,
      rewardsForWallet,
      appendWalletBalanceSnapshot: async () => undefined,
      walletBalanceSnapshots,
      saveWalletSessionResult: async () => undefined,
      walletSessionResults,
      appendDiagnostic: async () => undefined,
      recentDiagnostics: async () => [diagnostic()],
    };

    const application = await createMinerApplication(storage);

    expect(application.getWallets()).toMatchObject([
      {
        id: 'wallet-a',
        status: 'offline',
        latestReward: { id: 'reward-a', amountLabel: '12 ACKI' },
        balance: { values: { nacklLockedRaw: '142' } },
      },
    ]);
    expect(application.getDiagnostics()).toEqual([diagnostic()]);
    expect(rewardsForWallet).toHaveBeenCalledWith(
      'wallet-a',
      REWARD_HOT_HISTORY_LIMIT_PER_WALLET,
    );
    expect(walletBalanceSnapshots).toHaveBeenCalledWith('wallet-a', 1);
    expect(walletSessionResults).toHaveBeenCalledWith('wallet-a', 5);
    await application.dispose();
  });

  it('saves and removes wallet configuration through the same storage owner', async () => {
    const saveWallet = vi.fn(async () => undefined);
    const removeWallet = vi.fn(async () => undefined);
    const storage: ApplicationStorageContract<RuntimeDiagnostic> = {
      listWallets: async () => [],
      saveWallet,
      removeWallet,
      appendReward: async () => undefined,
      rewardsForWallet: async () => [],
      appendDiagnostic: async () => undefined,
      recentDiagnostics: async () => [],
    };
    const application = await createMinerApplication(storage);

    await application.registerWallet({ name: ' Alpha ' });
    const walletId = application.getWallets()[0]?.id;

    expect(walletId).toMatch(/^wallet-[0-9a-f-]{36}$/);
    await application.removeWallet(walletId!);

    expect(saveWallet).toHaveBeenCalledWith({
      id: walletId,
      name: 'Alpha',
      status: 'idle',
      walletAddress: null,
      onboardingStatus: 'disconnected',
      connectionReference: null,
      miningCredentialReference: null,
      mamaBoardLevel: null,
    });
    expect(removeWallet).toHaveBeenCalledWith(walletId);
    expect(application.getWallets()).toEqual([]);
    await application.dispose();
  });
});
