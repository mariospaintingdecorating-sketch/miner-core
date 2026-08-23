import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimePreflight } from '../../application/RuntimePreflight';
import {
  resolveProductionConfiguration,
  type ProductionConfigurationResolution,
} from '../../application/productionConfiguration';
import type { WalletSnapshot } from '../../shared/wallets';
import type { ValidatedMiningIdentity } from '../WalletMiningRuntime';
import {
  inspectWalletMiningRuntimeConstructibility,
  type WalletMiningRuntimeConstructibilityInspector,
} from '../composition/WalletMiningRuntimeConstructibility';
import {
  ProductMiningIdentityAdapter,
  type MiningIdentitySource,
} from './MiningIdentityAdapter';
import {
  ShadowMiningPreflight,
  type ShadowMiningPreflightDiagnosticSink,
  type ShadowMiningPreflightResult,
} from './ShadowMiningPreflight';

const WALLET_ID = 'wallet-a';
const WALLET_ADDRESS = `0:${'11'.repeat(32)}`;
const OTHER_WALLET_ADDRESS = `0:${'22'.repeat(32)}`;
const MINER_ADDRESS = `0:${'ab'.repeat(32)}`;
const PUBLIC_KEY = 'cd'.repeat(32);
const SECRET_KEY = 'synthetic-shadow-secret-never-report';
const CHECKED_AT = '2026-08-12T12:00:00.000Z';
const READY_CONFIGURATION = resolveProductionConfiguration({
  endpoints: Object.freeze([
    'https://synthetic-node-a.invalid',
    'https://synthetic-node-b.invalid',
  ]),
  appId: 'synthetic-shadow-app-id',
});

interface HarnessOptions {
  readonly walletId?: string;
  readonly readinessReady?: boolean;
  readonly readinessReason?: string;
  readonly configuration?: Readonly<ProductionConfigurationResolution>;
  readonly registeredWallet?: Readonly<WalletSnapshot> | null;
  readonly credential?: string | null;
  readonly credentialFields?: Readonly<Record<string, unknown>>;
  readonly constructible?: boolean;
  readonly diagnosticFailure?: boolean;
}

function wallet(
  walletId = WALLET_ID,
  fields: Partial<WalletSnapshot> = {},
): Readonly<WalletSnapshot> {
  return Object.freeze({
    id: walletId,
    name: `Wallet ${walletId}`,
    status: 'idle',
    walletAddress: WALLET_ADDRESS,
    onboardingStatus: 'ready',
    connectionReference: `connection:${walletId}`,
    miningCredentialReference: `credential:${walletId}`,
    mamaBoardLevel: null,
    session: null,
    ...fields,
  });
}

function credential(
  fields: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    version: 1,
    walletName: `Wallet ${WALLET_ID}`,
    walletAddress: WALLET_ADDRESS,
    minerAddress: MINER_ADDRESS,
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
    ...fields,
  });
}

function invalidEndpointConfiguration(): Readonly<ProductionConfigurationResolution> {
  return Object.freeze({
    snapshot: Object.freeze({
      status: 'ready' as const,
      code: 'production-configuration-ready' as const,
      endpointCount: 1,
      appIdConfigured: true,
      maximumSessionDurationMs: 135_000,
    }),
    value: Object.freeze({
      endpoints: Object.freeze(['ftp://synthetic-node.invalid']),
      canonicalEndpoint: 'https://synthetic-node.invalid',
      mamaBoardEndpoint: 'https://synthetic-node.invalid',
      appId: 'synthetic-shadow-app-id',
      maximumSessionDurationMs: 135_000,
      apiUrl: 'https://synthetic-api.invalid',
    }),
  });
}

function createHarness(options: HarnessOptions = {}) {
  const walletId = options.walletId ?? WALLET_ID;
  const readinessReady = options.readinessReady ?? true;
  const preflight = {
    inspect: vi.fn((requestedWalletId: string | null) => Object.freeze({
      ready: readinessReady,
      walletId: requestedWalletId,
      reasonCode: readinessReady
        ? 'ready'
        : options.readinessReason ?? 'runtime-not-idle',
    })),
  } as unknown as Pick<RuntimePreflight, 'inspect'>;
  const registeredWallet = options.registeredWallet === undefined
    ? wallet(walletId)
    : options.registeredWallet;
  const walletRead = vi.fn(() => registeredWallet);
  const secureRead = vi.fn(async () =>
    options.credential !== undefined
      ? options.credential
      : credential(options.credentialFields),
  );
  const identity = new ProductMiningIdentityAdapter(
    preflight,
    options.configuration ?? READY_CONFIGURATION,
    { wallet: walletRead },
    { loadSecureValue: secureRead },
  );
  const inspect = vi.fn(() => Object.freeze({
    constructible: options.constructible ?? true,
  }));
  const constructibility: WalletMiningRuntimeConstructibilityInspector = {
    inspect,
  };
  const diagnostics: Readonly<ShadowMiningPreflightResult>[] = [];
  const diagnosticSink: ShadowMiningPreflightDiagnosticSink = {
    record: vi.fn((result) => {
      if (options.diagnosticFailure) {
        throw new Error('Synthetic diagnostic sink failure.');
      }
      diagnostics.push(result);
    }),
  };
  const shadow = new ShadowMiningPreflight(
    identity,
    constructibility,
    diagnosticSink,
    () => CHECKED_AT,
  );
  return {
    shadow,
    preflight,
    walletRead,
    secureRead,
    inspect,
    diagnostics,
    diagnosticSink,
  };
}

function blockerCode(result: Readonly<ShadowMiningPreflightResult>): string | null {
  return result.blockers[0]?.code ?? null;
}

function readyIdentity(walletId = WALLET_ID): Readonly<ValidatedMiningIdentity> {
  return Object.freeze({
    walletId,
    endpoints: Object.freeze(['https://synthetic-node.invalid']),
    appId: 'synthetic-shadow-app-id',
    minerAddress: MINER_ADDRESS,
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
  });
}

describe('read-only shadow mining preflight', () => {
  it('returns READY only after every check passes', async () => {
    const result = await createHarness().shadow.check(WALLET_ID);
    expect(result.status).toBe('READY');
    expect(result.blockers).toEqual([]);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });

  it('returns an immutable result, checks and blocker collection', async () => {
    const result = await createHarness().shadow.check(WALLET_ID);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.checks)).toBe(true);
    expect(Object.isFrozen(result.blockers)).toBe(true);
  });

  it('never exposes the secure secret in the result', async () => {
    const result = await createHarness().shadow.check(WALLET_ID);
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(result)).not.toContain('secretKey');
  });

  it('publishes only the safe result to diagnostics', async () => {
    const context = createHarness();
    const result = await context.shadow.check(WALLET_ID);
    expect(context.diagnostics).toEqual([result]);
    expect(JSON.stringify(context.diagnostics)).not.toContain(SECRET_KEY);
  });

  it('blocks an unregistered wallet reported by product readiness', async () => {
    const result = await createHarness({
      readinessReady: false,
      readinessReason: 'wallet-not-found',
    }).shadow.check(WALLET_ID);
    expect(result.status).toBe('BLOCKED');
    expect(blockerCode(result)).toBe('WALLET_NOT_REGISTERED');
    expect(result.checks.walletRegistered).toBe(false);
  });

  it('blocks a generic current-product readiness failure', async () => {
    const result = await createHarness({
      readinessReady: false,
      readinessReason: 'runtime-not-idle',
    }).shadow.check(WALLET_ID);
    expect(result.status).toBe('BLOCKED');
    expect(blockerCode(result)).toBe('PRODUCT_READINESS_BLOCKED');
    expect(result.blockers[0]?.check).toBe('validatedIdentityCreated');
    expect(result.checks.validatedIdentityCreated).toBe(false);
  });

  it('blocks missing production configuration', async () => {
    const result = await createHarness({
      configuration: resolveProductionConfiguration(undefined),
    }).shadow.check(WALLET_ID);
    expect(blockerCode(result)).toBe('CONFIGURATION_NOT_READY');
    expect(result.checks.configurationReady).toBe(false);
  });

  it('blocks an endpoint that is not HTTP or HTTPS', async () => {
    const result = await createHarness({
      configuration: invalidEndpointConfiguration(),
    }).shadow.check(WALLET_ID);
    expect(blockerCode(result)).toBe('ENDPOINTS_INVALID');
    expect(result.checks.configurationReady).toBe(true);
    expect(result.checks.endpointsValid).toBe(false);
  });

  it('blocks a syntactically invalid APP_ID', async () => {
    const result = await createHarness({
      configuration: resolveProductionConfiguration({
        endpoints: ['https://synthetic-node.invalid'],
        appId: 'invalid app id',
      }),
    }).shadow.check(WALLET_ID);
    expect(blockerCode(result)).toBe('APP_ID_INVALID');
    expect(result.checks.endpointsValid).toBe(true);
    expect(result.checks.appIdValid).toBe(false);
  });

  it('blocks a missing mining credential reference', async () => {
    const result = await createHarness({
      readinessReady: false,
      readinessReason: 'mining-credential-reference-missing',
    }).shadow.check(WALLET_ID);
    expect(blockerCode(result)).toBe('CREDENTIAL_REFERENCE_MISSING');
    expect(result.checks.walletRegistered).toBe(true);
    expect(result.checks.credentialReferencePresent).toBe(false);
  });

  it('blocks an unavailable secure credential', async () => {
    const result = await createHarness({ credential: null }).shadow.check(WALLET_ID);
    expect(blockerCode(result)).toBe('CREDENTIAL_UNAVAILABLE');
    expect(result.checks.credentialAvailable).toBe(false);
  });

  it('blocks a secure credential parse failure', async () => {
    const result = await createHarness({ credential: '{not-json' }).shadow.check(
      WALLET_ID,
    );
    expect(blockerCode(result)).toBe('CREDENTIAL_INVALID');
    expect(result.checks.credentialParsed).toBe(false);
  });

  it('blocks a credential-to-wallet identity mismatch', async () => {
    const result = await createHarness({
      credentialFields: { walletAddress: OTHER_WALLET_ADDRESS },
    }).shadow.check(WALLET_ID);
    expect(blockerCode(result)).toBe('WALLET_IDENTITY_MISMATCH');
    expect(result.checks.walletIdentityMatches).toBe(false);
  });

  it('blocks a registry wallet without a canonical wallet address', async () => {
    const result = await createHarness({
      registeredWallet: wallet(WALLET_ID, { walletAddress: null }),
    }).shadow.check(WALLET_ID);
    expect(blockerCode(result)).toBe('WALLET_IDENTITY_MISMATCH');
  });

  it('blocks an invalid miner address', async () => {
    const result = await createHarness({
      credentialFields: { minerAddress: 'not-a-miner-address' },
    }).shadow.check(WALLET_ID);
    expect(blockerCode(result)).toBe('MINER_ADDRESS_INVALID');
    expect(result.checks.minerAddressValid).toBe(false);
  });

  it('blocks an invalid mining public key', async () => {
    const result = await createHarness({
      credentialFields: { publicKey: 'not-a-public-key' },
    }).shadow.check(WALLET_ID);
    expect(blockerCode(result)).toBe('PUBLIC_KEY_INVALID');
    expect(result.checks.publicKeyValid).toBe(false);
  });

  it('uses the onboarding-ready product state as the mining-key verification gate', async () => {
    const context = createHarness();
    const result = await context.shadow.check(WALLET_ID);
    expect(result.status).toBe('READY');
    expect(result.checks.keyBindingVerified).toBe(true);
    expect(context.secureRead).toHaveBeenCalledOnce();
  });

  it('blocks when the pure runtime inspector rejects constructibility', async () => {
    const result = await createHarness({ constructible: false }).shadow.check(
      WALLET_ID,
    );
    expect(result.status).toBe('BLOCKED');
    expect(blockerCode(result)).toBe('RUNTIME_NOT_CONSTRUCTIBLE');
    expect(result.checks.validatedIdentityCreated).toBe(true);
    expect(result.checks.newRuntimeConstructible).toBe(false);
  });

  it('returns ERROR for an unknown identity-source failure', async () => {
    const source: MiningIdentitySource = {
      resolve: vi.fn(async () => {
        throw new Error('unknown synthetic failure');
      }),
    };
    const result = await new ShadowMiningPreflight(
      source,
      { inspect: vi.fn() },
      undefined,
      () => CHECKED_AT,
    ).check(WALLET_ID);
    expect(result.status).toBe('ERROR');
    expect(blockerCode(result)).toBe('SHADOW_PREFLIGHT_ERROR');
  });

  it('blocks an empty wallet identity without touching secure storage', async () => {
    const context = createHarness();
    const result = await context.shadow.check('   ');
    expect(blockerCode(result)).toBe('WALLET_NOT_REGISTERED');
    expect(context.preflight.inspect).not.toHaveBeenCalled();
    expect(context.secureRead).not.toHaveBeenCalled();
  });

  it('does not reserve ownership across repeated sequential checks', async () => {
    const context = createHarness();
    expect((await context.shadow.check(WALLET_ID)).status).toBe('READY');
    expect((await context.shadow.check(WALLET_ID)).status).toBe('READY');
    expect(context.preflight.inspect).toHaveBeenCalledTimes(2);
    expect(context.inspect).toHaveBeenCalledTimes(2);
  });

  it('deduplicates simultaneous checks for the same wallet', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source: MiningIdentitySource = {
      resolve: vi.fn(async () => {
        await gate;
        return readyIdentity();
      }),
    };
    const inspect = vi.fn(() => ({ constructible: true }));
    const shadow = new ShadowMiningPreflight(source, { inspect });
    const first = shadow.check(WALLET_ID);
    const second = shadow.check(WALLET_ID);
    expect(first).toBe(second);
    release();
    await Promise.all([first, second]);
    expect(source.resolve).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('isolates simultaneous checks for two wallets', async () => {
    const source: MiningIdentitySource = {
      resolve: vi.fn(async (walletId) => readyIdentity(walletId)),
    };
    const inspect = vi.fn(() => ({ constructible: true }));
    const shadow = new ShadowMiningPreflight(source, { inspect });
    const [walletA, walletB] = await Promise.all([
      shadow.check('wallet-a'),
      shadow.check('wallet-b'),
    ]);
    expect(walletA.walletId).toBe('wallet-a');
    expect(walletB.walletId).toBe('wallet-b');
    expect(source.resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps one wallet failure isolated from another wallet readiness', async () => {
    const source: MiningIdentitySource = {
      resolve: vi.fn(async (walletId) => {
        if (walletId === 'wallet-a') throw new Error('wallet-a failed');
        return readyIdentity(walletId);
      }),
    };
    const shadow = new ShadowMiningPreflight(source, {
      inspect: () => ({ constructible: true }),
    });
    const [walletA, walletB] = await Promise.all([
      shadow.check('wallet-a'),
      shadow.check('wallet-b'),
    ]);
    expect(walletA.status).toBe('ERROR');
    expect(walletB.status).toBe('READY');
  });

  it('does not let diagnostic persistence failure alter readiness', async () => {
    const context = createHarness({ diagnosticFailure: true });
    const result = await context.shadow.check(WALLET_ID);
    expect(result.status).toBe('READY');
    expect(context.diagnosticSink.record).toHaveBeenCalledTimes(1);
  });

  it('uses the injected clock for a stable checkedAt value', async () => {
    const result = await createHarness().shadow.check(WALLET_ID);
    expect(result.checkedAt).toBe(CHECKED_AT);
  });

  it('reads the secure credential exactly once per check', async () => {
    const context = createHarness();
    await context.shadow.check(WALLET_ID);
    expect(context.secureRead).toHaveBeenCalledTimes(1);
    expect(context.secureRead).toHaveBeenCalledWith(`credential:${WALLET_ID}`);
  });

  it('performs no mining-key propagation network lookup during a check', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./MiningIdentityAdapter.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/ensureMiningKeysPropagated|ensure_mining_keys_propagated/);
  });

  it('contains no worker, Bee adapter or native lifecycle dependency', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./ShadowMiningPreflight.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(
      /WalletMiningWorker|BeeMiningNativeAdapter|MiningNativeAdapter|Miner\.new|can_start|addTap|get_reward|\.free\(/,
    );
  });

  it('accepts a complete validated identity in the pure factory inspector', () => {
    expect(inspectWalletMiningRuntimeConstructibility(readyIdentity())).toEqual({
      constructible: true,
    });
  });

  it('rejects an incomplete identity in the pure factory inspector', () => {
    expect(inspectWalletMiningRuntimeConstructibility({
      ...readyIdentity(),
      endpoints: Object.freeze([]),
    })).toEqual({ constructible: false });
  });
});
