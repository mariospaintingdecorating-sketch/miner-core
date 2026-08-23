import { describe, expect, it } from 'vitest';
import { WalletRegistry } from './WalletRegistry';

describe('WalletRegistry', () => {
  it('owns isolated wallet identity, status, and session association', () => {
    const registry = new WalletRegistry([
      { id: 'wallet-a', name: 'Alpha' },
      { id: 'wallet-b', name: 'Beta', status: 'offline' },
    ]);

    registry.updateStatus('wallet-a', 'running');
    registry.associateSession('wallet-a', {
      sessionId: 'session-a',
      generation: 3,
    });

    expect(registry.wallet('wallet-a')).toEqual({
      id: 'wallet-a',
      name: 'Alpha',
      status: 'running',
      walletAddress: null,
      onboardingStatus: 'disconnected',
      connectionReference: null,
      miningCredentialReference: null,
      mamaBoardLevel: null,
      session: { sessionId: 'session-a', generation: 3 },
    });
    expect(registry.wallet('wallet-b')).toEqual({
      id: 'wallet-b',
      name: 'Beta',
      status: 'offline',
      walletAddress: null,
      onboardingStatus: 'disconnected',
      connectionReference: null,
      miningCredentialReference: null,
      mamaBoardLevel: null,
      session: null,
    });
    expect(Object.isFrozen(registry.wallet('wallet-a'))).toBe(true);
    expect(Object.isFrozen(registry.wallet('wallet-a')?.session)).toBe(true);
  });

  it('prevents an older association from replacing a wallet generation', () => {
    const registry = new WalletRegistry([{ id: 'wallet-a', name: 'Alpha' }]);
    registry.associateSession('wallet-a', {
      sessionId: 'session-4',
      generation: 4,
    });

    expect(
      registry.associateSession('wallet-a', {
        sessionId: 'session-3',
        generation: 3,
      }),
    ).toBe(false);
    expect(registry.wallet('wallet-a')?.session).toEqual({
      sessionId: 'session-4',
      generation: 4,
    });
    expect(
      registry.clearSession('wallet-a', {
        sessionId: 'session-3',
        generation: 3,
      }),
    ).toBe(false);
    expect(
      registry.clearSession('wallet-a', {
        sessionId: 'session-4',
        generation: 4,
      }),
    ).toBe(true);
    expect(registry.wallet('wallet-a')?.session).toBeNull();
  });

  it('owns public wallet connection state without exposing lifecycle control', () => {
    const registry = new WalletRegistry([{ id: 'wallet-a', name: 'Alpha' }]);

    expect(
      registry.updateConnection('wallet-a', {
        walletAddress: '0:public-wallet',
        onboardingStatus: 'ready',
        connectionReference: 'secure-connection-reference',
        miningCredentialReference: 'secure-credential-reference',
      }),
    ).toBe(true);
    expect(registry.wallet('wallet-a')).toMatchObject({
      walletAddress: '0:public-wallet',
      onboardingStatus: 'ready',
      connectionReference: 'secure-connection-reference',
      miningCredentialReference: 'secure-credential-reference',
    });
    expect(
      registry.updateConnection('missing', {
        walletAddress: null,
        onboardingStatus: 'disconnected',
        connectionReference: null,
        miningCredentialReference: null,
      }),
    ).toBe(false);
  });

  it('owns every explicit wallet onboarding state', () => {
    const registry = new WalletRegistry([{ id: 'wallet-a', name: 'Alpha' }]);
    const states = [
      'disconnected',
      'awaiting-connection',
      'connected',
      'awaiting-mining-key-approval',
      'propagating-mining-key',
      'ready',
      'failed',
    ] as const;

    for (const onboardingStatus of states) {
      expect(
        registry.updateConnection('wallet-a', {
          walletAddress: null,
          onboardingStatus,
          connectionReference: null,
          miningCredentialReference: null,
        }),
      ).toBe(true);
      expect(registry.wallet('wallet-a')?.onboardingStatus).toBe(
        onboardingStatus,
      );
    }
  });

  it('owns independent nullable MamaBoard metadata per wallet', () => {
    const registry = new WalletRegistry([
      { id: 'wallet-a', name: 'Alpha', mamaBoardLevel: 12 },
      { id: 'wallet-b', name: 'Beta' },
    ]);

    expect(registry.wallet('wallet-a')?.mamaBoardLevel).toBe(12);
    expect(registry.wallet('wallet-b')?.mamaBoardLevel).toBeNull();
    expect(registry.updateMamaBoardLevel('wallet-b', 72)).toBe(true);
    expect(registry.wallet('wallet-a')?.mamaBoardLevel).toBe(12);
    expect(registry.wallet('wallet-b')?.mamaBoardLevel).toBe(72);
    expect(() => registry.updateMamaBoardLevel('wallet-a', 73)).toThrow(
      /0 to 72/,
    );
  });

  it('rejects duplicate identity without modifying the registered wallet', () => {
    const registry = new WalletRegistry([{ id: 'wallet-a', name: 'Alpha' }]);

    expect(() =>
      registry.registerWallet({ id: 'wallet-a', name: 'Replacement' }),
    ).toThrow(/already registered/);
    expect(registry.wallets()).toHaveLength(1);
    expect(registry.wallet('wallet-a')?.name).toBe('Alpha');
  });

  it('trims new profile names and enforces the wallet name limits', () => {
    const registry = new WalletRegistry();

    expect(
      registry.registerWallet({ id: 'wallet-a', name: '  Alpha  ' }),
    ).toMatchObject({ name: 'Alpha' });
    expect(() =>
      registry.registerWallet({ id: 'wallet-b', name: 'A' }),
    ).toThrow(/between 2 and 80/);
    expect(() =>
      registry.registerWallet({ id: 'wallet-c', name: 'A'.repeat(81) }),
    ).toThrow(/between 2 and 80/);
  });

  it('rejects duplicate new profile names without changing restored wallets', () => {
    const restored = new WalletRegistry([
      { id: 'legacy-a', name: 'Existing' },
      { id: 'legacy-b', name: 'existing' },
    ]);

    expect(restored.wallets()).toHaveLength(2);
    expect(() =>
      restored.registerWallet({ id: 'wallet-c', name: ' EXISTING ' }),
    ).toThrow(/name is already registered/);
    expect(restored.wallets()).toHaveLength(2);
  });

  it('removes only the matching wallet without affecting another wallet', () => {
    const registry = new WalletRegistry([
      { id: 'wallet-a', name: 'Alpha' },
      { id: 'wallet-b', name: 'Beta' },
    ]);

    expect(registry.removeWallet('wallet-a')).toMatchObject({ id: 'wallet-a' });
    expect(registry.removeWallet('wallet-a')).toBeNull();
    expect(registry.wallet('wallet-a')).toBeNull();
    expect(registry.wallet('wallet-b')).toMatchObject({ name: 'Beta' });
  });

  it('does not expose mining lifecycle controls', () => {
    const registry = new WalletRegistry();

    expect('start' in registry).toBe(false);
    expect('stop' in registry).toBe(false);
    expect('restart' in registry).toBe(false);
    expect('createSession' in registry).toBe(false);
  });
});
