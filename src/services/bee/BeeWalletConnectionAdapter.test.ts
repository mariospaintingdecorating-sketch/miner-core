import { describe, expect, it, vi } from 'vitest';
import { RuntimeDiagnostics } from '../../application/RuntimeDiagnostics';
import { CoreEventEmitter } from '../../shared/events';
import type { SecureReferenceStorageContract } from '../../storage/contracts';
import { BeeSdkGateway } from './BeeSdkGateway';
import type {
  BeeNativeConnect,
  BeeNativeMiner,
  BeeNativeSdkFactory,
} from './BeeNativeSdk';
import { BeeWalletConnectionAdapter } from './BeeWalletConnectionAdapter';

class MemorySecureStorage implements SecureReferenceStorageContract {
  readonly values = new Map<string, string>();

  async saveSecureValue(reference: string, value: string): Promise<void> {
    this.values.set(reference, value);
  }

  async loadSecureValue(reference: string): Promise<string | null> {
    return this.values.get(reference) ?? null;
  }

  async hasSecureValue(reference: string): Promise<boolean> {
    return this.values.has(reference);
  }

  async removeSecureValue(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

function resource<T extends object>(fields: T) {
  return { ...fields, free: vi.fn<() => void>() };
}

function fixture(waitFailure?: Error): {
  storage: MemorySecureStorage;
  gateway: BeeSdkGateway;
  eventBus: CoreEventEmitter;
  connect: BeeNativeConnect;
  nativeSdk: BeeNativeSdkFactory;
} {
  const storage = new MemorySecureStorage();
  const eventBus = new CoreEventEmitter();
  const connect = resource({
    create_shared_key_session: vi.fn(() =>
      resource({
        client_dh_secret: 'dh-secret',
        created_at: 100n,
        deep_link: 'acki://approve/opaque-payload',
        description: 'Core Miner',
        expires_at: 400n,
        session_id: 'sdk-session',
      }),
    ),
    wait_wallet_hello: vi.fn(async () => {
      if (waitFailure) {
        throw waitFailure;
      }

      return resource({
        session_state_json: '{"encrypted":"session"}',
        wallet_address: '0:wallet-address',
        wallet_name: 'alpha-wallet',
      });
    }),
    request_set_mining_keys: vi.fn(async () =>
      resource({ updated_session_state_json: '{"encrypted":"updated"}' }),
    ),
    disconnect_session: vi.fn(async () =>
      resource({ updated_session_state_json: '{"encrypted":"closed"}' }),
    ),
  }) satisfies BeeNativeConnect;
  const nativeSdk: BeeNativeSdkFactory = {
    createConnect: vi.fn(() => connect),
    generateMiningKeys: vi.fn(async () =>
      resource({ public: 'mining-public', secret: 'mining-secret' }),
    ),
    resolveMinerAddress: vi.fn(async () => '0:miner-address'),
    ensureMiningKeysPropagated: vi.fn(async () => undefined),
    createMiner: vi.fn(async () =>
      resource({
        add_tap: vi.fn(),
        can_start: vi.fn(() => true),
        get_reward: vi.fn(async () => undefined),
        start: vi.fn(),
        stop: vi.fn(),
      }) satisfies BeeNativeMiner,
    ),
  };
  const gateway = new BeeSdkGateway(
    {
      initialize: vi.fn(async () => undefined),
      version: vi.fn(() => '3.1.0'),
      dispose: vi.fn(),
    },
    eventBus,
  );
  return { storage, gateway, eventBus, connect, nativeSdk };
}

function references(): (kind: 'connection' | 'credential') => string {
  return (kind) =>
    kind === 'connection' ? 'connection-ref' : 'credential-ref';
}

describe('BeeWalletConnectionAdapter', () => {
  it('runs approval and app-specific mining-key flow through secure references', async () => {
    const { storage, gateway, eventBus, connect, nativeSdk } = fixture();
    const diagnostics = new RuntimeDiagnostics(eventBus);
    const adapter = new BeeWalletConnectionAdapter(
      gateway,
      storage,
      { endpoints: ['https://node.example'], appId: 'app-id' },
      nativeSdk,
      eventBus,
      references(),
      () => '2026-08-04T12:00:00.000Z',
    );

    const approval = await adapter.beginConnection();
    expect(approval).toEqual({
      reference: 'connection-ref',
      deepLink: 'acki://approve/opaque-payload',
      expiresAt: 400,
    });
    expect(connect.create_shared_key_session).toHaveBeenCalledWith(
      'app-id',
      31_536_000,
      null,
    );
    expect(await adapter.connectionState('connection-ref')).toMatchObject({
      status: 'awaiting-approval',
      walletName: null,
    });

    const connected = await adapter.awaitConnection('connection-ref');
    expect(connected).toEqual({
      reference: 'connection-ref',
      walletName: 'alpha-wallet',
      walletAddress: '0:wallet-address',
    });
    expect(connect.wait_wallet_hello).toHaveBeenCalledWith(
      ['https://node.example'],
      'sdk-session',
      'Core Miner',
      'dh-secret',
      100n,
      90,
      2_000,
    );

    const credential = await adapter.prepareMiningCredential('connection-ref');
    expect(credential).toEqual({
      reference: 'connection-ref',
      credentialReference: 'credential-ref',
      walletName: 'alpha-wallet',
      walletAddress: '0:wallet-address',
    });
    expect(nativeSdk.generateMiningKeys).toHaveBeenCalledWith([
      'https://node.example',
    ]);
    expect(connect.request_set_mining_keys).toHaveBeenCalledWith(
      ['https://node.example'],
      'sdk-session',
      'Core Miner',
      '{"encrypted":"session"}',
      'app-id',
      'mining-public',
      30,
      2_000,
    );
    expect(storage.values.get('credential-ref')).toContain('mining-secret');
    await adapter.verifyMiningCredentialPropagation(
      'connection-ref',
      'credential-ref',
    );
    expect(nativeSdk.ensureMiningKeysPropagated).toHaveBeenCalledWith(
      ['https://node.example'],
      'app-id',
      '0:miner-address',
      'mining-public',
      60,
      2_000,
    );

    const publicValues = JSON.stringify({
      approval,
      connected,
      credential,
      state: await adapter.connectionState('connection-ref'),
      diagnostics: diagnostics.entries(),
    });
    expect(publicValues).not.toContain('dh-secret');
    expect(publicValues).not.toContain('mining-secret');
    expect(publicValues).not.toContain('session_state_json');
    expect(diagnostics.entries().map((entry) => entry.eventType)).toEqual(
      expect.arrayContaining([
        'bee-sdk-ready',
        'bee-wallet-connection-started',
        'bee-wallet-connected',
      ]),
    );
    expect(JSON.stringify(diagnostics.entries())).not.toContain('connection-ref');

    await adapter.disconnect('connection-ref');
    expect(storage.values.has('connection-ref')).toBe(false);
    expect(storage.values.has('credential-ref')).toBe(false);
    expect(await adapter.connectionState('connection-ref')).toMatchObject({
      status: 'disconnected',
    });
    await gateway.dispose();
    expect(connect.free).toHaveBeenCalledOnce();
  });

  it('records a sanitized failure state without exposing connection secrets', async () => {
    const { storage, gateway, eventBus, nativeSdk } = fixture(
      new Error('Wallet approval expired'),
    );
    const diagnostics = new RuntimeDiagnostics(eventBus);
    const adapter = new BeeWalletConnectionAdapter(
      gateway,
      storage,
      { endpoints: ['https://node.example'], appId: 'app-id' },
      nativeSdk,
      eventBus,
      references(),
    );
    await adapter.beginConnection();

    await expect(adapter.awaitConnection('connection-ref')).rejects.toThrow(
      'Wallet approval expired',
    );

    const state = await adapter.connectionState('connection-ref');
    expect(state).toMatchObject({
      status: 'failed',
      failure: {
        code: 'bee-wallet-approval-timeout',
        message: 'Wallet approval expired',
      },
    });
    expect(JSON.stringify(state)).not.toContain('dh-secret');
    expect(JSON.stringify(diagnostics.entries())).not.toContain('connection-ref');
    await gateway.dispose();
  });

  it('retries a transient wallet_hello GraphQL read on the same secure session', async () => {
    const { storage, gateway, eventBus, connect, nativeSdk } = fixture();
    vi.mocked(connect.wait_wallet_hello).mockRejectedValueOnce(
      new Error(
        'Query wallet_hello: AuthProfile::query_context_added_events: Query AuthProfile events with GraphQL',
      ),
    );
    const retryDelay = vi.fn(async (_milliseconds: number) => undefined);
    const adapter = new BeeWalletConnectionAdapter(
      gateway,
      storage,
      { endpoints: ['https://node.example'], appId: 'app-id' },
      nativeSdk,
      eventBus,
      references(),
      () => '2026-08-04T12:00:00.000Z',
      retryDelay,
    );

    await adapter.beginConnection();

    await expect(adapter.awaitConnection('connection-ref')).resolves.toMatchObject({
      walletName: 'alpha-wallet',
      walletAddress: '0:wallet-address',
    });
    expect(connect.create_shared_key_session).toHaveBeenCalledOnce();
    expect(connect.wait_wallet_hello).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledWith(2_000);
    await expect(adapter.connectionState('connection-ref')).resolves.toMatchObject({
      status: 'connected',
      failure: null,
    });
    await gateway.dispose();
  });

  it('classifies exhausted wallet_hello GraphQL reads separately from wallet rejection', async () => {
    const readFailure = new Error(
      'Query wallet_hello: AuthProfile::query_context_added_events: Query AuthProfile events with GraphQL',
    );
    const { storage, gateway, eventBus, connect, nativeSdk } = fixture(readFailure);
    const retryDelay = vi.fn(async (_milliseconds: number) => undefined);
    const adapter = new BeeWalletConnectionAdapter(
      gateway,
      storage,
      { endpoints: ['https://node.example'], appId: 'app-id' },
      nativeSdk,
      eventBus,
      references(),
      () => '2026-08-04T12:00:00.000Z',
      retryDelay,
    );

    await adapter.beginConnection();

    await expect(adapter.awaitConnection('connection-ref')).rejects.toThrow(
      'Query wallet_hello',
    );
    expect(connect.create_shared_key_session).toHaveBeenCalledOnce();
    expect(connect.wait_wallet_hello).toHaveBeenCalledTimes(4);
    expect(retryDelay.mock.calls.map(([delay]) => delay)).toEqual([
      2_000,
      4_000,
      8_000,
    ]);
    await expect(adapter.connectionState('connection-ref')).resolves.toMatchObject({
      status: 'failed',
      failure: {
        code: 'bee-wallet-hello-read-failed',
      },
    });
    await gateway.dispose();
  });

  it('reuses securely completed approval and mining-key work without duplicate native calls', async () => {
    const { storage, gateway, eventBus, connect, nativeSdk } = fixture();
    const adapter = new BeeWalletConnectionAdapter(
      gateway,
      storage,
      { endpoints: ['https://node.example'], appId: 'app-id' },
      nativeSdk,
      eventBus,
      references(),
    );

    await adapter.beginConnection();
    const firstApproval = await adapter.awaitConnection('connection-ref');
    const repeatedApproval = await adapter.awaitConnection('connection-ref');
    const firstCredential = await adapter.prepareMiningCredential('connection-ref');
    const repeatedCredential = await adapter.prepareMiningCredential('connection-ref');

    expect(repeatedApproval).toEqual(firstApproval);
    expect(repeatedCredential).toEqual(firstCredential);
    expect(connect.wait_wallet_hello).toHaveBeenCalledOnce();
    expect(connect.request_set_mining_keys).toHaveBeenCalledOnce();
    expect(nativeSdk.generateMiningKeys).toHaveBeenCalledOnce();
    await gateway.dispose();
  });

  it('keeps an approved connection retryable after mining-key setup fails', async () => {
    const { storage, gateway, eventBus, connect, nativeSdk } = fixture();
    vi.mocked(connect.request_set_mining_keys).mockRejectedValueOnce(
      new Error('temporary setup failure'),
    );
    const adapter = new BeeWalletConnectionAdapter(
      gateway,
      storage,
      { endpoints: ['https://node.example'], appId: 'app-id' },
      nativeSdk,
      eventBus,
      references(),
    );

    await adapter.beginConnection();
    await adapter.awaitConnection('connection-ref');
    await expect(
      adapter.prepareMiningCredential('connection-ref'),
    ).rejects.toThrow('temporary setup failure');
    await expect(adapter.connectionState('connection-ref')).resolves.toMatchObject({
      status: 'connected',
      credentialReference: null,
      failure: { code: 'bee-mining-credential-preparation-failed' },
    });

    await expect(
      adapter.prepareMiningCredential('connection-ref'),
    ).resolves.toMatchObject({ credentialReference: 'credential-ref' });
    expect(connect.request_set_mining_keys).toHaveBeenCalledTimes(1);
    expect(nativeSdk.generateMiningKeys).toHaveBeenCalledTimes(1);
    expect(nativeSdk.ensureMiningKeysPropagated).toHaveBeenCalledTimes(1);
    await gateway.dispose();
  });

  it('records the real propagation failure for diagnostics and remains retryable', async () => {
    const { storage, gateway, eventBus, nativeSdk } = fixture();
    vi.mocked(nativeSdk.ensureMiningKeysPropagated).mockRejectedValueOnce(
      new Error('Mining key owner mismatch'),
    );
    const diagnostics = new RuntimeDiagnostics(eventBus);
    const adapter = new BeeWalletConnectionAdapter(
      gateway,
      storage,
      { endpoints: ['https://node.example'], appId: 'app-id' },
      nativeSdk,
      eventBus,
      references(),
    );

    await adapter.beginConnection();
    await adapter.awaitConnection('connection-ref');
    await adapter.prepareMiningCredential('connection-ref');

    await expect(
      adapter.verifyMiningCredentialPropagation(
        'connection-ref',
        'credential-ref',
      ),
    ).rejects.toThrow('Mining key owner mismatch');
    await expect(adapter.connectionState('connection-ref')).resolves.toMatchObject({
      status: 'connected',
      failure: {
        code: 'bee-mining-credential-propagation-failed',
        message: 'Mining key owner mismatch',
      },
    });
    expect(JSON.stringify(diagnostics.entries())).toContain(
      'Mining key owner mismatch',
    );

    await expect(
      adapter.verifyMiningCredentialPropagation(
        'connection-ref',
        'credential-ref',
      ),
    ).resolves.toBeUndefined();
    await expect(adapter.connectionState('connection-ref')).resolves.toMatchObject({
      failure: null,
    });
    await gateway.dispose();
  });
});

describe('DApp migration and recoverable mining-key authorization', () => {
  function currentAdapter(f: ReturnType<typeof fixture>, appId = 'app-id') {
    return new BeeWalletConnectionAdapter(f.gateway, f.storage,
      { endpoints: ['https://node.example'], appId }, f.nativeSdk, f.eventBus,
      references(), () => '2026-09-20T12:00:00.000Z');
  }
  async function connected() {
    const f = fixture(); const adapter = currentAdapter(f);
    await adapter.beginConnection(); await adapter.awaitConnection('connection-ref');
    return { ...f, adapter };
  }
  it('saves the pending key before the authorization request, without reporting it as verified', async () => {
    const f = await connected();
    vi.mocked(f.connect.request_set_mining_keys).mockImplementationOnce(async () => {
      const state = JSON.parse(f.storage.values.get('connection-ref')!);
      expect(state.pendingMiningCredential).toMatchObject({ secretKey: 'mining-secret',
        appId: 'app-id', approval: 'requesting' });
      expect(state.credentialReference).toBeNull();
      return resource({ updated_session_state_json: 'approved-session' });
    });
    await f.adapter.prepareMiningCredential('connection-ref');
    expect(JSON.parse(f.storage.values.get('credential-ref')!)).toMatchObject({
      appId: 'app-id', verifiedAppId: null, verifiedAt: null,
    });
    await f.adapter.verifyMiningCredentialPropagation('connection-ref', 'credential-ref');
    expect(JSON.parse(f.storage.values.get('credential-ref')!)).toMatchObject({
      verifiedAppId: 'app-id', verifiedAt: '2026-09-20T12:00:00.000Z', secretKey: 'mining-secret',
    });
  });
  it('does not mark a rejected propagation check as verified', async () => {
    const f = await connected(); await f.adapter.prepareMiningCredential('connection-ref');
    vi.mocked(f.nativeSdk.ensureMiningKeysPropagated).mockRejectedValueOnce(new Error('Owner mismatch'));
    await expect(f.adapter.verifyMiningCredentialPropagation('connection-ref', 'credential-ref')).rejects.toThrow('Owner mismatch');
    expect(JSON.parse(f.storage.values.get('credential-ref')!).verifiedAppId).toBeNull();
  });
  it('does not regenerate keys or resend authorization after an ambiguous failure', async () => {
    const f = await connected();
    vi.mocked(f.connect.request_set_mining_keys).mockRejectedValueOnce(new Error('Connection lost after send'));
    await expect(f.adapter.prepareMiningCredential('connection-ref')).rejects.toThrow();
    vi.mocked(f.nativeSdk.ensureMiningKeysPropagated).mockRejectedValueOnce(new Error('Not yet on chain'));
    await expect(f.adapter.prepareMiningCredential('connection-ref')).rejects.toThrow('still unconfirmed');
    expect(f.connect.request_set_mining_keys).toHaveBeenCalledOnce();
    expect(f.nativeSdk.generateMiningKeys).toHaveBeenCalledOnce();
    expect(JSON.parse(f.storage.values.get('connection-ref')!).pendingMiningCredential.secretKey).toBe('mining-secret');
  });
  it('recovers the same pending key after an application-adapter restart using a read-only check', async () => {
    const f = await connected();
    vi.mocked(f.connect.request_set_mining_keys).mockRejectedValueOnce(new Error('timeout'));
    await expect(f.adapter.prepareMiningCredential('connection-ref')).rejects.toThrow();
    const restored = currentAdapter(f);
    await expect(restored.prepareMiningCredential('connection-ref')).resolves.toMatchObject({ credentialReference: 'credential-ref' });
    expect(f.nativeSdk.generateMiningKeys).toHaveBeenCalledOnce();
    expect(f.connect.request_set_mining_keys).toHaveBeenCalledOnce();
    expect(f.nativeSdk.ensureMiningKeysPropagated).toHaveBeenCalledOnce();
  });
  it('does not submit an authorization if secure pending-key persistence fails', async () => {
    const f = await connected();
    const save = f.storage.saveSecureValue.bind(f.storage);
    vi.spyOn(f.storage, 'saveSecureValue').mockImplementation(async (ref, raw) => {
      if (JSON.parse(raw).pendingMiningCredential) throw new Error('Disk full');
      return save(ref, raw);
    });
    await expect(f.adapter.prepareMiningCredential('connection-ref')).rejects.toThrow('Disk full');
    expect(f.connect.request_set_mining_keys).not.toHaveBeenCalled();
  });
  it('preserves an approved pending key if the final connection commit fails', async () => {
    const f = await connected(); const save = f.storage.saveSecureValue.bind(f.storage);
    let rejectCommit = true;
    vi.spyOn(f.storage, 'saveSecureValue').mockImplementation(async (ref, raw) => {
      const p = JSON.parse(raw);
      if (rejectCommit && ref === 'connection-ref' && p.credentialReference) throw new Error('commit failed');
      return save(ref, raw);
    });
    await expect(f.adapter.prepareMiningCredential('connection-ref')).rejects.toThrow('commit failed');
    expect(JSON.parse(f.storage.values.get('connection-ref')!).pendingMiningCredential.approval).toBe('approved');
    expect(f.storage.values.has('credential-ref')).toBe(true);
    rejectCommit = false; await f.adapter.prepareMiningCredential('connection-ref');
    expect(f.connect.request_set_mining_keys).toHaveBeenCalledOnce();
    expect(f.nativeSdk.generateMiningKeys).toHaveBeenCalledOnce();
  });
  it('does not use a connection issued for another DApp to authorize new mining keys', async () => {
    const f = await connected(); const migrated = currentAdapter(f, 'new-app-id');
    await expect(migrated.prepareMiningCredential('connection-ref')).rejects.toThrow('DApp context changed');
    expect(f.connect.request_set_mining_keys).not.toHaveBeenCalled();
    expect(f.nativeSdk.generateMiningKeys).not.toHaveBeenCalled();
  });
  it('can verify an existing legacy key for the new DApp without changing its secret', async () => {
    const f = await connected(); await f.adapter.prepareMiningCredential('connection-ref');
    const p = JSON.parse(f.storage.values.get('credential-ref')!);
    delete p.appId; delete p.verifiedAppId; delete p.verifiedAt;
    f.storage.values.set('credential-ref', JSON.stringify(p));
    const migrated = currentAdapter(f, 'new-app-id');
    await migrated.verifyMiningCredentialPropagation('connection-ref', 'credential-ref');
    expect(JSON.parse(f.storage.values.get('credential-ref')!)).toMatchObject({
      appId: 'new-app-id', verifiedAppId: 'new-app-id', secretKey: 'mining-secret',
    });
    expect(f.nativeSdk.ensureMiningKeysPropagated).toHaveBeenLastCalledWith(
      ['https://node.example'], 'new-app-id', '0:miner-address', 'mining-public', 60, 2000);
    expect(f.connect.request_set_mining_keys).toHaveBeenCalledOnce();
  });
  it('does not restore deleted records when a late verification completes', async () => {
    const f = await connected(); await f.adapter.prepareMiningCredential('connection-ref');
    vi.mocked(f.nativeSdk.ensureMiningKeysPropagated).mockImplementationOnce(async () => {
      f.storage.values.delete('credential-ref'); f.storage.values.delete('connection-ref');
    });
    await expect(f.adapter.verifyMiningCredentialPropagation('connection-ref', 'credential-ref')).rejects.toThrow('changed');
    expect(f.storage.values.size).toBe(0);
  });
  it('deduplicates concurrent preparation of one connection', async () => {
    const f = await connected(); const a = f.adapter.prepareMiningCredential('connection-ref');
    const b = f.adapter.prepareMiningCredential('connection-ref'); expect(a).toBe(b);
    await Promise.all([a, b]); expect(f.nativeSdk.generateMiningKeys).toHaveBeenCalledOnce();
    expect(f.connect.request_set_mining_keys).toHaveBeenCalledOnce();
  });
});
