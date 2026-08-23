export type WalletId = string;

export type WalletStatus =
  | 'running'
  | 'idle'
  | 'warning'
  | 'error'
  | 'offline';

export type WalletOnboardingStatus =
  | 'disconnected'
  | 'awaiting-connection'
  | 'connected'
  | 'awaiting-mining-key-approval'
  | 'propagating-mining-key'
  | 'ready'
  | 'failed';

export interface WalletDefinition {
  readonly id: WalletId;
  readonly name: string;
  readonly status?: WalletStatus;
  readonly walletAddress?: string | null;
  readonly onboardingStatus?: WalletOnboardingStatus;
  readonly connectionReference?: string | null;
  readonly miningCredentialReference?: string | null;
  readonly mamaBoardLevel?: number | null;
}

export interface WalletSessionAssociation {
  readonly sessionId: string;
  readonly generation: number;
}

export interface WalletConnectionUpdate {
  readonly walletAddress: string | null;
  readonly onboardingStatus: WalletOnboardingStatus;
  readonly connectionReference: string | null;
  readonly miningCredentialReference: string | null;
}

export interface WalletSnapshot {
  readonly id: WalletId;
  readonly name: string;
  readonly status: WalletStatus;
  readonly walletAddress: string | null;
  readonly onboardingStatus: WalletOnboardingStatus;
  readonly connectionReference: string | null;
  readonly miningCredentialReference: string | null;
  readonly mamaBoardLevel: number | null;
  readonly session: Readonly<WalletSessionAssociation> | null;
}

export interface MamaBoardLevelSource {
  readMamaBoardLevel(
    walletId: WalletId,
    walletAddress: string,
  ): Promise<number | null>;
}

export interface WalletRegistryContract {
  registerWallet(definition: WalletDefinition): Readonly<WalletSnapshot>;
  removeWallet(walletId: WalletId): Readonly<WalletSnapshot> | null;
  updateStatus(walletId: WalletId, status: WalletStatus): boolean;
  updateConnection(walletId: WalletId, update: WalletConnectionUpdate): boolean;
  updateMamaBoardLevel(walletId: WalletId, level: number | null): boolean;
  associateSession(
    walletId: WalletId,
    session: WalletSessionAssociation,
  ): boolean;
  clearSession(
    walletId: WalletId,
    session: WalletSessionAssociation,
  ): boolean;
  wallet(walletId: WalletId): Readonly<WalletSnapshot> | null;
  wallets(): readonly Readonly<WalletSnapshot>[];
}
