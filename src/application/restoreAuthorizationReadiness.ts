import { miningAuthorizationContext } from '../shared/chainIdentity';
import type { WalletRegistryContract } from '../shared/wallets';
import type { SecureReferenceStorageContract } from '../storage/contracts';

/** Read old credentials without rewriting, deleting or performing network operations. */
export async function restoreAuthorizationReadiness(
  registry: Pick<WalletRegistryContract, 'wallets' | 'updateConnection'>,
  storage: Pick<SecureReferenceStorageContract, 'loadSecureValue'>,
  configuration: Readonly<{ appId: string; endpoints: readonly string[] }>,
): Promise<void> {
  const expected = miningAuthorizationContext(configuration);
  for (const wallet of registry.wallets()) {
    if (wallet.onboardingStatus !== 'ready' || !wallet.miningCredentialReference) continue;
    let verifiedContext = false;
    try {
      const raw = await storage.loadSecureValue(wallet.miningCredentialReference);
      verifiedContext = raw !== null && JSON.parse(raw)?.authorizationContext === expected;
    } catch { /* Keep the original record intact, but do not treat it as ready. */ }
    if (!verifiedContext) registry.updateConnection(wallet.id, {
      walletAddress: wallet.walletAddress,
      onboardingStatus: 'awaiting-mining-key-approval',
      connectionReference: wallet.connectionReference,
      miningCredentialReference: wallet.miningCredentialReference,
    });
  }
}
