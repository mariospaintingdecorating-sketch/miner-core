import { describe, expect, it, vi } from 'vitest';
import type { BeeWalletConnectionCapability } from '../services/bee/contracts';
import {
  WalletConnectionService,
  type WalletConnectionProductionServices,
} from './WalletConnectionService';
import { WalletRegistry } from './WalletRegistry';

function capability(): BeeWalletConnectionCapability & {
  beginConnection: ReturnType<typeof vi.fn>;
  awaitConnection: ReturnType<typeof vi.fn>;
  prepareMiningCredential: ReturnType<typeof vi.fn>;
  verifyMiningCredentialPropagation: ReturnType<typeof vi.fn>;
  connectionState: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  let connectionSequence = 0;

  return {
    beginConnection: vi.fn(async () => {
      connectionSequence += 1;
      return {
        reference: `private-connection-${connectionSequence}`,
        deepLink: `acki://approve/${connectionSequence}`,
        expiresAt: 400 + connectionSequence,
      };
    }),
    awaitConnection: vi.fn(async (reference: string) => ({
      reference,
      walletName: 'bee-wallet',
      walletAddress: '0:public-wallet',
    })),
    prepareMiningCredential: vi.fn(async (reference: string) => ({
      reference,
      credentialReference: `private-credential:${reference}`,
      walletName: 'bee-wallet',
      walletAddress: '0:public-wallet',
    })),
    verifyMiningCredentialPropagation: vi.fn(async () => undefined),
    connectionState: vi.fn(async (reference: string) => ({
      reference,
      status: 'connected' as const,
      walletName: 'bee-wallet',
      walletAddress: '0:public-wallet',
      credentialReference: `private-credential:${reference}`,
      failure: null,
    })),
    disconnect: vi.fn(async () => undefined),
  };
}

function fixture(options: {
  readonly connection?: BeeWalletConnectionCapability | null;
  readonly configurationStatus?: 'ready' | 'missing' | 'invalid';
  readonly secureStorageAvailable?: boolean;
  readonly activeWallet?: boolean;
  readonly selectedWalletId?: string | null;
  readonly now?: () => number;
} = {}) {
  const wallets = new WalletRegistry([
    { id: 'wallet-a', name: 'Alpha' },
    { id: 'wallet-b', name: 'Beta' },
  ]);

  if (options.activeWallet) {
    wallets.associateSession('wallet-a', {
      sessionId: 'active-session',
      generation: 1,
    });
  }

  const beeConnection =
    options.connection === undefined ? capability() : options.connection;
  const saveWallet = vi.fn(async (wallet: { readonly id: string }) => {
    void wallet;
  });
  const production: WalletConnectionProductionServices = {
    configuration: {
      status: options.configurationStatus ?? 'ready',
    },
    capability: beeConnection,
    secureStorageAvailable: options.secureStorageAvailable ?? true,
    initialWalletSecurity: new Map(),
    secureReferenceExists: vi.fn(async () => true),
  };
  const connectionService = new WalletConnectionService(
    wallets,
    { saveWallet },
    production,
    options.now ?? (() => 100_000),
  );
  let selectedWalletId =
    options.selectedWalletId === undefined
      ? 'wallet-a'
      : options.selectedWalletId;
  const service = {
    beginWalletConnection: (walletId: string) =>
      connectionService.beginWalletConnection(walletId, selectedWalletId),
    prepareWalletMiningCredential: (walletId: string) =>
      connectionService.prepareWalletMiningCredential(
        walletId,
        selectedWalletId,
      ),
    verifyWalletMiningCredentialPropagation: (walletId: string) =>
      connectionService.verifyWalletMiningCredentialPropagation(
        walletId,
        selectedWalletId,
      ),
    disconnectWallet: (walletId: string) =>
      connectionService.disconnectWallet(walletId, selectedWalletId),
    getWalletConnectionState: (walletId: string) =>
      connectionService.getWalletConnectionState(walletId, selectedWalletId),
    getWallets: () =>
      wallets.wallets().map((wallet) => ({
        id: wallet.id,
        walletAddress: wallet.walletAddress,
        connection: connectionService.presentation(wallet.id),
      })),
    selectWallet: (walletId: string | null) => {
      selectedWalletId = walletId;
    },
    dispose: () => connectionService.dispose(),
  };

  return {
    service,
    connectionService,
    wallets,
    connection: beeConnection,
    saveWallet,
    production,
  };
}

describe('WalletConnectionService', () => {
  it('runs approval and mining-key setup only for the explicit wallet without controlling mining', async () => {
    let resolveApproval: (value: {
      reference: string;
      walletName: string;
      walletAddress: string;
    }) => void = () => {
      throw new Error('Wallet approval was not started.');
    };
    const beeConnection = capability();
    vi.mocked(beeConnection.awaitConnection).mockImplementationOnce(
      (reference: string) =>
        new Promise((resolve) => {
          resolveApproval = resolve;
          void reference;
        }),
    );
    const { service, connection, connectionService, wallets, saveWallet } =
      fixture({ connection: beeConnection });
    const observedPresentations: Readonly<
      ReturnType<WalletConnectionService['presentation']>
    >[] = [];
    connectionService.subscribe(() => {
      observedPresentations.push(connectionService.presentation('wallet-a'));
    });

    expect(service.getWallets()[0]?.connection).toMatchObject({
      onboardingStatus: 'disconnected',
      phase: 'disconnected',
      connectionStateStored: false,
      miningCredentialStored: false,
      miningReady: false,
    });

    const connectionOperation = service.beginWalletConnection('wallet-a');

    await vi.waitFor(() => {
      expect(service.getWallets()[0]?.connection).toMatchObject({
        onboardingStatus: 'awaiting-connection',
        phase: 'awaiting-approval',
        approvalPending: true,
        approval: {
          deepLink: 'acki://approve/1',
          expiresAt: 401,
          waiting: true,
        },
        miningReady: false,
        operationPending: true,
      });
    });
    expect(
      observedPresentations.some(
        (presentation) =>
          presentation.onboardingStatus === 'awaiting-connection' &&
          presentation.approval?.deepLink === 'acki://approve/1',
      ),
    ).toBe(true);

    expect(service.getWallets()[0]?.connection.approval).toEqual({
      deepLink: 'acki://approve/1',
      expiresAt: 401,
      waiting: true,
    });
    expect(JSON.stringify(saveWallet.mock.calls)).not.toContain(
      'acki://approve/1',
    );
    expect(JSON.stringify(service.getWallets())).not.toContain(
      'private-connection-1',
    );
    expect(wallets.wallet('wallet-b')?.onboardingStatus).toBe('disconnected');

    resolveApproval({
      reference: 'private-connection-1',
      walletName: 'bee-wallet',
      walletAddress: '0:public-wallet',
    });
    await expect(connectionOperation).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'wallet-approved',
      connection: {
        onboardingStatus: 'connected',
        phase: 'connected',
        approval: null,
        miningReady: false,
      },
    });
    await expect(
      service.prepareWalletMiningCredential('wallet-a'),
    ).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'mining-credential-approval-pending',
      connection: {
        onboardingStatus: 'awaiting-mining-key-approval',
        phase: 'connected',
        connectionStateStored: true,
        miningCredentialStored: true,
        miningReady: false,
      },
    });
    await expect(
      service.verifyWalletMiningCredentialPropagation('wallet-a'),
    ).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'mining-credential-ready',
      connection: {
        onboardingStatus: 'ready',
        miningReady: true,
      },
    });

    expect(connection?.beginConnection).toHaveBeenCalledOnce();
    expect(connection?.awaitConnection).toHaveBeenCalledOnce();
    expect(connection?.prepareMiningCredential).toHaveBeenCalledOnce();
    expect(
      connection?.verifyMiningCredentialPropagation,
    ).toHaveBeenCalledOnce();
    expect('startMining' in connectionService).toBe(false);
    expect('stopMining' in connectionService).toBe(false);

    const publicJson = JSON.stringify({
      result: service.getWallets(),
    });
    expect(publicJson).not.toContain('private-connection');
    expect(publicJson).not.toContain('private-credential');
  });

  it('keeps approval presentation transient and stops exposing it after expiry', async () => {
    let currentTime = 100_000;
    let resolveApproval: (value: {
      reference: string;
      walletName: string;
      walletAddress: string;
    }) => void = () => {
      throw new Error('Wallet approval was not started.');
    };
    const beeConnection = capability();
    vi.mocked(beeConnection.awaitConnection).mockImplementationOnce(
      (reference: string) =>
        new Promise((resolve) => {
          resolveApproval = resolve;
          void reference;
        }),
    );
    const { service } = fixture({
      connection: beeConnection,
      now: () => currentTime,
    });

    const connectionOperation = service.beginWalletConnection('wallet-a');
    await vi.waitFor(() => {
      expect(service.getWallets()[0]?.connection).toMatchObject({
        approvalPending: true,
        approval: {
          deepLink: 'acki://approve/1',
          expiresAt: 401,
          waiting: true,
        },
      });
    });

    currentTime = 402_000;
    expect(service.getWallets()[0]?.connection).toMatchObject({
      approvalPending: true,
      approval: null,
    });

    resolveApproval({
      reference: 'private-connection-1',
      walletName: 'bee-wallet',
      walletAddress: '0:public-wallet',
    });
    await connectionOperation;
  });

  it('reports mining-key approval and propagation before becoming ready', async () => {
    let resolvePreparation: (value: {
      reference: string;
      credentialReference: string;
      walletName: string;
      walletAddress: string;
    }) => void = () => {
      throw new Error('Mining-key preparation was not started.');
    };
    let resolvePropagation: (value?: void) => void = () => {
      throw new Error('Mining-key propagation was not started.');
    };
    const beeConnection = capability();
    vi.mocked(beeConnection.prepareMiningCredential).mockImplementationOnce(
      (reference: string) =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
          void reference;
        }),
    );
    vi.mocked(
      beeConnection.verifyMiningCredentialPropagation,
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePropagation = resolve;
        }),
    );
    const { service } = fixture({ connection: beeConnection });

    await service.beginWalletConnection('wallet-a');
    const preparation = service.prepareWalletMiningCredential('wallet-a');

    await vi.waitFor(() => {
      expect(service.getWallets()[0]?.connection).toMatchObject({
        onboardingStatus: 'awaiting-mining-key-approval',
        miningReady: false,
      });
    });

    resolvePreparation({
      reference: 'private-connection-1',
      credentialReference: 'private-credential:private-connection-1',
      walletName: 'bee-wallet',
      walletAddress: '0:public-wallet',
    });

    await expect(preparation).resolves.toMatchObject({
      accepted: true,
      connection: {
        onboardingStatus: 'awaiting-mining-key-approval',
        miningCredentialStored: true,
        miningReady: false,
      },
    });

    const verification = service.verifyWalletMiningCredentialPropagation(
      'wallet-a',
    );
    await vi.waitFor(() => {
      expect(service.getWallets()[0]?.connection).toMatchObject({
        onboardingStatus: 'propagating-mining-key',
        miningCredentialStored: true,
        miningReady: false,
      });
    });

    resolvePropagation();
    await expect(verification).resolves.toMatchObject({
      accepted: true,
      connection: {
        onboardingStatus: 'ready',
        miningReady: true,
      },
    });
  });

  it('deduplicates identical work, rejects conflicting work, and isolates another wallet', async () => {
    let resolveFirst: (value: {
      reference: string;
      deepLink: string;
      expiresAt: number;
    }) => void = () => {
      throw new Error('Connection operation was not started.');
    };
    const beeConnection = capability();
    vi.mocked(beeConnection.beginConnection)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        reference: 'private-connection-b',
        deepLink: 'acki://approve/b',
        expiresAt: 500,
      });
    const { service } = fixture({ connection: beeConnection });

    const first = service.beginWalletConnection('wallet-a');
    const duplicate = service.beginWalletConnection('wallet-a');
    const conflict = service.disconnectWallet('wallet-a');
    service.selectWallet('wallet-b');
    const otherWallet = service.beginWalletConnection('wallet-b');

    expect(duplicate).toBe(first);
    await expect(conflict).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-operation-conflict',
    });
    await expect(otherWallet).resolves.toMatchObject({
      accepted: true,
      walletId: 'wallet-b',
    });
    expect(service.getWallets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'wallet-a',
          connection: expect.objectContaining({ operationPending: true }),
        }),
        expect.objectContaining({
          id: 'wallet-b',
          connection: expect.objectContaining({ phase: 'connected' }),
        }),
      ]),
    );

    resolveFirst({
      reference: 'private-connection-a',
      deepLink: 'acki://approve/a',
      expiresAt: 501,
    });
    await expect(first).resolves.toMatchObject({ accepted: true, walletId: 'wallet-a' });
    expect(beeConnection.beginConnection).toHaveBeenCalledTimes(2);
  });

  it('returns safe unavailable and unknown-wallet states without invoking Bee', async () => {
    const missing = fixture({ configurationStatus: 'missing' });
    await expect(missing.service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'production-configuration-missing',
      connection: { availability: 'configuration-missing' },
    });
    expect(missing.connection?.beginConnection).not.toHaveBeenCalled();

    const invalid = fixture({ configurationStatus: 'invalid' });
    await expect(invalid.service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'production-configuration-invalid',
    });
    expect(invalid.connection?.beginConnection).not.toHaveBeenCalled();

    const insecure = fixture({ secureStorageAvailable: false });
    await expect(insecure.service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'secure-storage-unavailable',
      connection: { availability: 'secure-storage-unavailable' },
    });
    expect(insecure.connection?.beginConnection).not.toHaveBeenCalled();

    const unavailable = fixture({ connection: null });
    await expect(unavailable.service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-connection-unavailable',
    });
    await expect(unavailable.service.beginWalletConnection('unknown')).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-not-found',
      connection: null,
    });
  });

  it('requires the registered wallet to be explicitly selected', async () => {
    const { service, connection } = fixture({ selectedWalletId: null });

    await expect(service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-not-selected',
    });
    expect(connection?.beginConnection).not.toHaveBeenCalled();
  });

  it('keeps failures retryable and never returns raw adapter errors', async () => {
    const beeConnection = capability();
    vi.mocked(beeConnection.beginConnection)
      .mockRejectedValueOnce(new Error('SECRET native endpoint failure'))
      .mockResolvedValueOnce({
        reference: 'private-connection-retry',
        deepLink: 'acki://approve/retry',
        expiresAt: 600,
      });
    const { service } = fixture({ connection: beeConnection });

    const failed = await service.beginWalletConnection('wallet-a');
    expect(failed).toMatchObject({
      accepted: false,
      reasonCode: 'wallet-connection-start-failed',
      connection: {
        operationPending: false,
        lastFailureCode: 'bee-wallet-connection-start-failed',
      },
    });
    expect(JSON.stringify(failed)).not.toContain('SECRET');

    await expect(service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'wallet-approved',
    });
    expect(beeConnection.beginConnection).toHaveBeenCalledTimes(2);
  });

  it('preserves the Bee deep link for presentation and starts wallet_hello waiting', async () => {
    let resolveApproval: (value: {
      reference: string;
      walletName: string;
      walletAddress: string;
    }) => void = () => {
      throw new Error('Wallet approval was not started.');
    };
    const beeConnection = capability();
    vi.mocked(beeConnection.beginConnection).mockResolvedValueOnce({
      reference: 'private-bee-connection',
      deepLink: 'https://unexpected.example/approval',
      expiresAt: 600,
    });
    vi.mocked(beeConnection.awaitConnection).mockImplementationOnce(
      (reference: string) =>
        new Promise((resolve) => {
          resolveApproval = resolve;
          void reference;
        }),
    );
    const { service } = fixture({ connection: beeConnection });

    const operation = service.beginWalletConnection('wallet-a');

    await vi.waitFor(() => {
      expect(service.getWallets()[0]?.connection).toMatchObject({
        onboardingStatus: 'awaiting-connection',
        approval: {
          deepLink: 'https://unexpected.example/approval',
          expiresAt: 600,
          waiting: true,
        },
      });
    });
    expect(beeConnection.awaitConnection).toHaveBeenCalledWith(
      'private-bee-connection',
    );
    expect(beeConnection.disconnect).not.toHaveBeenCalled();

    resolveApproval({
      reference: 'private-bee-connection',
      walletName: 'bee-wallet',
      walletAddress: '0:public-wallet',
    });
    await expect(operation).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'wallet-approved',
      connection: { onboardingStatus: 'connected', approval: null },
    });
    expect('startMining' in service).toBe(false);
    expect('stopMining' in service).toBe(false);
  });

  it('keeps approval and mining-key failures retryable with truthful public phases', async () => {
    const beeConnection = capability();
    vi.mocked(beeConnection.awaitConnection).mockRejectedValueOnce(
      new Error('SECRET approval timeout'),
    );
    vi.mocked(beeConnection.connectionState).mockResolvedValueOnce({
      reference: 'private-connection-1',
      status: 'failed',
      walletName: null,
      walletAddress: null,
      credentialReference: null,
      failure: {
        code: 'bee-wallet-approval-timeout',
        message: 'Wallet approval timed out.',
      },
    });
    vi.mocked(beeConnection.prepareMiningCredential).mockRejectedValueOnce(
      new Error('SECRET mining-key rejection'),
    );
    const { service } = fixture({ connection: beeConnection });

    const approvalFailure = await service.beginWalletConnection('wallet-a');
    expect(approvalFailure).toMatchObject({
      accepted: false,
      reasonCode: 'wallet-approval-failed',
      connection: {
        phase: 'failed',
        approval: null,
        miningReady: false,
        lastFailureCode: 'bee-wallet-approval-timeout',
      },
    });
    expect(JSON.stringify(approvalFailure)).not.toContain('SECRET');
    expect(service.getWallets()[0]?.connection.approval).toBeNull();

    await expect(service.disconnectWallet('wallet-a')).resolves.toMatchObject({
      accepted: true,
      connection: { phase: 'disconnected' },
    });
    await expect(service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: true,
      connection: { phase: 'connected', miningReady: false },
    });
    const credentialFailure = await service.prepareWalletMiningCredential('wallet-a');
    expect(credentialFailure).toMatchObject({
      accepted: false,
      reasonCode: 'mining-credential-preparation-failed',
      connection: {
        onboardingStatus: 'failed',
        phase: 'failed',
        miningReady: false,
        lastFailureCode: 'bee-mining-credential-preparation-failed',
      },
    });
    expect(JSON.stringify(credentialFailure)).not.toContain('SECRET');

    await expect(
      service.prepareWalletMiningCredential('wallet-a'),
    ).resolves.toMatchObject({
      accepted: true,
      connection: { phase: 'connected', miningReady: false },
    });
    await expect(
      service.verifyWalletMiningCredentialPropagation('wallet-a'),
    ).resolves.toMatchObject({
      accepted: true,
      connection: { phase: 'connected', miningReady: true },
    });
  });

  it('reports a wallet_hello network read failure separately from wallet rejection', async () => {
    const beeConnection = capability();
    vi.mocked(beeConnection.awaitConnection).mockRejectedValueOnce(
      new Error('wallet_hello GraphQL read failed'),
    );
    vi.mocked(beeConnection.connectionState).mockResolvedValueOnce({
      reference: 'private-connection-1',
      status: 'failed',
      walletName: null,
      walletAddress: null,
      credentialReference: null,
      failure: {
        code: 'bee-wallet-hello-read-failed',
        message: 'Query wallet_hello failed.',
      },
    });
    const { service } = fixture({ connection: beeConnection });

    await expect(service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-hello-read-failed',
      connection: {
        phase: 'failed',
        approval: null,
        miningReady: false,
        lastFailureCode: 'bee-wallet-hello-read-failed',
      },
    });
  });

  it('never reports ready when mining-key propagation verification fails', async () => {
    const beeConnection = capability();
    vi.mocked(
      beeConnection.verifyMiningCredentialPropagation,
    ).mockRejectedValueOnce(new Error('SECRET propagation failure'));
    const { service } = fixture({ connection: beeConnection });

    await service.beginWalletConnection('wallet-a');

    await service.prepareWalletMiningCredential('wallet-a');
    const failed = await service.verifyWalletMiningCredentialPropagation(
      'wallet-a',
    );
    expect(failed).toMatchObject({
      accepted: false,
      reasonCode: 'mining-credential-propagation-failed',
      connection: {
        onboardingStatus: 'failed',
        miningCredentialStored: true,
        miningReady: false,
        lastFailureCode: 'bee-mining-credential-propagation-failed',
      },
    });
    expect(JSON.stringify(failed)).not.toContain('SECRET');

    await expect(
      service.verifyWalletMiningCredentialPropagation('wallet-a'),
    ).resolves.toMatchObject({
      accepted: true,
      connection: { onboardingStatus: 'ready', miningReady: true },
    });
    expect(
      beeConnection.verifyMiningCredentialPropagation,
    ).toHaveBeenCalledTimes(2);
  });

  it('rolls back failed public persistence and can retry without a parallel path', async () => {
    const beeConnection = capability();
    const { service, saveWallet, wallets } = fixture({ connection: beeConnection });
    saveWallet.mockRejectedValueOnce(new Error('SECRET database error'));

    const failed = await service.beginWalletConnection('wallet-a');
    expect(failed).toMatchObject({
      accepted: false,
      reasonCode: 'wallet-state-persistence-failed',
      connection: { phase: 'disconnected', miningReady: false },
    });
    expect(JSON.stringify(failed)).not.toContain('SECRET');
    expect(beeConnection.disconnect).toHaveBeenCalledWith('private-connection-1');
    expect(wallets.wallet('wallet-a')?.connectionReference).toBeNull();

    await expect(service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'wallet-approved',
    });
    expect(beeConnection.beginConnection).toHaveBeenCalledTimes(2);
  });

  it('preserves the connected public state when disconnect fails, then permits retry', async () => {
    const beeConnection = capability();
    vi.mocked(beeConnection.disconnect).mockRejectedValueOnce(
      new Error('SECRET disconnect failure'),
    );
    const { service } = fixture({ connection: beeConnection });
    await service.beginWalletConnection('wallet-a');

    const failure = await service.disconnectWallet('wallet-a');
    expect(failure).toMatchObject({
      accepted: false,
      reasonCode: 'wallet-disconnect-failed',
      connection: {
        phase: 'connected',
        connectionStateStored: true,
        miningReady: false,
      },
    });
    expect(JSON.stringify(failure)).not.toContain('SECRET');

    await expect(service.disconnectWallet('wallet-a')).resolves.toMatchObject({
      accepted: true,
      reasonCode: 'disconnected',
      connection: { phase: 'disconnected' },
    });
  });

  it('rejects stale completion after disposal and prevents public state mutation', async () => {
    let resolveBegin: (value: {
      reference: string;
      deepLink: string;
      expiresAt: number;
    }) => void = () => {
      throw new Error('Connection operation was not started.');
    };
    const beeConnection = capability();
    vi.mocked(beeConnection.beginConnection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBegin = resolve;
        }),
    );
    const { service, wallets } = fixture({ connection: beeConnection });
    const pending = service.beginWalletConnection('wallet-a');

    await vi.waitFor(() => {
      expect(beeConnection.beginConnection).toHaveBeenCalledOnce();
    });
    const disposal = service.dispose();
    expect(service.dispose()).toBe(disposal);
    resolveBegin({
      reference: 'private-stale-reference',
      deepLink: 'acki://approve/stale',
      expiresAt: 700,
    });

    await expect(pending).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-operation-stale',
    });
    await disposal;
    expect(wallets.wallet('wallet-a')).toMatchObject({
      onboardingStatus: 'disconnected',
      connectionReference: null,
    });
    expect(beeConnection.disconnect).toHaveBeenCalledWith(
      'private-stale-reference',
    );
    await expect(service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'application-disposed',
    });
  });

  it('waits for a late approval success, disconnects it, and does not persist connected state', async () => {
    let resolveApproval: (value: {
      reference: string;
      walletName: string;
      walletAddress: string;
    }) => void = () => {
      throw new Error('Approval wait was not started.');
    };
    const beeConnection = capability();
    vi.mocked(beeConnection.awaitConnection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const { service, connectionService, wallets, saveWallet } = fixture({
      connection: beeConnection,
    });
    const pending = service.beginWalletConnection('wallet-a');

    await vi.waitFor(() => {
      expect(beeConnection.awaitConnection).toHaveBeenCalledOnce();
    });
    expect(saveWallet).toHaveBeenCalledOnce();

    const disposal = service.dispose();
    resolveApproval({
      reference: 'private-connection-1',
      walletName: 'bee-wallet',
      walletAddress: '0:late-wallet',
    });

    await expect(pending).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-operation-stale',
    });
    await disposal;

    expect(saveWallet).toHaveBeenCalledOnce();
    expect(wallets.wallet('wallet-a')).toMatchObject({
      onboardingStatus: 'awaiting-connection',
      walletAddress: null,
    });
    expect(beeConnection.disconnect).toHaveBeenCalledWith(
      'private-connection-1',
    );
    expect(connectionService.hasPendingOperation('wallet-a')).toBe(false);
  });

  it('ignores a late approval failure without recreating operation state', async () => {
    let rejectApproval: (error: Error) => void = () => {
      throw new Error('Approval wait was not started.');
    };
    const beeConnection = capability();
    vi.mocked(beeConnection.awaitConnection).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectApproval = reject;
        }),
    );
    const { service, connectionService, wallets } = fixture({
      connection: beeConnection,
    });
    const pending = service.beginWalletConnection('wallet-a');

    await vi.waitFor(() => {
      expect(beeConnection.awaitConnection).toHaveBeenCalledOnce();
    });
    const disposal = service.dispose();
    rejectApproval(new Error('Late native failure'));

    await expect(pending).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-operation-stale',
    });
    await disposal;

    expect(beeConnection.connectionState).not.toHaveBeenCalled();
    expect(beeConnection.disconnect).toHaveBeenCalledWith(
      'private-connection-1',
    );
    expect(connectionService.hasPendingOperation('wallet-a')).toBe(false);
    expect(wallets.wallet('wallet-a')?.onboardingStatus).toBe(
      'awaiting-connection',
    );
  });

  it('does not persist a mining credential completed after disposal', async () => {
    let resolvePreparation: (value: {
      reference: string;
      credentialReference: string;
      walletName: string;
      walletAddress: string;
    }) => void = () => {
      throw new Error('Mining-key preparation was not started.');
    };
    const beeConnection = capability();
    vi.mocked(beeConnection.prepareMiningCredential).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    const { service, wallets, saveWallet } = fixture({
      connection: beeConnection,
    });
    await service.beginWalletConnection('wallet-a');
    saveWallet.mockClear();
    const pending = service.prepareWalletMiningCredential('wallet-a');

    await vi.waitFor(() => {
      expect(beeConnection.prepareMiningCredential).toHaveBeenCalledOnce();
    });
    expect(saveWallet).toHaveBeenCalledOnce();
    const disposal = service.dispose();
    resolvePreparation({
      reference: 'private-connection-1',
      credentialReference: 'private-credential-after-dispose',
      walletName: 'bee-wallet',
      walletAddress: '0:public-wallet',
    });

    await expect(pending).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-operation-stale',
    });
    await disposal;

    expect(saveWallet).toHaveBeenCalledOnce();
    expect(JSON.stringify(saveWallet.mock.calls)).not.toContain(
      'private-credential-after-dispose',
    );
    expect(wallets.wallet('wallet-a')?.miningCredentialReference).toBeNull();
    expect(beeConnection.disconnect).toHaveBeenCalledWith(
      'private-connection-1',
    );
  });

  it('blocks connection changes for an active wallet session', async () => {
    const { service, connection } = fixture({ activeWallet: true });

    await expect(service.beginWalletConnection('wallet-a')).resolves.toMatchObject({
      accepted: false,
      reasonCode: 'wallet-has-active-session',
    });
    expect(connection?.beginConnection).not.toHaveBeenCalled();
  });
});

describe('single QR authorization orchestration',()=>{
  function directCapability() { return {...capability(),flow:'direct-mining-key' as const}; }
  it('completes key setup automatically only after owner verification and does not start mining',async()=>{
    const c=directCapability(); const f=fixture({connection:c});
    const result=await f.service.beginWalletConnection('wallet-a');
    expect(result.accepted).toBe(true);
    expect(c.beginConnection).toHaveBeenCalledWith(expect.objectContaining({walletName:'Alpha',resumeReference:null}));
    expect(c.prepareMiningCredential).toHaveBeenCalledOnce();expect(c.verifyMiningCredentialPropagation).toHaveBeenCalledOnce();
    expect(f.connectionService.presentation('wallet-a').miningReady).toBe(true);
    expect(f.wallets.wallet('wallet-a')?.session).toBeNull();
    expect(f.wallets.wallet('wallet-b')?.connectionReference).toBeNull();
  });
  it('keeps the old mining credential until the replacement is verified',async()=>{
    const c=directCapability(); const f=fixture({connection:c});
    f.wallets.updateConnection('wallet-a',{walletAddress:'0:public-wallet',onboardingStatus:'failed',connectionReference:'old',miningCredentialReference:'old-key'});
    c.awaitConnection.mockRejectedValueOnce(new Error('pending'));
    await f.service.beginWalletConnection('wallet-a');
    expect(f.wallets.wallet('wallet-a')?.miningCredentialReference).toBe('old-key');
    expect(c.disconnect).not.toHaveBeenCalled();expect(c.prepareMiningCredential).not.toHaveBeenCalled();
    expect(f.connectionService.presentation('wallet-a').miningReady).toBe(false);
  });
  it('supports Pause during approval without deleting the request or preparing a credential',async()=>{
    const c=directCapability();
    c.awaitConnection.mockImplementation((_reference:string,signal?:AbortSignal)=>new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(new Error('paused')),{once:true})));
    const f=fixture({connection:c});const running=f.service.beginWalletConnection('wallet-a');
    await vi.waitFor(()=>expect(f.connectionService.presentation('wallet-a').approval?.kind).toBe('mining-key'));
    await f.service.disconnectWallet('wallet-a');await running;
    expect(c.disconnect).not.toHaveBeenCalled();expect(c.prepareMiningCredential).not.toHaveBeenCalled();
    expect(f.wallets.wallet('wallet-a')?.connectionReference).toBe('private-connection-1');
    expect(f.connectionService.presentation('wallet-a').operationPending).toBe(false);
    expect(f.connectionService.presentation('wallet-a').miningReady).toBe(false);
  });
  it('checks duplicate on-chain identity before enabling a second runtime',async()=>{
    const c=directCapability();const f=fixture({connection:c});
    f.wallets.updateConnection('wallet-b',{walletAddress:'0:public-wallet',onboardingStatus:'ready',connectionReference:'b',miningCredentialReference:'b-key'});
    const result=await f.service.beginWalletConnection('wallet-a');expect(result.accepted).toBe(false);
    expect(f.connectionService.presentation('wallet-a').lastFailureCode).toBe('bee-wallet-already-registered');
    expect(c.prepareMiningCredential).not.toHaveBeenCalled();
  });
  it('keeps the same request reference for retry and does not demand a reset',async()=>{
    const c=directCapability();const f=fixture({connection:c}); c.awaitConnection.mockRejectedValueOnce(new Error('pending'));
    await f.service.beginWalletConnection('wallet-a');const ref=f.wallets.wallet('wallet-a')?.connectionReference;
    await f.service.beginWalletConnection('wallet-a');expect(c.beginConnection).toHaveBeenLastCalledWith(expect.objectContaining({resumeReference:ref}));
    expect(c.disconnect).not.toHaveBeenCalled();
  });
  it('continues to reject authorization changes during an active mining session',async()=>{
    const c=directCapability();const f=fixture({connection:c,activeWallet:true});
    expect((await f.service.beginWalletConnection('wallet-a')).accepted).toBe(false);expect(c.beginConnection).not.toHaveBeenCalled();
  });
});
