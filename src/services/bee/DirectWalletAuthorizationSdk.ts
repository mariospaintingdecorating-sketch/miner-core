import { gen_mining_keys, get_miner_address_by_wallet_name, ensure_mining_keys_propagated, Wallet } from '@teamgosh/bee-sdk';
import { mobileContractAddress, mobileAbiAddress } from '../../shared/chainIdentity';
import type { BeeSdkOwnedResource } from './contracts';

export interface MiningAuthorizationKeys extends BeeSdkOwnedResource {
  readonly public: string; readonly secret: string; readonly deep_link: string;
}
export interface WalletAuthorizationIdentity { readonly walletAddress: string; readonly minerAddress: string; }
export interface DirectWalletAuthorizationSdk {
  generate(appId: string): Promise<MiningAuthorizationKeys>;
  resolve(endpoints: readonly string[], walletName: string, apiUrl: string, appId: string): Promise<WalletAuthorizationIdentity>;
  verify(endpoints: readonly string[], appId: string, minerAddress: string, publicKey: string): Promise<void>;
}
/** Only local key generation and public reads. Writes remain in the user's wallet. */
export class TeamGoshDirectWalletAuthorizationSdk implements DirectWalletAuthorizationSdk {
  generate(appId: string): Promise<MiningAuthorizationKeys> { return gen_mining_keys(appId); }
  async resolve(endpoints: readonly string[], walletName: string, apiUrl: string, appId: string): Promise<WalletAuthorizationIdentity> {
    const wallet = new Wallet([...endpoints], null, apiUrl, appId);
    try {
      const details = await wallet.get_multifactor_data_by_name(walletName);
      if (!details) throw new Error('Account name has not been found.');
      let walletAddress: string;
      try { walletAddress = mobileContractAddress(details.address); }
      finally { details.free(); }
      let minerAddress: string;
      try { minerAddress = await wallet.get_miner_address({ multifactor_address: mobileAbiAddress(walletAddress) }); }
      catch { minerAddress = await get_miner_address_by_wallet_name({ client_config: { network: { endpoints: [...endpoints], query_timeout: 8_000 } }, wallet_name: walletName }); }
      return Object.freeze({ walletAddress, minerAddress: mobileContractAddress(minerAddress) });
    } finally { wallet.free(); }
  }
  verify(endpoints: readonly string[], appId: string, minerAddress: string, publicKey: string): Promise<void> {
    return ensure_mining_keys_propagated({
      client_config: { network: { endpoints: [...endpoints], query_timeout: 8_000 } },
      miner_address: mobileAbiAddress(minerAddress), app_id: appId,
      expected_owner_public: publicKey, max_attempts: 1, interval_ms: 1_000,
    });
  }
}

/** Name lookups may use Shellnet; final ownership checks ALWAYS use mining endpoints. */
export function walletLookupEndpointGroups(endpoints: readonly string[]): readonly (readonly string[])[] {
  const groups: string[][] = [[...endpoints]];
  const hosts = endpoints.map(value => new URL(value).hostname);
  if (hosts.every(host => host === 'mainnet.ackinacki.org' || host === 'mainnet-cf.ackinacki.org')) {
    groups.push(['https://shellnet.ackinacki.org']);
    const fallback = ['https://mainnet-cf.ackinacki.org'];
    if (!hosts.includes('mainnet-cf.ackinacki.org')) groups.push(fallback);
  }
  return groups;
}

/** Same-chain read fallback only. Custom networks never cross to mainnet. */
export function miningVerificationEndpointGroups(endpoints: readonly string[]): readonly (readonly string[])[] {
  const groups: string[][] = [[...endpoints]];
  const hosts = endpoints.map(value => new URL(value).hostname);
  if (hosts.length && hosts.every(host => host === 'mainnet.ackinacki.org' || host === 'mainnet-cf.ackinacki.org')) {
    for (const host of ['mainnet-cf.ackinacki.org', 'mainnet.ackinacki.org'] as const) {
      if (!hosts.includes(host)) groups.push([`https://${host}`]);
    }
  }
  return groups;
}
