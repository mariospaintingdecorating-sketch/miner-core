/** The application ID is an authorization key, not a contract routing partition. */
export const CORE_APPLICATION_ID = '0x' + '30'.padStart(64, '0');
export const MOBILE_VERIFIERS_DAPP_ID = '1'.padStart(64, '0');

export function contractIdentity(value: string): Readonly<{ dappId: string; accountId: string }> {
  const canonical = /^([0-9a-f]{64})::([0-9a-f]{64})$/i.exec(value);
  if (canonical) return Object.freeze({ dappId: canonical[1].toLowerCase(), accountId: canonical[2].toLowerCase() });
  const legacy = /^0:([0-9a-f]{64})$/i.exec(value);
  if (legacy) return Object.freeze({ dappId: MOBILE_VERIFIERS_DAPP_ID, accountId: legacy[1].toLowerCase() });
  throw new TypeError('Invalid contract address: expected dapp_id::account_id or a legacy 0: account.');
}

export function mobileContractAddress(value: string): string {
  const identity = contractIdentity(value);
  if (identity.dappId !== MOBILE_VERIFIERS_DAPP_ID) throw new TypeError('Contract is not in Mobile Verifiers.');
  return `${identity.dappId}::${identity.accountId}`;
}

/**
 * Bee/Kit 6.1 routes by dApp separately. Its ABI address parameters must still
 * be raw workchain addresses (0:<64hex>), never the network's scoped spelling.
 * Validate the partition before conversion; do not discard an arbitrary dApp.
 */
export function mobileAbiAddress(value: string): string {
  const scoped = mobileContractAddress(value);
  return `0:${contractIdentity(scoped).accountId}`;
}

export function sameWalletAddress(left: string, right: string): boolean {
  if (left === right) return true;
  try { return mobileContractAddress(left) === mobileContractAddress(right); } catch { return false; }
}

/** Conservative binding to the configured endpoint set; not a claim to verify chain genesis. */
export function miningAuthorizationContext(configuration: Readonly<{ appId: string; endpoints: readonly string[] }>): string {
  const endpoints = configuration.endpoints.map((endpoint) => new URL(endpoint).toString()).sort();
  const rawId = configuration.appId.trim().toLowerCase();
  const appId = /^(?:0x)?[0-9a-f]{64}$/.test(rawId) ? rawId.replace(/^0x/, '') : rawId;
  return JSON.stringify({ version: 1, appId, endpoints });
}
