import { miningAuthorizationContext, mobileContractAddress, sameWalletAddress } from '../../shared/chainIdentity';
import { CoreEventEmitter, type CoreEvent, type EventPublisher } from '../../shared/events';
import type { SecureReferenceStorageContract } from '../../storage/contracts';
import type { BeeConnectedWallet, BeeConnectionReference, BeeCredentialReference, BeePreparedMiningCredential, BeeSdkFailure, BeeSdkGatewayContract, BeeSdkResourceOwner, BeeWalletConnectionCapability, BeeWalletConnectionInput, BeeWalletConnectionRequest, BeeWalletConnectionState } from './contracts';
import { TeamGoshDirectWalletAuthorizationSdk, walletLookupEndpointGroups, miningVerificationEndpointGroups, type DirectWalletAuthorizationSdk, type WalletAuthorizationIdentity } from './DirectWalletAuthorizationSdk';
import { assertAuthorizationActive, authorizationDelay, authorizationRead, WalletAuthorizationError, safeAuthorizationFailure } from './WalletAuthorizationRead';

export interface BeeWalletConnectionConfiguration {
  readonly endpoints: readonly string[];
  readonly appId: string;
  readonly apiUrl?: string;
}
interface DirectConnection {
  readonly version: 2;
  readonly kind: 'direct-mining-key';
  readonly status: 'awaiting-approval' | 'connected' | 'failed';
  readonly authorizationContext: string;
  readonly appId: string;
  readonly walletName: string;
  readonly expectedWalletAddress: string | null;
  readonly walletAddress: string | null;
  readonly minerAddress: string | null;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly deepLink: string;
  readonly createdAt: string;
  readonly approvalDeadlineMs: number;
  readonly verifiedAt: number | null;
  readonly pendingCredentialReference: string;
  readonly credentialReference: string | null;
  /** Retained encrypted legacy state, never a network session prerequisite. */
  readonly previousConnectionReference: string | null;
  readonly failure: Readonly<BeeSdkFailure> | null;
}
interface LegacyConnection {
  readonly version: 1;
  readonly status: 'awaiting-approval' | 'connected' | 'failed';
  readonly walletName: string | null;
  readonly walletAddress: string | null;
  readonly credentialReference: string | null;
  readonly failure: Readonly<BeeSdkFailure> | null;
  readonly [key: string]: unknown;
}
type Connection = DirectConnection | LegacyConnection;
type Gateway = BeeSdkGatewayContract & BeeSdkResourceOwner;
const OBSERVATION_MS = 180_000;
const SINGLE_READ_MS = 10_000;
const POLL_MS = 3_000;
const DEFAULT_API = 'https://app-backend.ackinacki.org/api';

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing from secure Bee state.`);
  return value;
}
function normalizeName(value: string): string {
  const name = value.trim().toLowerCase();
  if (name.length < 2 || name.length > 128 || /[\s\x00-\x1f\x7f]/u.test(name)) {
    throw new WalletAuthorizationError('bee-wallet-account-name-invalid', 'Enter the existing AN Wallet account name, not a new display label.');
  }
  return name;
}
function failureFor(error: unknown, fallback = 'bee-wallet-authorization-pending'): Readonly<BeeSdkFailure> {
  const failure = safeAuthorizationFailure(error, fallback);
  return Object.freeze({ code: failure.code, message: failure.message });
}
function validateKeys(publicKey: string, secretKey: string, deepLink: string, appId: string): void {
  if (!/^[a-f0-9]{64}$/i.test(publicKey) || !/^[a-f0-9]{64}$/i.test(secretKey)) throw new Error('Invalid mining-key encoding.');
  const url = new URL(deepLink);
  if (url.origin !== 'https://links.gosh.sh' || url.pathname !== '/deeplinks/wallet/v2/set-mining-keys' || url.username || url.password || url.hash || [...url.searchParams.keys()].join(',') !== 'payload') throw new Error('Unexpected mining-key approval link.');
  const encoded = url.searchParams.get('payload');
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid approval payload.');
  const payload = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.app_id !== appId || payload.pubkey !== publicKey || Object.keys(payload).sort().join(',') !== 'app_id,pubkey') throw new Error('Approval payload does not match the generated key and application.');
}

/** Direct mining-key QR authorization. No BeeConnect hello or second write request. */
export class BeeWalletConnectionAdapter implements BeeWalletConnectionCapability {
  readonly flow = 'direct-mining-key' as const;
  readonly #pendingReads = new Map<string, Promise<unknown>>();
  readonly #waiters = new Map<string, Promise<Readonly<BeeConnectedWallet>>>();
  #eventSequence = 0;
  constructor(
    private readonly gateway: Gateway,
    private readonly storage: SecureReferenceStorageContract,
    private readonly configuration: BeeWalletConnectionConfiguration,
    private readonly sdk: DirectWalletAuthorizationSdk = new TeamGoshDirectWalletAuthorizationSdk(),
    private readonly eventPublisher: EventPublisher = new CoreEventEmitter(),
    private readonly createReference: (kind: 'connection' | 'credential') => string = kind => `${kind}:${globalThis.crypto.randomUUID()}`,
    private readonly now: () => number = Date.now,
  ) {
    if (!configuration.endpoints.length || !/^0x[a-f0-9]{64}$/i.test(configuration.appId)) throw new TypeError('A full application ID and network endpoints are required.');
  }

  async beginConnection(input?: BeeWalletConnectionInput): Promise<Readonly<BeeWalletConnectionRequest>> {
    if (!input) throw new WalletAuthorizationError('bee-wallet-account-name-invalid', 'Enter the existing AN Wallet account name first.');
    assertAuthorizationActive(input.signal);
    const name = normalizeName(input.walletName);
    const context = miningAuthorizationContext(this.configuration);
    const previous = input.resumeReference ? await this.#load(input.resumeReference) : null;
    assertAuthorizationActive(input.signal);
    if (previous?.version === 2) {
      if (previous.walletName !== name || previous.authorizationContext !== context || previous.appId !== this.configuration.appId) {
        throw new WalletAuthorizationError('bee-wallet-authorization-context-mismatch', 'This saved request belongs to another account or application. Its key was not replaced.');
      }
      if (input.expectedWalletAddress && previous.walletAddress && !sameWalletAddress(input.expectedWalletAddress, previous.walletAddress)) throw new WalletAuthorizationError('bee-wallet-address-mismatch', 'The resolved wallet does not match this saved profile.');
      validateKeys(previous.publicKey, previous.secretKey, previous.deepLink, previous.appId);
      const resumed: DirectConnection = { ...previous, status: 'awaiting-approval', failure: null, verifiedAt: null, approvalDeadlineMs: this.now() + OBSERVATION_MS };
      await this.storage.saveSecureValue(input.resumeReference!, JSON.stringify(resumed));
      assertAuthorizationActive(input.signal);
      return Object.freeze({ reference: input.resumeReference!, accountName: name, deepLink: resumed.deepLink, expiresAt: Math.floor(resumed.approvalDeadlineMs / 1_000), kind: 'mining-key' });
    }
    await authorizationRead(this.gateway.initialize(), this.now() + SINGLE_READ_MS, input.signal, undefined, this.now);
    assertAuthorizationActive(input.signal);
    const keys = await authorizationRead(this.sdk.generate(this.configuration.appId), this.now() + SINGLE_READ_MS, input.signal, value => value.free(), this.now);
    try {
      assertAuthorizationActive(input.signal);
      const publicKey = keys.public, secretKey = keys.secret, deepLink = keys.deep_link;
      validateKeys(publicKey, secretKey, deepLink, this.configuration.appId);
      const reference = this.createReference('connection');
      const state: DirectConnection = {
        version: 2, kind: 'direct-mining-key', status: 'awaiting-approval', authorizationContext: context,
        appId: this.configuration.appId, walletName: name,
        expectedWalletAddress: input.expectedWalletAddress ?? previous?.walletAddress ?? null,
        walletAddress: null, minerAddress: null, publicKey, secretKey, deepLink,
        createdAt: new Date(this.now()).toISOString(), approvalDeadlineMs: this.now() + OBSERVATION_MS,
        verifiedAt: null, pendingCredentialReference: this.createReference('credential'), credentialReference: null,
        previousConnectionReference: input.resumeReference ?? null, failure: null,
      };
      // Save pending keys before showing QR. Retry/restart must never silently rotate them.
      await this.storage.saveSecureValue(reference, JSON.stringify(state));
      this.#publish('bee-wallet-connection-started', state);
      return Object.freeze({ reference, accountName: name, deepLink, expiresAt: Math.floor(state.approvalDeadlineMs / 1_000), kind: 'mining-key' });
    } finally { keys.free(); }
  }

  awaitConnection(reference: BeeConnectionReference, signal?: AbortSignal): Promise<Readonly<BeeConnectedWallet>> {
    const existing = this.#waiters.get(reference);
    if (existing) return existing;
    const waiter = this.#awaitConnection(reference, signal);
    this.#waiters.set(reference, waiter);
    void waiter.then(() => { if (this.#waiters.get(reference) === waiter) this.#waiters.delete(reference); }, () => { if (this.#waiters.get(reference) === waiter) this.#waiters.delete(reference); });
    return waiter;
  }

  async #awaitConnection(reference: string, signal?: AbortSignal): Promise<Readonly<BeeConnectedWallet>> {
    let state = await this.#direct(reference);
    const deadline = state.approvalDeadlineMs;
    let lastFailure: Readonly<BeeSdkFailure> = failureFor(null);
    try {
      await authorizationRead(this.gateway.initialize(), Math.min(deadline, this.now() + SINGLE_READ_MS), signal, undefined, this.now);
      const endpointGroups = walletLookupEndpointGroups(this.configuration.endpoints);
      let identity: WalletAuthorizationIdentity | null = null;
      while (this.now() < deadline) {
        assertAuthorizationActive(signal);
        if (!identity) {
          for (const endpoints of endpointGroups) {
            if (this.now() >= deadline) break;
            assertAuthorizationActive(signal);
            try {
              const resolved = await this.#read(`lookup:${state.walletName}:${JSON.stringify(endpoints)}`, () => this.sdk.resolve(endpoints, state.walletName, this.configuration.apiUrl ?? DEFAULT_API, state.appId), deadline, signal);
              identity = { walletAddress: mobileContractAddress(resolved.walletAddress), minerAddress: mobileContractAddress(resolved.minerAddress) };
              if (state.expectedWalletAddress && !sameWalletAddress(state.expectedWalletAddress, identity.walletAddress)) throw new WalletAuthorizationError('bee-wallet-address-mismatch', 'The account name resolves to a different wallet. The saved key was not replaced.');
              break;
            } catch (error) {
              assertAuthorizationActive(signal);
              if (error instanceof WalletAuthorizationError && error.code === 'bee-wallet-address-mismatch') throw error;
              lastFailure = failureFor(error, 'bee-wallet-account-read-failed');
              if (lastFailure.code === 'bee-wallet-sdk-address-invalid') throw new WalletAuthorizationError(lastFailure.code, lastFailure.message);
            }
          }
        }
        if (identity && this.now() < deadline) {
          try {
            // Discovery elsewhere is not authorization. Only mining endpoints may verify this key.
            await this.#verify(reference, state.appId, identity!.minerAddress, state.publicKey, deadline, signal);
            assertAuthorizationActive(signal);
            const latest = await this.#direct(reference);
            if (latest.publicKey !== state.publicKey || latest.approvalDeadlineMs !== deadline) throw new WalletAuthorizationError('bee-wallet-operation-stale', 'A newer request replaced this verification.');
            assertAuthorizationActive(signal);
            state = { ...latest, ...identity, status: 'connected', verifiedAt: this.now(), failure: null };
            try { await this.storage.saveSecureValue(reference, JSON.stringify(state)); }
            catch { throw new WalletAuthorizationError('bee-wallet-secure-save-failed', 'Approval was observed but could not be saved. The existing credential was not replaced.'); }
            assertAuthorizationActive(signal);
            this.#publish('bee-wallet-connected', state);
            return Object.freeze({ reference, walletName: state.walletName, walletAddress: identity.walletAddress });
          } catch (error) {
            assertAuthorizationActive(signal);
            if (error instanceof WalletAuthorizationError && ['bee-wallet-operation-stale','bee-wallet-secure-save-failed'].includes(error.code)) throw error;
            lastFailure = failureFor(error);
            if (lastFailure.code === 'bee-wallet-sdk-address-invalid') throw new WalletAuthorizationError(lastFailure.code, lastFailure.message);
          }
        }
        if (this.now() < deadline) await authorizationDelay(Math.min(POLL_MS, deadline - this.now()), signal);
      }
      throw new WalletAuthorizationError(lastFailure.code, `Automatic checking ended without confirmation. ${lastFailure.message} Resume verification with the same QR; do not reset the wallet.`);
    } catch (error) {
      const current = await this.#load(reference).catch(() => null);
      const failure = failureFor(error);
      if (current?.version === 2 && current.publicKey === state.publicKey && current.approvalDeadlineMs === deadline) {
        await this.storage.saveSecureValue(reference, JSON.stringify({ ...current, status: 'failed', failure })).catch(() => undefined);
        this.#publish('bee-wallet-connection-failed', current, failure);
      }
      throw error;
    }
  }

  async prepareMiningCredential(reference: BeeConnectionReference): Promise<Readonly<BeePreparedMiningCredential>> {
    const state = await this.#direct(reference);
    if (state.status !== 'connected' || state.verifiedAt === null || !state.walletAddress || !state.minerAddress) throw new Error('A verified mining-key authorization is required.');
    const credentialReference = state.credentialReference ?? state.pendingCredentialReference;
    const credential = { version: 1, authorizationContext: state.authorizationContext, walletName: state.walletName, walletAddress: state.walletAddress, minerAddress: state.minerAddress, publicKey: state.publicKey, secretKey: state.secretKey };
    const old = await this.storage.loadSecureValue(credentialReference);
    if (old) {
      const parsed = parseStoredBeeMiningCredential(old);
      if (parsed.publicKey !== state.publicKey || parsed.secretKey !== state.secretKey || parsed.minerAddress !== state.minerAddress) throw new Error('Credential reference conflict. No record was overwritten.');
    } else await this.storage.saveSecureValue(credentialReference, JSON.stringify(credential));
    await this.storage.saveSecureValue(reference, JSON.stringify({ ...state, credentialReference }));
    return Object.freeze({ reference, credentialReference, walletName: state.walletName, walletAddress: state.walletAddress });
  }

  async verifyMiningCredentialPropagation(reference: BeeConnectionReference, credentialReference: BeeCredentialReference,
    _maxAttempts = 60, _intervalMs = 2_000): Promise<void> {
    const state = await this.#load(reference);
    if (!state || state.credentialReference !== credentialReference) throw new Error('Prepared credential does not belong to this connection.');
    const serialized = await this.storage.loadSecureValue(credentialReference);
    if (!serialized) throw new Error('The saved mining credential is missing.');
    const credential = parseStoredBeeMiningCredential(serialized);
    if (state.version === 2 && (state.walletName !== credential.walletName || state.publicKey !== credential.publicKey || state.minerAddress !== credential.minerAddress)) throw new Error('Credential identity mismatch.');
    try {
      // Fresh direct completion already read owner_public[app_id] on the mining network.
      const freshlyVerified = state.version === 2 && state.status === 'connected' && state.verifiedAt !== null && this.now() - state.verifiedAt >= 0 && this.now() - state.verifiedAt < 15_000;
      if (!freshlyVerified) {
        await this.gateway.initialize();
        await this.#verify(reference, this.configuration.appId, credential.minerAddress, credential.publicKey, this.now() + SINGLE_READ_MS * 2);
      }
      const current = await this.#load(reference);
      if (!current || current.credentialReference !== credentialReference || await this.storage.loadSecureValue(credentialReference) !== serialized) throw new Error('Credential changed during verification. No record was overwritten.');
      await this.storage.saveSecureValue(credentialReference, JSON.stringify({ ...JSON.parse(serialized), authorizationContext: miningAuthorizationContext(this.configuration) }));
      await this.storage.saveSecureValue(reference, JSON.stringify({ ...current, failure: null }));
    } catch (error) {
      const current = await this.#load(reference).catch(() => null);
      if (current?.credentialReference === credentialReference) {
        const failure = failureFor(error, 'bee-mining-credential-propagation-failed');
        await this.storage.saveSecureValue(reference, JSON.stringify({ ...current, failure })).catch(() => undefined);
        this.#publish('bee-wallet-connection-failed', current, failure);
      }
      throw error;
    }
  }

  async connectionState(reference: BeeConnectionReference): Promise<Readonly<BeeWalletConnectionState>> {
    const state = await this.#load(reference);
    return Object.freeze({ reference, status: state?.status ?? 'disconnected', walletName: state?.walletName ?? null, walletAddress: state?.walletAddress ?? null, credentialReference: state?.credentialReference ?? null, failure: state?.failure ?? null });
  }
  /** Explicit local disconnect only; pausing QR observation does not call this. */
  async disconnect(reference: BeeConnectionReference): Promise<void> {
    if (this.#waiters.has(reference)) throw new Error('Pause the pending authorization before removing its local record.');
    const state = await this.#load(reference);
    if (!state) return;
    if (state.credentialReference) await this.storage.removeSecureValue(state.credentialReference);
    if (state.version === 2 && state.pendingCredentialReference !== state.credentialReference) await this.storage.removeSecureValue(state.pendingCredentialReference);
    await this.storage.removeSecureValue(reference);
  }

  async #read<T>(key: string, operation: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
    assertAuthorizationActive(signal);
    if (this.now() >= deadline) throw new WalletAuthorizationError('bee-wallet-read-timeout', 'The network read deadline has passed.');
    let pending = this.#pendingReads.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = Promise.resolve().then(operation);
      this.#pendingReads.set(key, pending);
      const release = () => { if (this.#pendingReads.get(key) === pending) this.#pendingReads.delete(key); };
      void pending.then(release, release);
    }
    // A timed-out SDK read remains single-flight; retry never spawns a parallel copy.
    return authorizationRead(pending, Math.min(deadline, this.now() + SINGLE_READ_MS), signal, undefined, this.now);
  }
  async #verify(reference: string, appId: string, minerAddress: string, publicKey: string,
    deadline: number, signal?: AbortSignal): Promise<void> {
    const groups = miningVerificationEndpointGroups(this.configuration.endpoints);
    let lastError: unknown;
    for (let index = 0; index < groups.length; index++) {
      assertAuthorizationActive(signal);
      const endpoints = groups[index];
      try {
        await this.#read(`verify:${reference}:${publicKey}:${JSON.stringify(endpoints)}`,
          () => this.sdk.verify(endpoints, appId, minerAddress, publicKey), deadline, signal);
        return;
      } catch (error) {
        assertAuthorizationActive(signal);
        lastError = error;
        const code = safeAuthorizationFailure(error).code;
        // Fail over only public reads after transport failures. Not after a
        // real negative key observation or an invalid address. Never Shellnet.
        if (!['bee-wallet-network-read-failed', 'bee-wallet-read-timeout'].includes(code) || this.now() >= deadline) throw error;
      }
    }
    throw lastError;
  }

  async #direct(reference: string): Promise<DirectConnection> {
    const state = await this.#load(reference);
    if (state?.version !== 2 || state.authorizationContext !== miningAuthorizationContext(this.configuration)) throw new Error('The request is missing or belongs to a different application context.');
    return state;
  }
  async #load(reference: string): Promise<Connection | null> {
    const raw = await this.storage.loadSecureValue(reference);
    if (raw === null) return null;
    const state = JSON.parse(raw);
    if (!state || !['awaiting-approval', 'connected', 'failed'].includes(state.status)) throw new Error('Invalid secure connection state.');
    if (state.version === 1) return state as LegacyConnection;
    if (state.version !== 2 || state.kind !== 'direct-mining-key' || !Number.isFinite(state.approvalDeadlineMs)) throw new Error('Invalid secure authorization request.');
    for (const field of ['walletName', 'publicKey', 'secretKey', 'deepLink', 'appId', 'authorizationContext', 'pendingCredentialReference']) requiredText(state[field], field);
    return state as DirectConnection;
  }
  #publish(type: 'bee-wallet-connection-started' | 'bee-wallet-connected' | 'bee-wallet-connection-failed', state: Connection,
    failure: Readonly<BeeSdkFailure> | null = null): void {
    const event: CoreEvent<typeof type> = { id: `${type}:${++this.#eventSequence}`, occurredAt: new Date(this.now()).toISOString(), type,
      payload: { state: type === 'bee-wallet-connection-started' ? 'awaiting-approval' : type === 'bee-wallet-connected' ? 'connected' : 'failed', walletName: state.walletName, walletAddress: state.walletAddress, code: failure?.code ?? null, message: failure?.message ?? null } };
    try { this.eventPublisher.publish(event); } catch { /* Diagnostics never alter authorization. */ }
  }
}
export function parseStoredBeeMiningCredential(value: string): Readonly<{
  authorizationContext: string | null;
  walletName: string;
  walletAddress: string;
  minerAddress: string;
  publicKey: string;
  secretKey: string;
}> {
  const parsed = JSON.parse(value) as Record<string, unknown>;

  if (parsed.version !== 1) {
    throw new Error('Secure Bee mining credential is invalid.');
  }

  return Object.freeze({
    authorizationContext: typeof parsed.authorizationContext === 'string' ? parsed.authorizationContext : null,
    walletName: requiredText(parsed.walletName, 'Wallet name'),
    walletAddress: requiredText(parsed.walletAddress, 'Wallet address'),
    minerAddress: requiredText(parsed.minerAddress, 'Miner address'),
    publicKey: requiredText(parsed.publicKey, 'Mining public key'),
    secretKey: requiredText(parsed.secretKey, 'Mining secret key'),
  });
}
