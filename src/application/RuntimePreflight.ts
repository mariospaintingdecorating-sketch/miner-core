import type { MinerRuntimeStatus } from '../shared/miningRuntime';
import type {
  TapPacingReadiness,
  TapPacingReadinessStatus,
  TapPacingSource,
} from '../mining/product/MiningPacing';
import type {
  BeeMiningSessionSnapshot,
  BeeSdkGatewayContract,
  BeeSdkGatewayStatus,
  BeeWalletConnectionCapability,
} from '../services/bee/contracts';
import type {
  WalletOnboardingStatus,
  WalletRegistryContract,
} from '../shared/wallets';
import type { SecureReferenceStorageContract } from '../storage/contracts';
import type { ProductionConfigurationResolution } from './productionConfiguration';

export type { TapPacingReadiness, TapPacingReadinessStatus };
export type TapPacingReadinessSource = Pick<TapPacingSource, 'readiness'>;

export type MiningPreflightReasonCode =
  | 'ready'
  | 'production-configuration-missing'
  | 'production-configuration-invalid'
  | 'wallet-not-selected'
  | 'wallet-not-found'
  | 'wallet-onboarding-incomplete'
  | 'wallet-connection-reference-missing'
  | 'mining-credential-reference-missing'
  | 'secure-storage-unavailable'
  | 'wallet-connection-state-missing'
  | 'mining-credential-missing'
  | 'mining-credential-propagation-failed'
  | 'runtime-not-idle'
  | 'native-session-conflict'
  | 'tap-pacing-not-configured'
  | 'tap-pacing-unavailable'
  | 'bee-sdk-initialization-failed';

export interface MiningPreflightReadiness {
  readonly configurationStatus: 'ready' | 'missing' | 'invalid';
  readonly beeSdkStatus: BeeSdkGatewayStatus;
  readonly walletOnboardingStatus: WalletOnboardingStatus | null;
  readonly connectionReferencePresent: boolean;
  readonly miningCredentialReferencePresent: boolean;
  readonly secureConnectionStatePresent: boolean | null;
  readonly secureMiningCredentialPresent: boolean | null;
  readonly nativeSessionConflict: boolean;
  readonly nativePreparation: 'deferred-to-core-start';
  readonly tapPacingStatus: TapPacingReadinessStatus;
}

export interface MiningPreflightResult {
  readonly ready: boolean;
  readonly reasonCode: MiningPreflightReasonCode;
  readonly message: string;
  readonly walletId: string | null;
  readonly readiness: Readonly<MiningPreflightReadiness>;
}

export interface ProductionPreflightAssessment {
  readonly result: Readonly<MiningPreflightResult>;
}

interface NativeSessionSource {
  sessionForWallet(walletId: string): Readonly<BeeMiningSessionSnapshot> | null;
}

export class RuntimePreflight {
  readonly #inFlight = new Map<string, Promise<Readonly<ProductionPreflightAssessment>>>();
  readonly #lastResults = new Map<string, Readonly<MiningPreflightResult>>();
  readonly #ownerByWallet = new Map<string, object>();
  #disposed = false;

  constructor(
    private readonly configuration: Readonly<ProductionConfigurationResolution>,
    private readonly gateway: BeeSdkGatewayContract,
    private readonly walletRegistry: Pick<WalletRegistryContract, 'wallet'>,
    private readonly secureStorage: Pick<
      SecureReferenceStorageContract,
      'hasSecureValue'
    > | null,
    private readonly nativeSessions: NativeSessionSource | null,
    private readonly walletConnection: Pick<
      BeeWalletConnectionCapability,
      'verifyMiningCredentialPropagation'
    > | null,
    private readonly tapPacing: TapPacingReadinessSource,
    private readonly runtimeStatus: (walletId: string) => MinerRuntimeStatus,
  ) {}

  assess(
    walletId: string | null,
  ): Promise<Readonly<ProductionPreflightAssessment>> {
    if (this.#disposed) {
      return Promise.reject(new Error('Runtime preflight is disposed.'));
    }

    const key = walletId ?? '<no-wallet>';
    const existing = this.#inFlight.get(key);

    if (existing) {
      return existing;
    }

    const owner = this.#owner(key);
    const assessment = this.#assess(walletId);
    this.#inFlight.set(key, assessment);
    void assessment.then(
      ({ result }) => {
        if (this.#ownerByWallet.get(key) === owner) {
          this.#lastResults.set(key, result);
        }
        if (this.#inFlight.get(key) === assessment) {
          this.#inFlight.delete(key);
        }
      },
      () => {
        if (this.#inFlight.get(key) === assessment) {
          this.#inFlight.delete(key);
        }
      },
    );
    return assessment;
  }

  preview(walletId: string | null): Readonly<MiningPreflightResult> {
    return (
      this.#lastResults.get(walletId ?? '<no-wallet>') ??
      this.#knownResult(walletId)
    );
  }

  /** Current static readiness only; performs no secure, gateway or binding I/O. */
  inspect(walletId: string | null): Readonly<MiningPreflightResult> {
    return this.#knownResult(walletId);
  }

  forgetWallet(walletId: string): void {
    this.#ownerByWallet.delete(walletId);
    this.#lastResults.delete(walletId);
    this.#inFlight.delete(walletId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#ownerByWallet.clear();
    this.#lastResults.clear();
    this.#inFlight.clear();
  }

  #owner(key: string): object {
    const current = this.#ownerByWallet.get(key);
    if (current) return current;
    const owner = Object.freeze({});
    this.#ownerByWallet.set(key, owner);
    return owner;
  }

  async #assess(
    walletId: string | null,
  ): Promise<Readonly<ProductionPreflightAssessment>> {
    const known = this.#knownResult(walletId);

    if (!known.ready) {
      return this.#assessment(known);
    }

    const wallet = this.walletRegistry.wallet(walletId!);
    const connectionReference = wallet!.connectionReference!;
    const credentialReference = wallet!.miningCredentialReference!;
    let connectionStatePresent: boolean;
    let credentialPresent: boolean;

    try {
      [connectionStatePresent, credentialPresent] = await Promise.all([
        this.secureStorage!.hasSecureValue(connectionReference),
        this.secureStorage!.hasSecureValue(credentialReference),
      ]);
    } catch {
      return this.#rejected(
        'secure-storage-unavailable',
        'Secure storage readiness could not be verified.',
        walletId,
        null,
        null,
      );
    }

    if (!connectionStatePresent) {
      return this.#rejected(
        'wallet-connection-state-missing',
        'The selected wallet connection state is not available in secure storage.',
        walletId,
        connectionStatePresent,
        credentialPresent,
      );
    }

    if (!credentialPresent) {
      return this.#rejected(
        'mining-credential-missing',
        'The selected wallet mining credential is not available in secure storage.',
        walletId,
        connectionStatePresent,
        credentialPresent,
      );
    }

    try {
      await this.gateway.initialize();
    } catch {
      return this.#rejected(
        'bee-sdk-initialization-failed',
        'Bee SDK initialization failed. Review diagnostics before retrying.',
        walletId,
        connectionStatePresent,
        credentialPresent,
      );
    }

    if (!this.walletConnection) {
      return this.#rejected(
        'mining-credential-propagation-failed',
        'Mining-key propagation verification is unavailable.',
        walletId,
        connectionStatePresent,
        credentialPresent,
      );
    }

    try {
      await this.walletConnection.verifyMiningCredentialPropagation(
        connectionReference,
        credentialReference,
        2,
        1_000,
      );
    } catch {
      return this.#rejected(
        'mining-credential-propagation-failed',
        'Mining-key propagation could not be confirmed before starting mining.',
        walletId,
        connectionStatePresent,
        credentialPresent,
      );
    }

    const result = this.#result(
      true,
      'ready',
      'Runtime preflight completed. Native session preparation remains a Core start step.',
      walletId,
      connectionStatePresent,
      credentialPresent,
    );

    return this.#assessment(result);
  }

  #knownResult(walletId: string | null): Readonly<MiningPreflightResult> {
    if (this.configuration.snapshot.status !== 'ready') {
      const reasonCode = this.configuration.snapshot.code as
        | 'production-configuration-missing'
        | 'production-configuration-invalid';
      return this.#result(
        false,
        reasonCode,
        this.configuration.snapshot.status === 'missing'
          ? 'Required Bee production configuration is missing.'
          : 'Bee production configuration is invalid.',
        walletId,
      );
    }

    if (!walletId) {
      return this.#result(
        false,
        'wallet-not-selected',
        'Select a wallet explicitly before starting mining.',
        null,
      );
    }

    const wallet = this.walletRegistry.wallet(walletId);

    if (!wallet) {
      return this.#result(
        false,
        'wallet-not-found',
        'The selected wallet is not registered.',
        walletId,
      );
    }

    if (wallet.onboardingStatus !== 'ready') {
      return this.#result(
        false,
        'wallet-onboarding-incomplete',
        'The selected wallet has not completed verified onboarding.',
        walletId,
      );
    }

    if (!wallet.connectionReference) {
      return this.#result(
        false,
        'wallet-connection-reference-missing',
        'The selected wallet has no secure connection reference.',
        walletId,
      );
    }

    if (!wallet.miningCredentialReference) {
      return this.#result(
        false,
        'mining-credential-reference-missing',
        'The selected wallet has no mining credential reference.',
        walletId,
      );
    }

    if (!this.secureStorage) {
      return this.#result(
        false,
        'secure-storage-unavailable',
        'Secure storage is unavailable for production mining.',
        walletId,
      );
    }

    if (this.runtimeStatus(walletId) !== 'idle') {
      return this.#result(
        false,
        'runtime-not-idle',
        'The runtime must be idle before a new start command.',
        walletId,
      );
    }

    if (this.nativeSessions?.sessionForWallet(walletId)) {
      return this.#result(
        false,
        'native-session-conflict',
        'The selected wallet already owns a native Bee session.',
        walletId,
      );
    }

    const pacing = this.tapPacing.readiness();

    if (pacing.status !== 'ready') {
      return this.#result(
        false,
        pacing.status === 'not-configured'
          ? 'tap-pacing-not-configured'
          : 'tap-pacing-unavailable',
        pacing.message,
        walletId,
      );
    }

    return this.#result(
      true,
      'ready',
      'Static production readiness checks passed.',
      walletId,
    );
  }

  #rejected(
    reasonCode: MiningPreflightReasonCode,
    message: string,
    walletId: string | null,
    secureConnectionStatePresent: boolean | null,
    secureMiningCredentialPresent: boolean | null,
  ): Readonly<ProductionPreflightAssessment> {
    return this.#assessment(
      this.#result(
        false,
        reasonCode,
        message,
        walletId,
        secureConnectionStatePresent,
        secureMiningCredentialPresent,
      ),
    );
  }

  #assessment(
    result: Readonly<MiningPreflightResult>,
  ): Readonly<ProductionPreflightAssessment> {
    return Object.freeze({ result });
  }

  #result(
    ready: boolean,
    reasonCode: MiningPreflightReasonCode,
    message: string,
    walletId: string | null,
    secureConnectionStatePresent: boolean | null = null,
    secureMiningCredentialPresent: boolean | null = null,
  ): Readonly<MiningPreflightResult> {
    const wallet = walletId ? this.walletRegistry.wallet(walletId) : null;
    const pacing = this.tapPacing.readiness();

    return Object.freeze({
      ready,
      reasonCode,
      message,
      walletId,
      readiness: Object.freeze({
        configurationStatus: this.configuration.snapshot.status,
        beeSdkStatus: this.gateway.readiness().status,
        walletOnboardingStatus: wallet?.onboardingStatus ?? null,
        connectionReferencePresent: Boolean(wallet?.connectionReference),
        miningCredentialReferencePresent: Boolean(
          wallet?.miningCredentialReference,
        ),
        secureConnectionStatePresent,
        secureMiningCredentialPresent,
        nativeSessionConflict: Boolean(
          walletId && this.nativeSessions?.sessionForWallet(walletId),
        ),
        nativePreparation: 'deferred-to-core-start',
        tapPacingStatus: pacing.status,
      }),
    });
  }
}
