import { miningAuthorizationContext } from '../../shared/chainIdentity';
import { describe, expect, it, vi } from 'vitest';
import type {
  CanonicalChainStateProvider,
  CanonicalChainStateSnapshot,
} from '../../application/CanonicalChainState';
import type { RuntimePreflight } from '../../application/RuntimePreflight';
import { resolveProductionConfiguration } from '../../application/productionConfiguration';
import type { WalletSnapshot } from '../../shared/wallets';
import type { WalletMiningDiagnosticEvent } from '../WalletMiningRuntime';
import { MiningDiagnosticRecorder } from '../testing/DeterministicMiningFakes';
import { ProductCanonicalMiniEpochAdapter } from './CanonicalMiniEpochAdapter';
import { IsolatedMiningDiagnosticSink } from './IsolatedMiningDiagnosticSink';
import {
  MiningIdentityPreparationError,
  ProductMiningIdentityAdapter,
} from './MiningIdentityAdapter';

const CONFIGURATION = resolveProductionConfiguration({
  endpoints: [
    'https://synthetic-node-a.invalid',
    'https://synthetic-node-b.invalid',
  ],
  appId: 'synthetic-product-app-id',
});
const SYNTHETIC_SECRET = 'synthetic-secret-boundary-only';
const SYNTHETIC_MINER_ADDRESS = `0:${'ab'.repeat(32)}`;
const SYNTHETIC_PUBLIC_KEY = 'cd'.repeat(32);

function wallet(walletId = 'wallet-a'): Readonly<WalletSnapshot> {
  return Object.freeze({
    id: walletId,
    name: `canonical-${walletId}`,
    status: 'idle',
    walletAddress: `0:${walletId}-address`,
    onboardingStatus: 'ready',
    connectionReference: `connection:${walletId}`,
    miningCredentialReference: `credential:${walletId}`,
    mamaBoardLevel: null,
    session: null,
  });
}

function serializedCredential(walletId = 'wallet-a'): string {
  return JSON.stringify({
    version: 1,
    authorizationContext: miningAuthorizationContext(CONFIGURATION.value!),
    walletName: `canonical-${walletId}`,
    walletAddress: `0:${walletId}-address`,
    minerAddress: SYNTHETIC_MINER_ADDRESS,
    publicKey: SYNTHETIC_PUBLIC_KEY,
    secretKey: SYNTHETIC_SECRET,
  });
}

function identityFixture(input: Readonly<{
  ready?: boolean;
  credential?: string | null;
  registeredWallet?: Readonly<WalletSnapshot> | null;
}> = {}) {
  const order: string[] = [];
  const loadSecureValue = vi.fn(async () => {
    order.push('secure-read');
    return input.credential === undefined
      ? serializedCredential()
      : input.credential;
  });
  const preflight = {
    inspect: vi.fn((walletId: string | null) => {
      order.push('preflight');
      const ready = input.ready ?? true;
      return {
        ready,
        walletId,
        reasonCode: ready ? 'ready' : 'runtime-not-idle',
      };
    }),
  } as unknown as Pick<RuntimePreflight, 'inspect'>;
  const registeredWallet = input.registeredWallet === undefined
    ? wallet()
    : input.registeredWallet;
  const adapter = new ProductMiningIdentityAdapter(
    preflight,
    CONFIGURATION,
    { wallet: () => registeredWallet },
    { loadSecureValue },
  );
  return {
    adapter,
    loadSecureValue,
    order,
    preflight,
  };
}

describe('ProductMiningIdentityAdapter', () => {
  it('maps exactly one immutable validated identity from current product sources', async () => {
    const context = identityFixture();
    const identity = await context.adapter.resolve('wallet-a');
    expect(identity).toEqual({
      walletId: 'wallet-a',
      endpoints: [
        'https://synthetic-node-a.invalid',
        'https://synthetic-node-b.invalid',
      ],
      appId: 'synthetic-product-app-id',
      minerAddress: SYNTHETIC_MINER_ADDRESS,
      publicKey: SYNTHETIC_PUBLIC_KEY,
      secretKey: SYNTHETIC_SECRET,
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.endpoints)).toBe(true);
  });

  it('preserves configured endpoints unchanged', async () => {
    const identity = await identityFixture().adapter.resolve('wallet-a');
    expect(identity.endpoints).toEqual(CONFIGURATION.value?.endpoints);
  });

  it('preserves configured APP_ID unchanged', async () => {
    const identity = await identityFixture().adapter.resolve('wallet-a');
    expect(identity.appId).toBe(CONFIGURATION.value?.appId);
  });

  it('uses minerAddress from the secure credential rather than walletId', async () => {
    const identity = await identityFixture().adapter.resolve('wallet-a');
    expect(identity.minerAddress).toBe(SYNTHETIC_MINER_ADDRESS);
    expect(identity.minerAddress).not.toBe(identity.walletId);
  });

  it('preserves the synthetic public key unchanged', async () => {
    const identity = await identityFixture().adapter.resolve('wallet-a');
    expect(identity.publicKey).toBe(SYNTHETIC_PUBLIC_KEY);
  });

  it('reads the secure credential exactly once at the identity boundary', async () => {
    const context = identityFixture();
    await context.adapter.resolve('wallet-a');
    expect(context.loadSecureValue).toHaveBeenCalledTimes(1);
    expect(context.loadSecureValue).toHaveBeenCalledWith('credential:wallet-a');
    expect(context.order).toEqual(['preflight', 'secure-read']);
  });

  it('prevents identity creation before secure access when readiness fails', async () => {
    const context = identityFixture({ ready: false });
    await expect(context.adapter.resolve('wallet-a')).rejects.toMatchObject({
      code: 'PRODUCT_READINESS_FAILED',
    });
    expect(context.loadSecureValue).not.toHaveBeenCalled();
  });

  it('rejects a missing secure credential without exposing its reference value', async () => {
    const context = identityFixture({ credential: null });
    await expect(context.adapter.resolve('wallet-a')).rejects.toEqual(
      new MiningIdentityPreparationError('SECURE_CREDENTIAL_UNAVAILABLE'),
    );
  });

  it('rejects an invalid secure credential without returning parsed fields', async () => {
    const context = identityFixture({ credential: '{"version":2}' });
    await expect(context.adapter.resolve('wallet-a')).rejects.toMatchObject({
      code: 'SECURE_CREDENTIAL_INVALID',
    });
  });

  it('rejects credential-to-wallet address mismatch', async () => {
    const mismatched = JSON.stringify({
      ...JSON.parse(serializedCredential()),
      walletAddress: '0:different-wallet',
    });
    await expect(
      identityFixture({ credential: mismatched }).adapter.resolve('wallet-a'),
    ).rejects.toMatchObject({ code: 'WALLET_IDENTITY_MISMATCH' });
  });

  it('does not repeat mining-key propagation lookup during session identity mapping', async () => {
    const context = identityFixture();
    await context.adapter.resolve('wallet-a');
    expect(context.order).toEqual(['preflight', 'secure-read']);
  });
});

describe('shared disabled product adapters', () => {
  it('adapts one existing canonical provider without synchronizing or polling', () => {
    const listeners = new Set<() => void>();
    const synchronize = vi.fn();
    let epoch = '12000';
    const provider = {
      snapshot: () => ({
        miniEpoch: { id: epoch, remainingMs: 123_456 },
      } as unknown as Readonly<CanonicalChainStateSnapshot>),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      synchronize,
    } as unknown as Pick<CanonicalChainStateProvider, 'snapshot' | 'subscribe'>;
    const adapter = new ProductCanonicalMiniEpochAdapter(provider);
    expect(adapter.snapshot()).toEqual({
      miniEpoch: '12000',
      remainingMs: 123_456,
    });
    const observed: Array<string | null> = [];
    adapter.subscribe(() => observed.push(adapter.snapshot().miniEpoch));
    epoch = '13000';
    for (const listener of listeners) listener();
    expect(observed).toEqual(['13000']);
    expect(synchronize).not.toHaveBeenCalled();
  });

  it('rebuilds diagnostics from the allowlist and blocks injected secrets', () => {
    const destination = new MiningDiagnosticRecorder();
    const sink = new IsolatedMiningDiagnosticSink(destination);
    const event = {
      occurredAtMs: 1,
      kind: 'CALLBACK',
      walletId: 'wallet-a',
      sessionId: 'session-a',
      generationToken: 'generation-a',
      miniEpoch: '12000',
      workerState: 'WAITING_RESULT',
      queuedLocalTaps: 70,
      nativeComputedTaps: 70,
      computationCompletedTaps: 70,
      callbackAction: 'submit_session_proof',
      callbackSequence: 4,
      terminalOutcome: null,
      failure: null,
      stale: false,
      observationDerived: false,
      secretKey: SYNTHETIC_SECRET,
      rawCredential: 'blocked',
    } as Readonly<WalletMiningDiagnosticEvent> & {
      readonly secretKey: string;
      readonly rawCredential: string;
    };
    sink.record(event);
    const serialized = JSON.stringify(destination.events);
    expect(serialized).not.toContain(SYNTHETIC_SECRET);
    expect(serialized).not.toContain('rawCredential');
    expect(destination.events[0]).not.toHaveProperty('secretKey');
  });
});
