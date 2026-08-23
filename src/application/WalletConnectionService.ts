import type { BeeWalletConnectionCapability } from '../services/bee/contracts';
import type {
  WalletConnectionUpdate,
  WalletOnboardingStatus,
  WalletRegistryContract,
  WalletSnapshot,
} from '../shared/wallets';
import type { WalletConfigurationStorageContract } from '../storage/contracts';
import type { ProductionConfigurationSnapshot } from './productionConfiguration';
import type {
  WalletApprovalPresentation,
  WalletConnectionCommandResult,
  WalletConnectionOperationStep,
  WalletConnectionPresentation,
  WalletConnectionReasonCode,
  WalletSecureState,
} from './walletState';

export type {
  WalletApprovalPresentation,
  WalletConnectionCommandResult,
  WalletConnectionReasonCode,
  WalletSecureState,
} from './walletState';

export interface WalletConnectionProductionServices {
  readonly configuration: Pick<ProductionConfigurationSnapshot, 'status'>;
  readonly capability: BeeWalletConnectionCapability | null;
  readonly secureStorageAvailable: boolean;
  readonly initialWalletSecurity: ReadonlyMap<
    string,
    Readonly<WalletSecureState>
  >;
  secureReferenceExists(reference: string): Promise<boolean>;
}

export interface WalletConnectionOperations {
  beginWalletConnection(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  prepareWalletMiningCredential(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  verifyWalletMiningCredentialPropagation(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  disconnectWallet(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  getWalletConnectionState(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>>;
  presentation(walletId: string): Readonly<WalletConnectionPresentation>;
  hasPendingOperation(walletId: string): boolean;
  trackWallet(walletId: string): void;
  forgetWallet(walletId: string): void;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}

type WalletRegistryAccess = Pick<
  WalletRegistryContract,
  'wallet' | 'wallets' | 'updateConnection'
>;

interface WalletConnectionMetadata extends WalletSecureState {
  readonly lastFailureCode: string | null;
  readonly approval: Readonly<WalletApprovalPresentation> | null;
}

interface WalletOperationOutcome {
  readonly accepted: boolean;
  readonly reasonCode: WalletConnectionReasonCode;
  readonly message: string;
  readonly approval?: Readonly<WalletApprovalPresentation> | null;
}

interface WalletOperationRecord {
  readonly step: WalletConnectionOperationStep;
  readonly token: symbol;
  readonly promise: Promise<Readonly<WalletConnectionCommandResult>>;
}

interface WalletOperationContext {
  readonly wallet: Readonly<WalletSnapshot>;
  readonly capability: BeeWalletConnectionCapability;
  readonly token: symbol;
}

interface WalletOperationDefinition {
  readonly walletId: string;
  readonly selectedWalletId: string | null;
  readonly step: WalletConnectionOperationStep;
  readonly failureReasonCode: WalletConnectionReasonCode;
  readonly failureCode: string;
  readonly failureMessage: string;
  readonly allowActiveSession?: boolean;
  validate?(
    wallet: Readonly<WalletSnapshot>,
  ): Readonly<WalletConnectionCommandResult> | null;
  execute(context: WalletOperationContext): Promise<WalletOperationOutcome>;
  onFailure?(context: WalletOperationContext): Promise<void>;
}

class WalletOperationFailure extends Error {
  constructor(
    readonly reasonCode: WalletConnectionReasonCode,
    readonly failureCode: string,
    message: string,
  ) {
    super(message);
  }
}

export class WalletConnectionService implements WalletConnectionOperations {
  readonly #metadata = new Map<string, WalletConnectionMetadata>();
  readonly #operations = new Map<string, WalletOperationRecord>();
  readonly #listeners = new Set<() => void>();
  #disposed = false;
  #disposal: Promise<void> | null = null;

  constructor(
    private readonly walletRegistry: WalletRegistryAccess,
    private readonly walletStorage?: Pick<
      WalletConfigurationStorageContract,
      'saveWallet'
    >,
    private readonly production?: WalletConnectionProductionServices,
    private readonly now: () => number = Date.now,
  ) {
    for (const wallet of walletRegistry.wallets()) {
      const initialSecurity = production?.initialWalletSecurity.get(wallet.id);
      this.#metadata.set(wallet.id, {
        connectionStateStored:
          initialSecurity?.connectionStateStored ??
          (wallet.connectionReference ? null : false),
        miningCredentialStored:
          initialSecurity?.miningCredentialStored ??
          (wallet.miningCredentialReference ? null : false),
        lastFailureCode: null,
        approval: null,
      });
    }
  }

  beginWalletConnection(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    return this.#run({
      walletId,
      selectedWalletId,
      step: 'begin-connection',
      failureReasonCode: 'wallet-connection-start-failed',
      failureCode: 'bee-wallet-connection-start-failed',
      failureMessage:
        'Wallet connection could not be started. Review diagnostics and retry.',
      validate: (wallet) =>
        wallet.connectionReference ||
        wallet.onboardingStatus !== 'disconnected'
          ? this.#result(
              false,
              'wallet-already-connected',
              'Disconnect the existing wallet connection before starting another.',
              walletId,
            )
          : null,
      execute: async ({ capability, token }) => {
        let request: Awaited<
          ReturnType<BeeWalletConnectionCapability['beginConnection']>
        > | null = null;
        let approvalPublished = false;
        try {
          request = await capability.beginConnection();
          const approval = Object.freeze({
            deepLink: request.deepLink,
            expiresAt: request.expiresAt,
            waiting: true as const,
          });

          this.#requireCurrent(walletId, token);
          await this.#commit(
            walletId,
            {
              walletAddress: null,
              onboardingStatus: 'awaiting-connection',
              connectionReference: request.reference,
              miningCredentialReference: null,
            },
            token,
          );
          approvalPublished = true;

          this.#setMetadata(walletId, {
            connectionStateStored: true,
            miningCredentialStored: false,
            lastFailureCode: null,
            approval,
          });

          // The approval request must be visible while Bee waits for wallet_hello.
          this.#notify();

          let connected;

          try {
            connected = await capability.awaitConnection(request.reference);
          } catch {
            this.#requireCurrent(walletId, token);
            const failureCode = await this.#connectionFailureCode(
              capability,
              request.reference,
              'bee-wallet-approval-failed',
            );
            this.#requireCurrent(walletId, token);
            throw this.#failure(
              failureCode === 'bee-wallet-hello-read-failed'
                ? 'wallet-hello-read-failed'
                : 'wallet-approval-failed',
              failureCode === 'bee-wallet-hello-read-failed'
                ? 'Bee did not report a wallet rejection, but Core Miner could not read wallet_hello from the network. Reset the connection and retry.'
                : 'Wallet approval did not complete. Review the wallet and retry.',
              failureCode,
            );
          }

          this.#requireCurrent(walletId, token);
          await this.#commit(
            walletId,
            {
              walletAddress: connected.walletAddress,
              onboardingStatus: 'connected',
              connectionReference: request.reference,
              miningCredentialReference: null,
            },
            token,
          );
          this.#setMetadata(walletId, {
            connectionStateStored: true,
            miningCredentialStored: false,
            lastFailureCode: null,
            approval: null,
          });

          return {
            accepted: true,
            reasonCode: 'wallet-approved',
            message:
              'Wallet approval completed. Mining-key setup is still required.',
          };
        } catch (error) {
          if (
            request &&
            (!approvalPublished || !this.#isCurrent(walletId, token))
          ) {
            await capability.disconnect(request.reference).catch(() => undefined);
          }
          throw error;
        }
      },
      onFailure: async ({ token }) => {
        try {
          if (
            this.walletRegistry.wallet(walletId)?.onboardingStatus ===
            'awaiting-connection'
          ) {
            await this.#markWorkflowFailed(walletId, token);
          }
        } finally {
          this.#setMetadata(walletId, { approval: null });
        }
      },
    });
  }

  prepareWalletMiningCredential(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    return this.#run({
      walletId,
      selectedWalletId,
      step: 'prepare-mining-credential',
      failureReasonCode: 'mining-credential-preparation-failed',
      failureCode: 'bee-mining-credential-preparation-failed',
      failureMessage:
        'Mining-key setup did not complete. Review diagnostics and retry.',
      validate: (wallet) =>
        wallet.connectionReference &&
        (wallet.onboardingStatus === 'connected' ||
          (wallet.onboardingStatus === 'failed' && wallet.walletAddress))
          ? null
          : this.#result(
              false,
              'wallet-approval-required',
              'Wait for automatic wallet approval before preparing the mining credential.',
              walletId,
            ),
      execute: async ({ wallet, capability, token }) => {
        await this.#commit(
          walletId,
          {
            walletAddress: wallet.walletAddress,
            onboardingStatus: 'awaiting-mining-key-approval',
            connectionReference: wallet.connectionReference,
            miningCredentialReference: wallet.miningCredentialReference,
          },
          token,
        );
        let prepared: Awaited<
          ReturnType<BeeWalletConnectionCapability['prepareMiningCredential']>
        >;

        try {
          prepared = await capability.prepareMiningCredential(
            wallet.connectionReference!,
          );
        } catch {
          this.#requireCurrent(walletId, token);
          const failureCode = await this.#connectionFailureCode(
            capability,
            wallet.connectionReference!,
            'bee-mining-credential-preparation-failed',
          );
          this.#requireCurrent(walletId, token);
          throw new WalletOperationFailure(
            'mining-credential-preparation-failed',
            failureCode,
            'Mining-key setup did not complete. Review diagnostics and retry.',
          );
        }

        if (!this.#isCurrent(walletId, token)) {
          if (!wallet.miningCredentialReference) {
            await capability
              .disconnect(wallet.connectionReference!)
              .catch(() => undefined);
          }
          this.#requireCurrent(walletId, token);
        }

        await this.#commit(
          walletId,
          {
            walletAddress: prepared.walletAddress,
            onboardingStatus: 'awaiting-mining-key-approval',
            connectionReference: wallet.connectionReference,
            miningCredentialReference: prepared.credentialReference,
          },
          token,
        );
        this.#setMetadata(walletId, {
          connectionStateStored: true,
          miningCredentialStored: true,
          lastFailureCode: null,
        });
        return {
          accepted: true,
          reasonCode: 'mining-credential-approval-pending',
          message:
            'Mining-key authorization completed. Verify propagation before mining.',
        };
      },
      onFailure: ({ token }) => this.#markWorkflowFailed(walletId, token),
    });
  }

  verifyWalletMiningCredentialPropagation(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    return this.#run({
      walletId,
      selectedWalletId,
      step: 'verify-mining-credential',
      failureReasonCode: 'mining-credential-propagation-failed',
      failureCode: 'bee-mining-credential-propagation-failed',
      failureMessage:
        'Mining-key propagation could not be verified. Review diagnostics and retry.',
      validate: (wallet) =>
        wallet.connectionReference &&
        wallet.miningCredentialReference &&
        (wallet.onboardingStatus === 'awaiting-mining-key-approval' ||
          (wallet.onboardingStatus === 'failed' && wallet.walletAddress))
          ? null
          : this.#result(
              false,
              'mining-credential-preparation-failed',
              'Prepare and approve the mining credential before verifying propagation.',
              walletId,
            ),
      execute: async ({ wallet, capability, token }) => {
        await this.#commit(
          walletId,
          {
            walletAddress: wallet.walletAddress,
            onboardingStatus: 'propagating-mining-key',
            connectionReference: wallet.connectionReference,
            miningCredentialReference: wallet.miningCredentialReference,
          },
          token,
        );
        this.#setMetadata(walletId, { lastFailureCode: null });

        try {
          await capability.verifyMiningCredentialPropagation(
            wallet.connectionReference!,
            wallet.miningCredentialReference!,
          );
        } catch {
          this.#requireCurrent(walletId, token);
          const failureCode = await this.#connectionFailureCode(
            capability,
            wallet.connectionReference!,
            'bee-mining-credential-propagation-failed',
          );
          this.#requireCurrent(walletId, token);
          throw new WalletOperationFailure(
            'mining-credential-propagation-failed',
            failureCode,
            'Mining-key propagation could not be verified. Review diagnostics and retry.',
          );
        }

        await this.#commit(
          walletId,
          {
            walletAddress: wallet.walletAddress,
            onboardingStatus: 'ready',
            connectionReference: wallet.connectionReference,
            miningCredentialReference: wallet.miningCredentialReference,
          },
          token,
        );
        return {
          accepted: true,
          reasonCode: 'mining-credential-ready',
          message: 'Wallet mining-key propagation was verified successfully.',
        };
      },
      onFailure: ({ token }) => this.#markWorkflowFailed(walletId, token),
    });
  }

  disconnectWallet(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    return this.#run({
      walletId,
      selectedWalletId,
      step: 'disconnect',
      failureReasonCode: 'wallet-disconnect-failed',
      failureCode: 'bee-wallet-disconnect-failed',
      failureMessage:
        'Wallet disconnect did not complete. Review diagnostics and retry.',
      execute: async ({ wallet, capability, token }) => {
        if (wallet.connectionReference) {
          await capability.disconnect(wallet.connectionReference);
          this.#requireCurrent(walletId, token);
          this.#setMetadata(walletId, {
            connectionStateStored: false,
            miningCredentialStored: false,
            approval: null,
          });
        }

        await this.#commit(
          walletId,
          {
            walletAddress: wallet.walletAddress,
            onboardingStatus: 'disconnected',
            connectionReference: null,
            miningCredentialReference: null,
          },
          token,
        );
        this.#setMetadata(walletId, {
          connectionStateStored: false,
          miningCredentialStored: false,
          lastFailureCode: null,
          approval: null,
        });
        return {
          accepted: true,
          reasonCode: 'disconnected',
          message: 'Wallet connection and mining credential were removed.',
        };
      },
    });
  }

  getWalletConnectionState(
    walletId: string,
    selectedWalletId: string | null,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    return this.#run({
      walletId,
      selectedWalletId,
      step: 'refresh-state',
      failureReasonCode: 'wallet-state-refresh-failed',
      failureCode: 'bee-wallet-state-refresh-failed',
      failureMessage: 'Wallet connection state could not be refreshed.',
      allowActiveSession: true,
      execute: async ({ wallet, capability, token }) => {
        if (!wallet.connectionReference) {
          this.#setMetadata(walletId, {
            connectionStateStored: false,
            miningCredentialStored: false,
            lastFailureCode: null,
            approval: null,
          });
          return {
            accepted: true,
            reasonCode: 'state-refreshed',
            message: 'Wallet is disconnected.',
          };
        }

        const state = await capability.connectionState(
          wallet.connectionReference,
        );
        this.#requireCurrent(walletId, token);
        const connectionStateStored = await this.production!.secureReferenceExists(
          wallet.connectionReference,
        );
        this.#requireCurrent(walletId, token);
        const miningCredentialStored = state.credentialReference
          ? await this.production!.secureReferenceExists(
              state.credentialReference,
            )
          : false;
        this.#requireCurrent(walletId, token);
        await this.#commit(
          walletId,
          {
            walletAddress: state.walletAddress ?? wallet.walletAddress,
            onboardingStatus: connectionStateStored
              ? this.#refreshedOnboardingStatus(
                  wallet,
                  state.status,
                  miningCredentialStored,
                )
              : 'disconnected',
            connectionReference: connectionStateStored
              ? wallet.connectionReference
              : null,
            miningCredentialReference:
              connectionStateStored && miningCredentialStored
                ? state.credentialReference
                : null,
          },
          token,
        );
        this.#setMetadata(walletId, {
          connectionStateStored,
          miningCredentialStored,
          lastFailureCode: state.failure?.code ?? null,
          approval:
            state.status === 'awaiting-approval'
              ? this.#metadata.get(walletId)?.approval ?? null
              : null,
        });
        return {
          accepted: true,
          reasonCode: 'state-refreshed',
          message: 'Wallet connection state was refreshed securely.',
        };
      },
    });
  }

  presentation(walletId: string): Readonly<WalletConnectionPresentation> {
    const wallet = this.walletRegistry.wallet(walletId);
    const metadata = this.#metadata.get(walletId);
    const operation = this.#operations.get(walletId);
    const onboardingStatus = wallet?.onboardingStatus ?? 'disconnected';
    const phase = this.#connectionPhase(onboardingStatus);
    const connectionStateStored =
      metadata?.connectionStateStored ??
      (wallet?.connectionReference ? null : false);
    const miningCredentialStored =
      metadata?.miningCredentialStored ??
      (wallet?.miningCredentialReference ? null : false);

    return Object.freeze({
      onboardingStatus,
      phase,
      availability: this.#availability(),
      approvalPending:
        onboardingStatus === 'awaiting-connection' ||
        onboardingStatus === 'awaiting-mining-key-approval',
      approval: this.#currentApproval(
        walletId,
        onboardingStatus,
        metadata?.approval,
      ),
      connectionStateStored,
      miningCredentialStored,
      miningReady:
        onboardingStatus === 'ready' && miningCredentialStored === true,
      operationPending: Boolean(operation),
      operationStep: operation?.step ?? null,
      lastFailureCode: metadata?.lastFailureCode ?? null,
    });
  }

  hasPendingOperation(walletId: string): boolean {
    return this.#operations.has(walletId);
  }

  trackWallet(walletId: string): void {
    if (!this.#metadata.has(walletId)) {
      this.#metadata.set(walletId, {
        connectionStateStored: false,
        miningCredentialStored: false,
        lastFailureCode: null,
        approval: null,
      });
    }
  }

  forgetWallet(walletId: string): void {
    this.#metadata.delete(walletId);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): Promise<void> {
    if (this.#disposal) {
      return this.#disposal;
    }

    this.#disposed = true;
    this.#listeners.clear();
    const pending = [...this.#operations.values()].map(
      (operation) => operation.promise,
    );
    this.#disposal = Promise.allSettled(pending).then(() => {
      this.#operations.clear();
      this.#metadata.clear();
    });
    return this.#disposal;
  }

  #run(
    definition: WalletOperationDefinition,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    if (this.#disposed) {
      return Promise.resolve(
        this.#result(
          false,
          'application-disposed',
          'The application is shutting down and cannot accept wallet operations.',
          definition.walletId,
        ),
      );
    }

    const pending = this.#pending(definition.walletId, definition.step);

    if (pending) {
      return pending;
    }

    const blocked = this.#blocked(definition);

    if (blocked) {
      return Promise.resolve(blocked);
    }

    const wallet = this.walletRegistry.wallet(definition.walletId)!;
    const validationFailure = definition.validate?.(wallet);

    if (validationFailure) {
      return Promise.resolve(validationFailure);
    }

    const token = Symbol(`${definition.walletId}:${definition.step}`);
    const context: WalletOperationContext = {
      wallet,
      capability: this.production!.capability!,
      token,
    };
    const operation = Promise.resolve().then(() =>
      this.#perform(definition, context),
    );
    this.#operations.set(definition.walletId, {
      step: definition.step,
      token,
      promise: operation,
    });
    this.#notify();
    return operation;
  }

  async #perform(
    definition: WalletOperationDefinition,
    context: WalletOperationContext,
  ): Promise<Readonly<WalletConnectionCommandResult>> {
    let outcome: WalletOperationOutcome;

    try {
      this.#requireCurrent(definition.walletId, context.token);
      outcome = await definition.execute(context);
    } catch (error) {
      const knownFailure = error instanceof WalletOperationFailure ? error : null;
      const failureCode = knownFailure?.failureCode ?? definition.failureCode;

      if (this.#isCurrent(definition.walletId, context.token)) {
        await definition.onFailure?.(context).catch(() => undefined);
        this.#setMetadata(definition.walletId, {
          lastFailureCode: failureCode,
        });
      }

      outcome = {
        accepted: false,
        reasonCode:
          knownFailure?.reasonCode ?? definition.failureReasonCode,
        message: knownFailure?.message ?? definition.failureMessage,
      };
    }

    if (this.#isCurrent(definition.walletId, context.token)) {
      this.#operations.delete(definition.walletId);
      this.#notify();
    }

    return this.#result(
      outcome.accepted,
      outcome.reasonCode,
      outcome.message,
      definition.walletId,
      outcome.approval ?? null,
    );
  }

  #pending(
    walletId: string,
    requestedStep: WalletConnectionOperationStep,
  ): Promise<Readonly<WalletConnectionCommandResult>> | null {
    const pending = this.#operations.get(walletId);

    if (!pending) {
      return null;
    }

    return pending.step === requestedStep
      ? pending.promise
      : Promise.resolve(
          this.#result(
            false,
            'wallet-operation-conflict',
            'Another wallet operation is already in progress for this wallet.',
            walletId,
          ),
        );
  }

  #blocked(
    definition: WalletOperationDefinition,
  ): Readonly<WalletConnectionCommandResult> | null {
    const wallet = this.walletRegistry.wallet(definition.walletId);

    if (!wallet) {
      return this.#result(
        false,
        'wallet-not-found',
        'The requested wallet is not registered.',
        definition.walletId,
      );
    }

    if (definition.selectedWalletId !== definition.walletId) {
      return this.#result(
        false,
        'wallet-not-selected',
        'Select this wallet before starting a wallet operation.',
        definition.walletId,
      );
    }

    if (this.#disposed) {
      return this.#result(
        false,
        'application-disposed',
        'The application is shutting down and cannot accept wallet operations.',
        definition.walletId,
      );
    }

    const configurationStatus = this.production?.configuration.status;

    if (!this.production || configurationStatus === 'missing') {
      return this.#result(
        false,
        'production-configuration-missing',
        'Bee production configuration is required for wallet connection.',
        definition.walletId,
      );
    }

    if (configurationStatus === 'invalid') {
      return this.#result(
        false,
        'production-configuration-invalid',
        'Bee production configuration is invalid.',
        definition.walletId,
      );
    }

    if (!this.production.secureStorageAvailable) {
      return this.#result(
        false,
        'secure-storage-unavailable',
        'Secure operating-system storage is required for wallet connection.',
        definition.walletId,
      );
    }

    if (!this.production.capability) {
      return this.#result(
        false,
        'wallet-connection-unavailable',
        'Wallet connection operations are unavailable.',
        definition.walletId,
      );
    }

    if (!definition.allowActiveSession && wallet.session) {
      return this.#result(
        false,
        'wallet-has-active-session',
        'Finish the active mining session before changing this wallet connection.',
        definition.walletId,
      );
    }

    return null;
  }

  async #commit(
    walletId: string,
    update: WalletConnectionUpdate,
    token: symbol,
  ): Promise<void> {
    this.#requireCurrent(walletId, token);
    const wallet = this.walletRegistry.wallet(walletId);

    if (!wallet) {
      throw this.#failure(
        'wallet-not-found',
        'The registered wallet no longer exists.',
      );
    }

    try {
      await this.walletStorage?.saveWallet({
        id: wallet.id,
        name: wallet.name,
        status: wallet.status,
        walletAddress: update.walletAddress,
        onboardingStatus: update.onboardingStatus,
        connectionReference: update.connectionReference,
        miningCredentialReference: update.miningCredentialReference,
        mamaBoardLevel: wallet.mamaBoardLevel,
      });
    } catch {
      throw this.#failure(
        'wallet-state-persistence-failed',
        'Public wallet connection state could not be saved.',
      );
    }

    this.#requireCurrent(walletId, token);

    if (!this.walletRegistry.updateConnection(walletId, update)) {
      throw this.#failure(
        'wallet-not-found',
        'The registered wallet no longer exists.',
      );
    }

    this.#notify();
  }

  async #markWorkflowFailed(walletId: string, token: symbol): Promise<void> {
    const wallet = this.walletRegistry.wallet(walletId);

    if (!wallet || !this.#isCurrent(walletId, token)) {
      return;
    }

    await this.#commit(
      walletId,
      {
        walletAddress: wallet.walletAddress,
        onboardingStatus: 'failed',
        connectionReference: wallet.connectionReference,
        miningCredentialReference: wallet.miningCredentialReference,
      },
      token,
    );
  }

  #connectionPhase(
    onboardingStatus: WalletOnboardingStatus,
  ): WalletConnectionPresentation['phase'] {
    if (onboardingStatus === 'disconnected') {
      return 'disconnected';
    }

    if (onboardingStatus === 'awaiting-connection') {
      return 'awaiting-approval';
    }

    return onboardingStatus === 'failed' ? 'failed' : 'connected';
  }

  #refreshedOnboardingStatus(
    wallet: Readonly<WalletSnapshot>,
    status: 'awaiting-approval' | 'connected' | 'failed' | 'disconnected',
    miningCredentialStored: boolean,
  ): WalletOnboardingStatus {
    if (status === 'awaiting-approval') {
      return 'awaiting-connection';
    }

    if (status !== 'connected') {
      return status;
    }

    if (wallet.onboardingStatus === 'ready' && miningCredentialStored) {
      return 'ready';
    }

    return miningCredentialStored && wallet.miningCredentialReference
      ? 'awaiting-mining-key-approval'
      : 'connected';
  }

  #availability(): WalletConnectionPresentation['availability'] {
    if (this.#disposed) {
      return 'application-disposed';
    }

    if (!this.production || this.production.configuration.status === 'missing') {
      return 'configuration-missing';
    }

    if (this.production.configuration.status === 'invalid') {
      return 'configuration-invalid';
    }

    if (!this.production.secureStorageAvailable) {
      return 'secure-storage-unavailable';
    }

    return this.production.capability ? 'available' : 'adapter-unavailable';
  }

  #setMetadata(
    walletId: string,
    update: Partial<WalletConnectionMetadata>,
  ): void {
    const current = this.#metadata.get(walletId) ?? {
      connectionStateStored: false,
      miningCredentialStored: false,
      lastFailureCode: null,
      approval: null,
    };
    this.#metadata.set(walletId, { ...current, ...update });
  }

  #currentApproval(
    walletId: string,
    onboardingStatus: WalletOnboardingStatus,
    approval: Readonly<WalletApprovalPresentation> | null | undefined,
  ): Readonly<WalletApprovalPresentation> | null {
    if (onboardingStatus !== 'awaiting-connection' || !approval) {
      return null;
    }

    if (
      !Number.isFinite(approval.expiresAt) ||
      approval.expiresAt <= Math.floor(this.now() / 1_000)
    ) {
      this.#setMetadata(walletId, { approval: null });
      return null;
    }

    return approval;
  }

  #requireCurrent(walletId: string, token: symbol): void {
    if (!this.#isCurrent(walletId, token)) {
      throw this.#failure(
        'wallet-operation-stale',
        'A newer wallet operation replaced this result.',
      );
    }
  }

  #isCurrent(walletId: string, token: symbol): boolean {
    return !this.#disposed && this.#operations.get(walletId)?.token === token;
  }

  #failure(
    reasonCode: WalletConnectionReasonCode,
    message: string,
    failureCode: string = reasonCode,
  ): WalletOperationFailure {
    return new WalletOperationFailure(reasonCode, failureCode, message);
  }

  async #connectionFailureCode(
    capability: BeeWalletConnectionCapability,
    reference: string,
    fallback: string,
  ): Promise<string> {
    try {
      return (await capability.connectionState(reference)).failure?.code ?? fallback;
    } catch {
      return fallback;
    }
  }

  #result(
    accepted: boolean,
    reasonCode: WalletConnectionReasonCode,
    message: string,
    walletId: string,
    approval: Readonly<WalletApprovalPresentation> | null = null,
  ): Readonly<WalletConnectionCommandResult> {
    return Object.freeze({
      accepted,
      reasonCode,
      message,
      walletId,
      connection: this.walletRegistry.wallet(walletId)
        ? this.presentation(walletId)
        : null,
      approval,
    });
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // Presentation observers cannot control wallet workflow ownership.
      }
    }
  }
}
