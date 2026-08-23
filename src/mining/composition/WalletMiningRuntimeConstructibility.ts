import type { ValidatedMiningIdentity } from '../WalletMiningRuntime';
import { immutableValidatedMiningIdentity } from '../product/MiningIdentityAdapter';

export interface WalletMiningRuntimeConstructibilityInspector {
  inspect(
    identity: Readonly<ValidatedMiningIdentity>,
  ): Readonly<{ constructible: boolean }>;
}

export const WALLET_MINING_RUNTIME_CONSTRUCTIBILITY_INSPECTOR:
  WalletMiningRuntimeConstructibilityInspector = Object.freeze({
    inspect: (identity: Readonly<ValidatedMiningIdentity>) =>
      inspectWalletMiningRuntimeConstructibility(identity),
  });

/** Pure dependency-shape validation; reserves and constructs nothing. */
export function inspectWalletMiningRuntimeConstructibility(
  identity: Readonly<ValidatedMiningIdentity>,
): Readonly<{ constructible: boolean }> {
  const immutable = immutableValidatedMiningIdentity(identity);
  const constructible =
    immutable.walletId.trim().length > 0 &&
    immutable.endpoints.length > 0 &&
    immutable.appId.length > 0 &&
    immutable.minerAddress.length > 0 &&
    immutable.publicKey.length > 0 &&
    immutable.secretKey.length > 0;
  return Object.freeze({ constructible });
}
