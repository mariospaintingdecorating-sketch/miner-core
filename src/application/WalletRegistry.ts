import type {
  WalletDefinition,
  WalletConnectionUpdate,
  WalletId,
  WalletRegistryContract,
  WalletSessionAssociation,
  WalletSnapshot,
  WalletStatus,
} from '../shared/wallets';

export class WalletRegistry implements WalletRegistryContract {
  private readonly records = new Map<WalletId, Readonly<WalletSnapshot>>();

  constructor(initialWallets: readonly WalletDefinition[] = []) {
    for (const wallet of initialWallets) {
      this.#storeWallet(wallet, false);
    }
  }

  registerWallet(definition: WalletDefinition): Readonly<WalletSnapshot> {
    return this.#storeWallet(definition, true);
  }

  removeWallet(walletId: WalletId): Readonly<WalletSnapshot> | null {
    const wallet = this.records.get(walletId);

    if (!wallet) {
      return null;
    }

    this.records.delete(walletId);
    return wallet;
  }

  updateStatus(walletId: WalletId, status: WalletStatus): boolean {
    const wallet = this.records.get(walletId);

    if (!wallet) {
      return false;
    }

    this.records.set(walletId, this.#snapshot({ ...wallet, status }));
    return true;
  }

  updateConnection(
    walletId: WalletId,
    update: WalletConnectionUpdate,
  ): boolean {
    const wallet = this.records.get(walletId);

    if (!wallet) {
      return false;
    }

    this.records.set(walletId, this.#snapshot({ ...wallet, ...update }));
    return true;
  }

  updateMamaBoardLevel(walletId: WalletId, level: number | null): boolean {
    const wallet = this.records.get(walletId);

    if (!wallet) {
      return false;
    }

    this.records.set(
      walletId,
      this.#snapshot({ ...wallet, mamaBoardLevel: validateMamaBoardLevel(level) }),
    );
    return true;
  }

  associateSession(
    walletId: WalletId,
    session: WalletSessionAssociation,
  ): boolean {
    const wallet = this.records.get(walletId);

    if (!wallet) {
      return false;
    }

    if (
      wallet.session &&
      (session.generation < wallet.session.generation ||
        (session.generation === wallet.session.generation &&
          session.sessionId !== wallet.session.sessionId))
    ) {
      return false;
    }

    this.records.set(
      walletId,
      this.#snapshot({
        ...wallet,
        session: Object.freeze({ ...session }),
      }),
    );
    return true;
  }

  clearSession(
    walletId: WalletId,
    session: WalletSessionAssociation,
  ): boolean {
    const wallet = this.records.get(walletId);

    if (
      !wallet?.session ||
      wallet.session.sessionId !== session.sessionId ||
      wallet.session.generation !== session.generation
    ) {
      return false;
    }

    this.records.set(walletId, this.#snapshot({ ...wallet, session: null }));
    return true;
  }

  wallet(walletId: WalletId): Readonly<WalletSnapshot> | null {
    return this.records.get(walletId) ?? null;
  }

  wallets(): readonly Readonly<WalletSnapshot>[] {
    return Object.freeze([...this.records.values()]);
  }

  #snapshot(wallet: WalletSnapshot): Readonly<WalletSnapshot> {
    return Object.freeze({
      ...wallet,
      session: wallet.session ? Object.freeze({ ...wallet.session }) : null,
    });
  }

  #storeWallet(
    definition: WalletDefinition,
    validateNewProfile: boolean,
  ): Readonly<WalletSnapshot> {
    const id = definition.id.trim();
    const name = definition.name.trim();

    if (id.length === 0) {
      throw new TypeError('Wallet identity must not be empty.');
    }

    if (validateNewProfile && (name.length < 2 || name.length > 80)) {
      throw new TypeError('Wallet name must contain between 2 and 80 characters.');
    }

    if (this.records.has(id)) {
      throw new Error(`Wallet ${id} is already registered.`);
    }

    if (
      validateNewProfile &&
      [...this.records.values()].some(
        (wallet) => wallet.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new Error('Wallet with this name is already registered.');
    }

    const wallet = this.#snapshot({
      id,
      name,
      status: definition.status ?? 'idle',
      walletAddress: definition.walletAddress ?? null,
      onboardingStatus: definition.onboardingStatus ?? 'disconnected',
      connectionReference: definition.connectionReference ?? null,
      miningCredentialReference:
        definition.miningCredentialReference ?? null,
      mamaBoardLevel: validateMamaBoardLevel(
        definition.mamaBoardLevel ?? null,
      ),
      session: null,
    });
    this.records.set(wallet.id, wallet);
    return wallet;
  }
}

function validateMamaBoardLevel(level: number | null): number | null {
  if (level === null) {
    return null;
  }

  if (!Number.isInteger(level) || level < 0 || level > 72) {
    throw new RangeError('MamaBoard level must be an integer from 0 to 72.');
  }

  return level;
}
