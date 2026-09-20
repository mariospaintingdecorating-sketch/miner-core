import type { WalletMiningRuntimeConstructibilityInspector } from '../composition/WalletMiningRuntimeConstructibility';
import {
  MiningIdentityPreparationError,
  type MiningIdentityPreparationFailureCode,
  type MiningIdentitySource,
} from './MiningIdentityAdapter';

export type ShadowMiningPreflightStatus = 'READY' | 'BLOCKED' | 'ERROR';

export interface ShadowMiningPreflightChecks {
  readonly configurationReady: boolean;
  readonly endpointsValid: boolean;
  readonly appIdValid: boolean;
  readonly walletRegistered: boolean;
  readonly credentialReferencePresent: boolean;
  readonly credentialAvailable: boolean;
  readonly credentialParsed: boolean;
  readonly walletIdentityMatches: boolean;
  readonly minerAddressValid: boolean;
  readonly publicKeyValid: boolean;
  readonly keyBindingVerified: boolean;
  readonly validatedIdentityCreated: boolean;
  readonly newRuntimeConstructible: boolean;
}

export type ShadowMiningPreflightBlockerCode =
  | 'WALLET_NOT_REGISTERED'
  | 'PRODUCT_READINESS_BLOCKED'
  | 'CONFIGURATION_NOT_READY'
  | 'ENDPOINTS_INVALID'
  | 'APP_ID_INVALID'
  | 'CREDENTIAL_REFERENCE_MISSING'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'WALLET_IDENTITY_MISMATCH'
  | 'MINER_ADDRESS_INVALID'
  | 'PUBLIC_KEY_INVALID'
  | 'RUNTIME_NOT_CONSTRUCTIBLE'
  | 'SHADOW_PREFLIGHT_ERROR'
  | 'AUTHORIZATION_CONTEXT_UNVERIFIED';

export interface ShadowMiningPreflightBlocker {
  readonly code: ShadowMiningPreflightBlockerCode;
  readonly check: keyof ShadowMiningPreflightChecks;
  readonly message: string;
}

export interface ShadowMiningPreflightResult {
  readonly walletId: string;
  readonly status: ShadowMiningPreflightStatus;
  readonly checkedAt: string;
  readonly checks: Readonly<ShadowMiningPreflightChecks>;
  readonly blockers: readonly Readonly<ShadowMiningPreflightBlocker>[];
}

export interface ShadowMiningPreflightCapability {
  check(walletId: string): Promise<Readonly<ShadowMiningPreflightResult>>;
}

export interface ShadowMiningPreflightDiagnosticSink {
  record(result: Readonly<ShadowMiningPreflightResult>): void;
}

const NOOP_SHADOW_DIAGNOSTICS: ShadowMiningPreflightDiagnosticSink =
  Object.freeze({ record: () => undefined });

/** Identity inspection plus pure factory validation; never constructs a worker. */
export class ShadowMiningPreflight implements ShadowMiningPreflightCapability {
  readonly #inFlight = new Map<
    string,
    Promise<Readonly<ShadowMiningPreflightResult>>
  >();

  constructor(
    private readonly identity: MiningIdentitySource,
    private readonly constructibility: WalletMiningRuntimeConstructibilityInspector,
    private readonly diagnostics: ShadowMiningPreflightDiagnosticSink =
      NOOP_SHADOW_DIAGNOSTICS,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  check(walletId: string): Promise<Readonly<ShadowMiningPreflightResult>> {
    const normalizedWalletId = walletId.trim();
    const existing = this.#inFlight.get(normalizedWalletId);
    if (existing) return existing;
    const operation = this.#check(normalizedWalletId);
    this.#inFlight.set(normalizedWalletId, operation);
    void operation.finally(() => {
      if (this.#inFlight.get(normalizedWalletId) === operation) {
        this.#inFlight.delete(normalizedWalletId);
      }
    }).catch(() => undefined);
    return operation;
  }

  async #check(
    walletId: string,
  ): Promise<Readonly<ShadowMiningPreflightResult>> {
    try {
      const identity = await this.identity.resolve(walletId);
      const construction = this.constructibility.inspect(identity);
      if (!construction.constructible) {
        return this.#publish(result(
          walletId,
          'BLOCKED',
          this.now(),
          checksThrough('validatedIdentityCreated'),
          blocker('RUNTIME_NOT_CONSTRUCTIBLE'),
        ));
      }
      return this.#publish(result(
        walletId,
        'READY',
        this.now(),
        readyChecks(),
        null,
      ));
    } catch (error) {
      if (error instanceof MiningIdentityPreparationError) {
        const mapped = mappedFailure(error);
        return this.#publish(result(
          walletId,
          mapped.status,
          this.now(),
          mapped.checks,
          blocker(mapped.blocker),
        ));
      }
      return this.#publish(result(
        walletId,
        'ERROR',
        this.now(),
        emptyChecks(),
        blocker('SHADOW_PREFLIGHT_ERROR'),
      ));
    }
  }

  #publish(
    value: Readonly<ShadowMiningPreflightResult>,
  ): Readonly<ShadowMiningPreflightResult> {
    try {
      this.diagnostics.record(value);
    } catch {
      // Readiness diagnostics cannot control the shadow result.
    }
    return value;
  }
}

function mappedFailure(error: MiningIdentityPreparationError): Readonly<{
  status: Exclude<ShadowMiningPreflightStatus, 'READY'>;
  blocker: ShadowMiningPreflightBlockerCode;
  checks: Readonly<ShadowMiningPreflightChecks>;
}> {
  if (error.code === 'PRODUCT_READINESS_FAILED') {
    return mapProductReadinessFailure(error.productReasonCode);
  }
  const mapping: Record<
    Exclude<MiningIdentityPreparationFailureCode, 'PRODUCT_READINESS_FAILED'>,
    readonly [
      Exclude<ShadowMiningPreflightStatus, 'READY'>,
      ShadowMiningPreflightBlockerCode,
      keyof ShadowMiningPreflightChecks | null,
    ]
  > = {
    PRODUCT_CONFIGURATION_UNAVAILABLE: [
      'BLOCKED', 'CONFIGURATION_NOT_READY', null,
    ],
    APP_ID_INVALID: ['BLOCKED', 'APP_ID_INVALID', 'endpointsValid'],
    ENDPOINTS_INVALID: ['BLOCKED', 'ENDPOINTS_INVALID', 'configurationReady'],
    WALLET_IDENTITY_UNAVAILABLE: [
      'BLOCKED', 'WALLET_NOT_REGISTERED', null,
    ],
    SECURE_CREDENTIAL_UNAVAILABLE: [
      'BLOCKED', 'CREDENTIAL_UNAVAILABLE', 'credentialReferencePresent',
    ],
    SECURE_CREDENTIAL_INVALID: [
      'BLOCKED', 'CREDENTIAL_INVALID', 'credentialAvailable',
    ],
    WALLET_IDENTITY_MISMATCH: [
      'BLOCKED', 'WALLET_IDENTITY_MISMATCH', 'credentialParsed',
    ],
    MINER_ADDRESS_INVALID: [
      'BLOCKED', 'MINER_ADDRESS_INVALID', 'walletIdentityMatches',
    ],
    PUBLIC_KEY_INVALID: [
      'BLOCKED', 'PUBLIC_KEY_INVALID', 'minerAddressValid',
    ],
    MINING_AUTHORIZATION_CONTEXT_UNVERIFIED: [
      'BLOCKED', 'AUTHORIZATION_CONTEXT_UNVERIFIED', 'publicKeyValid',
    ],
  };
  const [status, blockerCode, through] = mapping[error.code];
  return Object.freeze({
    status,
    blocker: blockerCode,
    checks: through ? checksThrough(through) : emptyChecks(),
  });
}

function mapProductReadinessFailure(reason: string | null): Readonly<{
  status: 'BLOCKED';
  blocker: ShadowMiningPreflightBlockerCode;
  checks: Readonly<ShadowMiningPreflightChecks>;
}> {
  if (reason === 'wallet-not-found' || reason === 'wallet-not-selected') {
    return Object.freeze({
      status: 'BLOCKED',
      blocker: 'WALLET_NOT_REGISTERED',
      checks: checksThrough('appIdValid'),
    });
  }
  if (
    reason === 'production-configuration-missing' ||
    reason === 'production-configuration-invalid'
  ) {
    return Object.freeze({
      status: 'BLOCKED',
      blocker: 'CONFIGURATION_NOT_READY',
      checks: emptyChecks(),
    });
  }
  if (reason === 'mining-credential-reference-missing') {
    return Object.freeze({
      status: 'BLOCKED',
      blocker: 'CREDENTIAL_REFERENCE_MISSING',
      checks: checksThrough('walletRegistered'),
    });
  }
  if (reason === 'mining-credential-missing') {
    return Object.freeze({
      status: 'BLOCKED',
      blocker: 'CREDENTIAL_UNAVAILABLE',
      checks: checksThrough('credentialReferencePresent'),
    });
  }
  if (reason === 'secure-storage-unavailable') {
    return Object.freeze({
      status: 'BLOCKED',
      blocker: 'CREDENTIAL_UNAVAILABLE',
      checks: checksThrough('credentialReferencePresent'),
    });
  }
  return Object.freeze({
    status: 'BLOCKED',
    blocker: 'PRODUCT_READINESS_BLOCKED',
    checks: checksThrough('walletRegistered'),
  });
}

function result(
  walletId: string,
  status: ShadowMiningPreflightStatus,
  checkedAt: string,
  checks: Readonly<ShadowMiningPreflightChecks>,
  failure: Readonly<ShadowMiningPreflightBlocker> | null,
): Readonly<ShadowMiningPreflightResult> {
  return Object.freeze({
    walletId,
    status,
    checkedAt,
    checks,
    blockers: Object.freeze(failure ? [failure] : []),
  });
}

function blocker(
  code: ShadowMiningPreflightBlockerCode,
): Readonly<ShadowMiningPreflightBlocker> {
  const definitions: Record<
    ShadowMiningPreflightBlockerCode,
    readonly [keyof ShadowMiningPreflightChecks, string]
  > = {
    WALLET_NOT_REGISTERED: ['walletRegistered', 'Wallet is not registered.'],
    PRODUCT_READINESS_BLOCKED: [
      'validatedIdentityCreated', 'Current product readiness is blocked.',
    ],
    CONFIGURATION_NOT_READY: [
      'configurationReady', 'Production configuration is not ready.',
    ],
    ENDPOINTS_INVALID: ['endpointsValid', 'Bee endpoints are invalid.'],
    APP_ID_INVALID: ['appIdValid', 'Application ID is invalid.'],
    CREDENTIAL_REFERENCE_MISSING: [
      'credentialReferencePresent', 'Mining credential reference is missing.',
    ],
    CREDENTIAL_UNAVAILABLE: [
      'credentialAvailable', 'Mining credential is unavailable.',
    ],
    CREDENTIAL_INVALID: [
      'credentialParsed', 'Mining credential could not be parsed.',
    ],
    WALLET_IDENTITY_MISMATCH: [
      'walletIdentityMatches', 'Wallet identity does not match the credential.',
    ],
    MINER_ADDRESS_INVALID: [
      'minerAddressValid', 'Miner address is invalid.',
    ],
    PUBLIC_KEY_INVALID: ['publicKeyValid', 'Mining public key is invalid.'],
    RUNTIME_NOT_CONSTRUCTIBLE: [
      'newRuntimeConstructible', 'New runtime dependencies are not constructible.',
    ],
    AUTHORIZATION_CONTEXT_UNVERIFIED: [
      'keyBindingVerified', 'Verify mining-key propagation for the current DApp before mining.',
    ],
    SHADOW_PREFLIGHT_ERROR: [
      'newRuntimeConstructible', 'Shadow preflight could not be completed.',
    ],
  };
  const [check, message] = definitions[code];
  return Object.freeze({ code, check, message });
}

function readyChecks(): Readonly<ShadowMiningPreflightChecks> {
  return Object.freeze({
    configurationReady: true,
    endpointsValid: true,
    appIdValid: true,
    walletRegistered: true,
    credentialReferencePresent: true,
    credentialAvailable: true,
    credentialParsed: true,
    walletIdentityMatches: true,
    minerAddressValid: true,
    publicKeyValid: true,
    keyBindingVerified: true,
    validatedIdentityCreated: true,
    newRuntimeConstructible: true,
  });
}

function emptyChecks(): Readonly<ShadowMiningPreflightChecks> {
  return Object.freeze({
    configurationReady: false,
    endpointsValid: false,
    appIdValid: false,
    walletRegistered: false,
    credentialReferencePresent: false,
    credentialAvailable: false,
    credentialParsed: false,
    walletIdentityMatches: false,
    minerAddressValid: false,
    publicKeyValid: false,
    keyBindingVerified: false,
    validatedIdentityCreated: false,
    newRuntimeConstructible: false,
  });
}

function checksThrough(
  last: keyof ShadowMiningPreflightChecks,
): Readonly<ShadowMiningPreflightChecks> {
  const checks: Record<keyof ShadowMiningPreflightChecks, boolean> = {
    ...emptyChecks(),
  };
  for (const key of Object.keys(checks) as (keyof ShadowMiningPreflightChecks)[]) {
    checks[key] = true;
    if (key === last) break;
  }
  return Object.freeze(checks);
}
