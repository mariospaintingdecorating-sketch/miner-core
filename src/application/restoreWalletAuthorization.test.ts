import { describe, expect, it, vi } from 'vitest';
import { restoreWalletAuthorization } from './restoreWalletAuthorization';
import type { WalletDefinition } from '../shared/wallets';
const wallet: WalletDefinition = { id: 'w', name: 'full-name', walletAddress: '0:wallet',
  onboardingStatus: 'ready', connectionReference: 'c', miningCredentialReference: 'k' };
function raw(fields = {}) { return JSON.stringify({ version: 1, walletName: 'account', walletAddress: '0:wallet',
  minerAddress: '0:miner', publicKey: 'pub', secretKey: 'synthetic-secret', ...fields }); }
describe('read-only authorization readiness migration', () => {
  it.each([null, '{broken', raw(), raw({ appId: 'old', verifiedAppId: 'old', verifiedAt: '2026-09-20' }),
    raw({ appId: 'new', verifiedAppId: 'new', verifiedAt: 'invalid' })])('preserves unverified or unreadable wallets without writing/deleting them (%s)', async (value) => {
    const storage = { loadSecureValue: vi.fn(async () => value), saveSecureValue: vi.fn(), removeSecureValue: vi.fn() };
    const restored = await restoreWalletAuthorization([wallet], storage, 'new');
    expect(restored).toEqual([{ ...wallet, onboardingStatus: 'awaiting-mining-key-approval' }]);
    expect(storage.saveSecureValue).not.toHaveBeenCalled(); expect(storage.removeSecureValue).not.toHaveBeenCalled();
  });
  it('retains readiness only for a matching explicitly verified credential', async () => {
    const restored = await restoreWalletAuthorization([wallet], { loadSecureValue: async () => raw({
      appId: 'new', verifiedAppId: 'new', verifiedAt: '2026-09-20T00:00:00.000Z' }) }, 'new');
    expect(restored[0]).toBe(wallet);
  });
  it('retains the record if encrypted storage refuses access', async () => {
    const result = await restoreWalletAuthorization([wallet], { loadSecureValue: async () => { throw new Error('decrypt failed'); } }, 'new');
    expect(result[0]?.miningCredentialReference).toBe('k'); expect(result[0]?.onboardingStatus).not.toBe('ready');
  });
});
