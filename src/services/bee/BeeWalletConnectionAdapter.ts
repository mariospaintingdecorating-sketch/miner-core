import { approvalReadBefore } from './ApprovalDeadline';
import { miningAuthorizationContext } from '../../shared/chainIdentity';
import type { CoreEvent, EventPublisher } from '../../shared/events';
import { CoreEventEmitter } from '../../shared/events';
import type { SecureReferenceStorageContract } from '../../storage/contracts';
import type {
  BeeConnectedWallet,
  BeeConnectionReference,
  BeeCredentialReference,
  BeePreparedMiningCredential,
  BeeSdkFailure,
  BeeSdkGatewayContract,
  BeeSdkResourceOwner,
  BeeWalletConnectionCapability,
  BeeWalletConnectionRequest,
  BeeWalletConnectionState,
} from './contracts';
import type {
  BeeNativeConnect,
  BeeNativeSdkFactory,
  BeeNativeWalletHello,
} from './BeeNativeSdk';
import { TeamGoshBeeNativeSdk } from './BeeNativeSdk';

export interface BeeWalletConnectionConfiguration {
  readonly endpoints: readonly string[];
  readonly appId: string;
}

const SHARED_KEY_SESSION_TTL_SECONDS = 31_536_000;
const WALLET_HELLO_MAX_ATTEMPTS = 90;
const WALLET_HELLO_INTERVAL_MS = 2_000;
const WALLET_HELLO_READ_RETRY_DELAYS_MS = Object.freeze([
  2_000,
  4_000,
  8_000,
]);
const MINING_KEY_APPROVAL_MAX_ATTEMPTS = 30;
const MINING_KEY_APPROVAL_INTERVAL_MS = 2_000;
const PROPAGATION_MAX_ATTEMPTS = 60;
const PROPAGATION_INTERVAL_MS = 2_000;

interface StoredConnectionState {
  readonly authorizationContext: string | null;
  readonly approvalDeadlineMs: number | null;
  readonly version: 1;
  readonly status: 'awaiting-approval' | 'connected' | 'failed';
  readonly sessionId: string;
  readonly description: string;
  readonly clientDhSecret: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly sessionStateJson: string | null;
  readonly walletName: string | null;
  readonly walletAddress: string | null;
  readonly credentialReference: BeeCredentialReference | null;
  readonly failure: Readonly<BeeSdkFailure> | null;
}

interface StoredMiningCredential {
  readonly authorizationContext: string | null;
  readonly version: 1;
  readonly walletName: string;
  readonly walletAddress: string;
  readonly minerAddress: string;
  readonly publicKey: string;
  readonly secretKey: string;
}

type GatewayWithResources = BeeSdkGatewayContract & BeeSdkResourceOwner;

function errorFailure(code: string, error: unknown): Readonly<BeeSdkFailure> {
  const message = errorMessage(error);
  const categorizedCode =
    code === 'bee-wallet-approval-failed' &&
    /(?:timed?\s*out|timeout|expired)/i.test(message)
      ? 'bee-wallet-approval-timeout'
      : code;

  return Object.freeze({
    code: categorizedCode,
    message: message || `Bee wallet operation failed (${categorizedCode}).`,
  });
}

function errorMessage(error: unknown): string {
  const value =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  return value
    .trim()
    .replace(/secret/gi, '[redacted]')
    .replace(/(?:[a-z][a-z0-9+.-]*):\/\/\S+/gi, '[redacted-url]')
    .slice(0, 500);
}

function walletHelloReadFailure(error: unknown): boolean {
  const message = errorMessage(error);

  if (
    /(?:approval|wallet[_\s-]?hello).*(?:expired|timed?\s*out)|(?:expired|timed?\s*out).*(?:approval|wallet[_\s-]?hello)/i.test(
      message,
    )
  ) {
    return false;
  }

  return (
    /query\s+wallet[_\s-]?hello/i.test(message) &&
    /graphql|connection|network|pool|transport/i.test(message)
  );
}

function waitForDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is missing from secure Bee state.`);
  }

  return value;
}

export class BeeWalletConnectionAdapter
  implements BeeWalletConnectionCapability
{
  #connect: BeeNativeConnect | null = null;
  #eventSequence = 0;

  constructor(
    private readonly gateway: GatewayWithResources,
    private readonly storage: SecureReferenceStorageContract,
    private readonly configuration: BeeWalletConnectionConfiguration,
    private readonly nativeSdk: BeeNativeSdkFactory = new TeamGoshBeeNativeSdk(),
    private readonly eventPublisher: EventPublisher = new CoreEventEmitter(),
    private readonly createReference: (kind: 'connection' | 'credential') => string =
      (kind) => `${kind}:${globalThis.crypto.randomUUID()}`,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly retryDelay: (milliseconds: number) => Promise<void> =
      waitForDelay,
  ) {
    if (configuration.endpoints.length === 0 || configuration.appId.trim().length === 0) {
      throw new TypeError('Bee endpoints and application ID are required.');
    }
  }

  async beginConnection(): Promise<Readonly<BeeWalletConnectionRequest>> {
    const reference = this.createReference('connection');

    try {
      await this.gateway.initialize();
      const connect = this.#connectionClient();
      const result = this.gateway.ownResource(
        connect.create_shared_key_session(
          this.configuration.appId,
          SHARED_KEY_SESSION_TTL_SECONDS,
          null,
        ),
      );

      try {
        const expiresAt = Number(result.expires_at);
        const state: StoredConnectionState = Object.freeze({
          authorizationContext: miningAuthorizationContext(this.configuration),
          approvalDeadlineMs: Date.now() + 180_000,
          version: 1,
          status: 'awaiting-approval',
          sessionId: result.session_id,
          description: result.description,
          clientDhSecret: result.client_dh_secret,
          createdAt: result.created_at.toString(),
          expiresAt,
          sessionStateJson: null,
          walletName: null,
          walletAddress: null,
          credentialReference: null,
          failure: null,
        });
        await this.storage.saveSecureValue(reference, JSON.stringify(state));
        this.#publishConnectionEvent(
          'bee-wallet-connection-started',
          state,
        );

        return Object.freeze({
          reference,
          deepLink: result.deep_link,
          expiresAt: Math.min(expiresAt, Math.floor(state.approvalDeadlineMs! / 1000)),
        });
      } finally {
        this.gateway.releaseResource(result);
      }
    } catch (error) {
      const failure = errorFailure('bee-wallet-connection-start-failed', error);
      this.#publishConnectionFailure(failure);
      throw error;
    }
  }

  async awaitConnection(
    reference: BeeConnectionReference,
  ): Promise<Readonly<BeeConnectedWallet>> {
    const state = await this.#loadConnection(reference);

    if (!state) {
      throw new Error('Bee wallet connection reference was not found.');
    }

    if (
      state.status === 'connected' &&
      state.sessionStateJson &&
      state.walletName &&
      state.walletAddress
    ) {
      return Object.freeze({
        reference,
        walletName: state.walletName,
        walletAddress: state.walletAddress,
      });
    }

    try {
      await this.gateway.initialize();
      const result = this.gateway.ownResource(
        await this.#waitForWalletHello(state),
      );

      try {
        const connected: StoredConnectionState = Object.freeze({
          ...state,
          status: 'connected',
          sessionStateJson: result.session_state_json,
          walletName: result.wallet_name,
          walletAddress: result.wallet_address,
          failure: null,
        });
        await this.storage.saveSecureValue(reference, JSON.stringify(connected));
        this.#publishConnectionEvent('bee-wallet-connected', connected);

        return Object.freeze({
          reference,
          walletName: result.wallet_name,
          walletAddress: result.wallet_address,
        });
      } finally {
        this.gateway.releaseResource(result);
      }
    } catch (error) {
      const failure = errorFailure(
        walletHelloReadFailure(error)
          ? 'bee-wallet-hello-read-failed'
          : 'bee-wallet-approval-failed',
        error,
      );
      const failed = Object.freeze({
        ...state,
        status: 'failed' as const,
        failure,
      });
      await this.storage
        .saveSecureValue(reference, JSON.stringify(failed))
        .catch(() => undefined);
      this.#publishConnectionFailure(failure, failed);
      throw error;
    }
  }

  async #waitForWalletHello(
    state: StoredConnectionState,
  ): Promise<BeeNativeWalletHello> {
    let retryIndex = 0;
    const deadline = state.approvalDeadlineMs ?? Date.now() + 180_000;

    while (true) {
      if (Date.now() >= deadline) throw new Error('Wallet approval timed out.');
      try {
        return await approvalReadBefore(this.#connectionClient().wait_wallet_hello(
          [...this.configuration.endpoints],
          state.sessionId,
          state.description,
          state.clientDhSecret,
          BigInt(state.createdAt),
          WALLET_HELLO_MAX_ATTEMPTS,
          WALLET_HELLO_INTERVAL_MS,
        ), deadline);
      } catch (error) {
        const delayMs = WALLET_HELLO_READ_RETRY_DELAYS_MS[retryIndex];

        if (delayMs === undefined || !walletHelloReadFailure(error)) {
          throw error;
        }

        retryIndex += 1;
        await this.retryDelay(delayMs);
      }
    }
  }

  async prepareMiningCredential(
    reference: BeeConnectionReference,
  ): Promise<Readonly<BeePreparedMiningCredential>> {
    const state = await this.#loadConnection(reference);

    if (
      !state ||
      state.status !== 'connected' ||
      !state.sessionStateJson ||
      !state.walletName ||
      !state.walletAddress
    ) {
      throw new Error('An approved Bee wallet connection is required.');
    }

    if (
      state.credentialReference &&
      (await this.storage.hasSecureValue(state.credentialReference))
    ) {
      return Object.freeze({
        reference,
        credentialReference: state.credentialReference,
        walletName: state.walletName,
        walletAddress: state.walletAddress,
      });
    }

    if (state.authorizationContext !== miningAuthorizationContext(this.configuration)) {
      throw new Error('Bee connection belongs to an unknown or different application context. Reconnect before creating new mining keys; existing keys are retained.');
    }

    const credentialReference = this.createReference('credential');
    await this.gateway.initialize();
    const keys = this.gateway.ownResource(
      await this.nativeSdk.generateMiningKeys(this.configuration.endpoints),
    );

    try {
      const minerAddress = await this.nativeSdk.resolveMinerAddress(
        this.configuration.endpoints,
        state.walletName,
      );
      const sessionUpdate = this.gateway.ownResource(
        await this.#connectionClient().request_set_mining_keys(
          [...this.configuration.endpoints],
          state.sessionId,
          state.description,
          state.sessionStateJson,
          this.configuration.appId,
          keys.public,
          MINING_KEY_APPROVAL_MAX_ATTEMPTS,
          MINING_KEY_APPROVAL_INTERVAL_MS,
        ),
      );

      try {
        const credential: StoredMiningCredential = Object.freeze({
          authorizationContext: null,
          version: 1,
          walletName: state.walletName,
          walletAddress: state.walletAddress,
          minerAddress,
          publicKey: keys.public,
          secretKey: keys.secret,
        });
        await this.storage.saveSecureValue(
          credentialReference,
          JSON.stringify(credential),
        );

        try {
          await this.storage.saveSecureValue(
            reference,
            JSON.stringify({
              ...state,
              sessionStateJson: sessionUpdate.updated_session_state_json,
              credentialReference,
              failure: null,
            } satisfies StoredConnectionState),
          );
        } catch (error) {
          await this.storage.removeSecureValue(credentialReference).catch(() => undefined);
          throw error;
        }

        return Object.freeze({
          reference,
          credentialReference,
          walletName: state.walletName,
          walletAddress: state.walletAddress,
        });
      } finally {
        this.gateway.releaseResource(sessionUpdate);
      }
    } catch (error) {
      const operationFailure = errorFailure(
        'bee-mining-credential-preparation-failed',
        error,
      );
      const failed = Object.freeze({
        ...state,
        status: 'connected' as const,
        failure: operationFailure,
      });
      await this.storage
        .saveSecureValue(reference, JSON.stringify(failed))
        .catch(() => undefined);
      this.#publishConnectionFailure(operationFailure, failed);
      throw error;
    } finally {
      this.gateway.releaseResource(keys);
    }
  }

  async verifyMiningCredentialPropagation(
    reference: BeeConnectionReference,
    credentialReference: BeeCredentialReference,
    maxAttempts: number = PROPAGATION_MAX_ATTEMPTS,
    intervalMs: number = PROPAGATION_INTERVAL_MS,
  ): Promise<void> {
    const state = await this.#loadConnection(reference);

    if (
      !state ||
      state.status !== 'connected' ||
      state.credentialReference !== credentialReference
    ) {
      throw new Error('A prepared Bee mining credential is required.');
    }

    const serialized = await this.storage.loadSecureValue(credentialReference);

    if (serialized === null) {
      throw new Error('The prepared Bee mining credential was not found.');
    }

    const credential = parseStoredBeeMiningCredential(serialized);
    try {
      await this.gateway.initialize();
      await this.nativeSdk.ensureMiningKeysPropagated(
        this.configuration.endpoints,
        this.configuration.appId,
        credential.minerAddress,
        credential.publicKey,
        maxAttempts,
        intervalMs,
      );
      const latestConnection = await this.#loadConnection(reference);
      const latestCredential = await this.storage.loadSecureValue(credentialReference);
      if (!latestConnection || latestConnection.credentialReference !== credentialReference ||
          latestCredential !== serialized) {
        throw new Error('Mining credential changed during verification. No record was overwritten.');
      }
      await this.storage.saveSecureValue(credentialReference, JSON.stringify({
        ...JSON.parse(serialized),
        authorizationContext: miningAuthorizationContext(this.configuration),
      }));
      await this.storage.saveSecureValue(
        reference,
        JSON.stringify({ ...latestConnection, failure: null } satisfies StoredConnectionState),
      );
    } catch (error) {
      const failure = errorFailure(
        'bee-mining-credential-propagation-failed',
        error,
      );
      const current = await this.#loadConnection(reference).catch(() => null);
      if (current?.credentialReference === credentialReference) {
        const failed = Object.freeze({ ...current, failure });
        await this.storage.saveSecureValue(reference, JSON.stringify(failed)).catch(() => undefined);
        this.#publishConnectionFailure(failure, failed);
      }
      throw error;
    }
  }

  async connectionState(
    reference: BeeConnectionReference,
  ): Promise<Readonly<BeeWalletConnectionState>> {
    const state = await this.#loadConnection(reference);

    if (!state) {
      return Object.freeze({
        reference,
        status: 'disconnected',
        walletName: null,
        walletAddress: null,
        credentialReference: null,
        failure: null,
      });
    }

    return Object.freeze({
      reference,
      status: state.status,
      walletName: state.walletName,
      walletAddress: state.walletAddress,
      credentialReference: state.credentialReference,
      failure: state.failure ? Object.freeze({ ...state.failure }) : null,
    });
  }

  async disconnect(reference: BeeConnectionReference): Promise<void> {
    const state = await this.#loadConnection(reference);

    if (!state) {
      return;
    }

    if (state.sessionStateJson) {
      await this.gateway.initialize();
      const result = this.gateway.ownResource(
        await this.#connectionClient().disconnect_session(
          [...this.configuration.endpoints],
          state.sessionId,
          state.description,
          state.sessionStateJson,
          'user-requested',
          WALLET_HELLO_MAX_ATTEMPTS,
          WALLET_HELLO_INTERVAL_MS,
        ),
      );
      this.gateway.releaseResource(result);
    }

    if (state.credentialReference) {
      await this.storage.removeSecureValue(state.credentialReference);
    }

    await this.storage.removeSecureValue(reference);
  }

  #connectionClient(): BeeNativeConnect {
    if (!this.#connect) {
      this.#connect = this.gateway.ownResource(this.nativeSdk.createConnect());
    }

    return this.#connect;
  }

  async #loadConnection(
    reference: BeeConnectionReference,
  ): Promise<StoredConnectionState | null> {
    const serialized = await this.storage.loadSecureValue(reference);

    if (serialized === null) {
      return null;
    }

    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const status = parsed.status;

    if (
      parsed.version !== 1 ||
      (status !== 'awaiting-approval' &&
        status !== 'connected' &&
        status !== 'failed')
    ) {
      throw new Error('Secure Bee connection state is invalid.');
    }

    return {
      approvalDeadlineMs: typeof parsed.approvalDeadlineMs === 'number' && Number.isFinite(parsed.approvalDeadlineMs) ? parsed.approvalDeadlineMs : null,
      authorizationContext: typeof parsed.authorizationContext === 'string' ? parsed.authorizationContext : null,
      version: 1,
      status,
      sessionId: requiredText(parsed.sessionId, 'Session ID'),
      description: requiredText(parsed.description, 'Session description'),
      clientDhSecret: requiredText(parsed.clientDhSecret, 'DH secret'),
      createdAt: requiredText(parsed.createdAt, 'Creation time'),
      expiresAt:
        typeof parsed.expiresAt === 'number' ? parsed.expiresAt : Number.NaN,
      sessionStateJson:
        typeof parsed.sessionStateJson === 'string'
          ? parsed.sessionStateJson
          : null,
      walletName:
        typeof parsed.walletName === 'string' ? parsed.walletName : null,
      walletAddress:
        typeof parsed.walletAddress === 'string' ? parsed.walletAddress : null,
      credentialReference:
        typeof parsed.credentialReference === 'string'
          ? parsed.credentialReference
          : null,
      failure:
        typeof parsed.failure === 'object' && parsed.failure !== null
          ? (parsed.failure as BeeSdkFailure)
          : null,
    };
  }

  #publishConnectionFailure(
    failure: Readonly<BeeSdkFailure>,
    state?: StoredConnectionState,
  ): void {
    this.#publishConnectionEvent(
      'bee-wallet-connection-failed',
      state ?? null,
      failure,
    );
  }

  #publishConnectionEvent(
    type:
      | 'bee-wallet-connection-started'
      | 'bee-wallet-connected'
      | 'bee-wallet-connection-failed',
    state: StoredConnectionState | null,
    failure: Readonly<BeeSdkFailure> | null = state?.failure ?? null,
  ): void {
    this.#eventSequence += 1;
    const event: CoreEvent<typeof type> = {
      id: `${type}:${this.#eventSequence}`,
      occurredAt: this.now(),
      type,
      payload: {
        state:
          type === 'bee-wallet-connection-failed'
            ? 'failed'
            : type === 'bee-wallet-connected'
              ? 'connected'
              : 'awaiting-approval',
        walletName: state?.walletName ?? null,
        walletAddress: state?.walletAddress ?? null,
        code: failure?.code ?? null,
        message: failure?.message ?? null,
      },
    };

    try {
      this.eventPublisher.publish(event);
    } catch {
      // Diagnostics cannot control wallet approval flow.
    }
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
