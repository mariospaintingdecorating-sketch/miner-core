import type {
  SessionGeneration,
  SessionId,
} from '../../shared/miningRuntime';
import type { WalletId } from '../../shared/wallets';
import type { BeeFailureClassification } from '../../shared/beeFailures';

export type BeeSdkGatewayStatus =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'failed'
  | 'disposing'
  | 'disposed';

export interface BeeSdkFailure {
  readonly code: string;
  readonly message: string;
  readonly classification?: BeeFailureClassification | null;
  readonly messageHash?: string | null;
}

export interface BeeSdkReadiness {
  readonly status: BeeSdkGatewayStatus;
  readonly version: string | null;
  readonly failure: Readonly<BeeSdkFailure> | null;
}

/**
 * Narrow adapter around the platform-specific Bee SDK/WASM module.
 * It owns module setup only; individual SDK objects belong to the gateway.
 */
export interface BeeSdkRuntimeAdapter {
  initialize(): Promise<void>;
  version(): string | null;
  dispose(): void | Promise<void>;
}

export interface BeeSdkOwnedResource {
  free(): void;
}

/** Infrastructure-only ownership capability for native Bee SDK objects. */
export interface BeeSdkResourceOwner {
  ownResource<TResource extends BeeSdkOwnedResource>(
    resource: TResource,
  ): TResource;
  releaseResource(resource: BeeSdkOwnedResource): void;
}

export interface BeeSdkGatewayContract {
  initialize(): Promise<void>;
  readiness(): Readonly<BeeSdkReadiness>;
  dispose(): Promise<void>;
}

export type BeeConnectionReference = string;
export type BeeCredentialReference = string;
export type BeeMiningSessionReference = string;
export type BeeNativeOperationId = string;

export type BeeWalletConnectionStatus =
  | 'awaiting-approval'
  | 'connected'
  | 'failed'
  | 'disconnected';

export interface BeeWalletConnectionInput {
  readonly walletName: string;
  readonly resumeReference?: string | null;
  readonly expectedWalletAddress?: string | null;
  readonly signal?: AbortSignal;
}

export interface BeeWalletConnectionRequest {
  readonly accountName?: string;
  readonly kind?: 'mining-key';
  readonly reference: BeeConnectionReference;
  readonly deepLink: string;
  readonly expiresAt: number;
}

export interface BeeConnectedWallet {
  readonly reference: BeeConnectionReference;
  readonly walletName: string;
  readonly walletAddress: string;
}

export interface BeePreparedMiningCredential extends BeeConnectedWallet {
  readonly credentialReference: BeeCredentialReference;
}

export interface BeeWalletConnectionState {
  readonly reference: BeeConnectionReference;
  readonly status: BeeWalletConnectionStatus;
  readonly walletName: string | null;
  readonly walletAddress: string | null;
  readonly credentialReference: BeeCredentialReference | null;
  readonly failure: Readonly<BeeSdkFailure> | null;
}

/** Wallet approval operations only. Sensitive connection state stays internal. */
export interface BeeWalletConnectionCapability {
  readonly flow?: 'direct-mining-key';
  beginConnection(input?: BeeWalletConnectionInput): Promise<Readonly<BeeWalletConnectionRequest>>;
  awaitConnection(
    reference: BeeConnectionReference,
    signal?: AbortSignal,
  ): Promise<Readonly<BeeConnectedWallet>>;
  prepareMiningCredential(
    reference: BeeConnectionReference,
  ): Promise<Readonly<BeePreparedMiningCredential>>;
  verifyMiningCredentialPropagation(
    reference: BeeConnectionReference,
    credentialReference: BeeCredentialReference,
    maxAttempts?: number,
    intervalMs?: number,
  ): Promise<void>;
  connectionState(
    reference: BeeConnectionReference,
  ): Promise<Readonly<BeeWalletConnectionState>>;
  disconnect(reference: BeeConnectionReference): Promise<void>;
}

export type BeeNativeSessionPhase =
  | 'prepared'
  | 'running'
  | 'completed'
  | 'stopping'
  | 'stopped';

export interface BeeMiningSessionSnapshot {
  readonly walletId: WalletId;
  readonly sessionId: SessionId;
  readonly generation: SessionGeneration;
  readonly phase: BeeNativeSessionPhase;
}
