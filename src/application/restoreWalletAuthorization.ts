import type { WalletDefinition } from '../shared/wallets';
import type { SecureReferenceStorageContract } from '../storage/contracts';
import { credentialVerifiedForApp, parseStoredBeeMiningCredential } from '../services/bee/BeeWalletConnectionAdapter';

/** Read-only migration of readiness, never of secrets or on-chain permissions.
 * Retain every wallet/ref, including unreadable records, for explicit recovery.
 */
export async function restoreWalletAuthorization(
  wallets: readonly WalletDefinition[],
  storage: Pick<SecureReferenceStorageContract, 'loadSecureValue'> | null,
  appId: string | null,
): Promise<readonly WalletDefinition[]> {
  return Promise.all(wallets.map(async (wallet) => {
    if (wallet.onboardingStatus !== 'ready') return wallet;
    try {
      const raw = storage && wallet.miningCredentialReference
        ? await storage.loadSecureValue(wallet.miningCredentialReference) : null;
      const credential = raw === null ? null : parseStoredBeeMiningCredential(raw);
      if (appId && credential && wallet.walletAddress === credential.walletAddress &&
          credentialVerifiedForApp(credential, appId)) return wallet;
    } catch {
      // Corrupt/unreadable is not permission to drop or rewrite the record.
    }
    return Object.freeze({ ...wallet,
      onboardingStatus: wallet.connectionReference && wallet.miningCredentialReference
        ? 'awaiting-mining-key-approval' as const : 'failed' as const,
    });
  }));
}
