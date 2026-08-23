import { describe, expect, it, vi } from 'vitest';
import type {
  DiagnosticsHistoryStorageContract,
  RewardHistoryStorageContract,
  SecureReferenceStorageContract,
  WalletConfigurationStorageContract,
} from './contracts';

describe('storage contracts', () => {
  it('keeps diagnostics as a storage-only boundary', async () => {
    const diagnostics: DiagnosticsHistoryStorageContract<{ id: string }> = {
      appendDiagnostic: vi.fn(async () => undefined),
      recentDiagnostics: vi.fn(async () => [{ id: 'diagnostic-1' }]),
    };

    expect(await diagnostics.recentDiagnostics(10)).toEqual([
      { id: 'diagnostic-1' },
    ]);
    expect('stopMining' in diagnostics).toBe(false);
  });

  it('requires wallet-scoped reward history access', async () => {
    const walletStorage: WalletConfigurationStorageContract = {
      listWallets: vi.fn(async () => [{ id: 'wallet-a', name: 'Alpha' }]),
      saveWallet: vi.fn(async () => undefined),
      removeWallet: vi.fn(async () => undefined),
    };
    const rewardStorage: RewardHistoryStorageContract = {
      appendReward: vi.fn(async () => undefined),
      rewardsForWallet: vi.fn(async (walletId) =>
        walletId === 'wallet-a'
          ? [
              {
                id: 'reward-a',
                walletId: 'wallet-a',
                amount: { value: '12', unit: 'ACKI' },
                recordedAt: 1,
                sessionId: null,
                generation: null,
              },
            ]
          : [],
      ),
    };

    expect(await walletStorage.listWallets()).toEqual([
      { id: 'wallet-a', name: 'Alpha' },
    ]);
    expect(await rewardStorage.rewardsForWallet('wallet-a')).toHaveLength(1);
    expect(await rewardStorage.rewardsForWallet('wallet-b')).toEqual([]);
    expect('allWalletRewards' in rewardStorage).toBe(false);
    expect('restart' in rewardStorage).toBe(false);
  });

  it('keeps sensitive values behind an opaque storage-only reference', async () => {
    const secureStorage: SecureReferenceStorageContract = {
      saveSecureValue: vi.fn(async () => undefined),
      hasSecureValue: vi.fn(async () => true),
      loadSecureValue: vi.fn(async () => 'encrypted-value'),
      removeSecureValue: vi.fn(async () => undefined),
    };

    expect(await secureStorage.loadSecureValue('credential-ref')).toBe(
      'encrypted-value',
    );
    expect(await secureStorage.hasSecureValue('credential-ref')).toBe(true);
    expect('startMining' in secureStorage).toBe(false);
    expect('createSession' in secureStorage).toBe(false);
  });
});
