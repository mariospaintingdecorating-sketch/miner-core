import type { RuntimePreflight } from '../../application/RuntimePreflight';
import type { ProductionConfigurationResolution } from '../../application/productionConfiguration';
import { parseStoredBeeMiningCredential } from '../../services/bee/BeeWalletConnectionAdapter';
import type { WalletRegistryContract } from '../../shared/wallets';
import type { SecureReferenceStorageContract } from '../../storage/contracts';
import type { ValidatedMiningIdentity } from '../WalletMiningRuntime';

export interface MiningIdentitySource {
  resolve(walletId: string): Promise<Readonly<ValidatedMiningIdentity>>;
}

export type MiningIdentityPreparationFailureCode =
  | 'PRODUCT_READINESS_FAILED'
  | 'PRODUCT_CONFIGURATION_UNAVAILABLE'
  | 'APP_ID_INVALID'
  | 'ENDPOINTS_INVALID'
  | 'WALLET_IDENTITY_UNAVAILABLE'
  | 'SECURE_CREDENTIAL_UNAVAILABLE'
  | 'SECURE_CREDENTIAL_INVALID'
  | 'WALLET_IDENTITY_MISMATCH'
  | 'MINER_ADDRESS_INVALID'
  | 'PUBLIC_KEY_INVALID';

export class MiningIdentityPreparationError extends Error {
  constructor(
    readonly code: MiningIdentityPreparationFailureCode,
    readonly productReasonCode: string | null = null,
  ) {
    super(`Mining identity preparation failed (${code}).`);
    this.name = 'MiningIdentityPreparationError';
  }
}

/**
 * Maps the product's already-onboarded wallet and secure credential to the
 * wallet-local runtime identity. Mining-key propagation is verified when the
 * wallet enters onboardingStatus=ready; session startup must not repeat that
 * network operation for every wallet and every mini-epoch.
 */
export class ProductMiningIdentityAdapter implements MiningIdentitySource {
  constructor(
    private readonly preflight: Pick<RuntimePreflight, 'inspect'>,
    private readonly configuration: Readonly<ProductionConfigurationResolution>,
    private readonly walletRegistry: Pick<WalletRegistryContract, 'wallet'>,
    private readonly secureStorage: Pick<
      SecureReferenceStorageContract,
      'loadSecureValue'
    >,
  ) {}

  async resolve(walletId: string): Promise<Readonly<ValidatedMiningIdentity>> {
    const normalizedWalletId = walletId.trim();
    if (!normalizedWalletId) {
      throw new MiningIdentityPreparationError('WALLET_IDENTITY_UNAVAILABLE');
    }

    const readiness = this.preflight.inspect(normalizedWalletId);
    if (!readiness.ready || readiness.walletId !== normalizedWalletId) {
      throw new MiningIdentityPreparationError(
        'PRODUCT_READINESS_FAILED',
        readiness.reasonCode,
      );
    }

    const configuration = this.configuration.value;
    if (!configuration || this.configuration.snapshot.status !== 'ready') {
      throw new MiningIdentityPreparationError(
        'PRODUCT_CONFIGURATION_UNAVAILABLE',
      );
    }
    if (!validEndpoints(configuration.endpoints)) {
      throw new MiningIdentityPreparationError('ENDPOINTS_INVALID');
    }
    if (!validApplicationId(configuration.appId)) {
      throw new MiningIdentityPreparationError('APP_ID_INVALID');
    }

    const wallet = this.walletRegistry.wallet(normalizedWalletId);
    if (!wallet || !wallet.miningCredentialReference) {
      throw new MiningIdentityPreparationError('WALLET_IDENTITY_UNAVAILABLE');
    }

    const serializedCredential = await this.secureStorage.loadSecureValue(
      wallet.miningCredentialReference,
    );
    if (serializedCredential === null) {
      throw new MiningIdentityPreparationError('SECURE_CREDENTIAL_UNAVAILABLE');
    }

    let credential: ReturnType<typeof parseStoredBeeMiningCredential>;
    try {
      credential = parseStoredBeeMiningCredential(serializedCredential);
    } catch {
      throw new MiningIdentityPreparationError('SECURE_CREDENTIAL_INVALID');
    }

    if (
      !wallet.walletAddress ||
      credential.walletAddress !== wallet.walletAddress
    ) {
      throw new MiningIdentityPreparationError('WALLET_IDENTITY_MISMATCH');
    }
    if (!validMinerAddress(credential.minerAddress)) {
      throw new MiningIdentityPreparationError('MINER_ADDRESS_INVALID');
    }
    if (!validMiningPublicKey(credential.publicKey)) {
      throw new MiningIdentityPreparationError('PUBLIC_KEY_INVALID');
    }

    return immutableValidatedMiningIdentity({
      walletId: normalizedWalletId,
      endpoints: configuration.endpoints,
      appId: configuration.appId,
      minerAddress: credential.minerAddress,
      publicKey: credential.publicKey,
      secretKey: credential.secretKey,
    });
  }
}

export function immutableValidatedMiningIdentity(
  identity: Readonly<ValidatedMiningIdentity>,
): Readonly<ValidatedMiningIdentity> {
  return Object.freeze({
    walletId: identity.walletId,
    endpoints: Object.freeze([...identity.endpoints]),
    appId: identity.appId,
    minerAddress: identity.minerAddress,
    publicKey: identity.publicKey,
    secretKey: identity.secretKey,
  });
}

export function validApplicationId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    /^[a-z0-9][a-z0-9._:-]*$/i.test(value)
  );
}

export function validEndpoints(endpoints: readonly string[]): boolean {
  if (endpoints.length === 0 || new Set(endpoints).size !== endpoints.length) {
    return false;
  }
  return endpoints.every((endpoint) => {
    try {
      const url = new URL(endpoint);
      return (
        endpoint.trim() === endpoint &&
        (url.protocol === 'https:' || url.protocol === 'http:')
      );
    } catch {
      return false;
    }
  });
}

export function validMinerAddress(value: string): boolean {
  return /^-?\d+:[0-9a-f]{64}$/i.test(value);
}

export function validMiningPublicKey(value: string): boolean {
  return /^(?:0x)?[0-9a-f]{64}$/i.test(value);
}
