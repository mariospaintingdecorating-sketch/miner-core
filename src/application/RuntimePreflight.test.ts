import { describe, expect, it, vi } from 'vitest';
import type { BeeSdkGatewayContract } from '../services/bee/contracts';
import { WalletRegistry } from './WalletRegistry';
import { resolveProductionConfiguration } from './productionConfiguration';
import { RuntimePreflight } from './RuntimePreflight';

describe('RuntimePreflight lifecycle cleanup', () => {
  it('forgets removed wallet results and prevents an old assessment from restoring them', async () => {
    let releaseSecureRead!: () => void;
    const secureRead = new Promise<void>((resolve) => {
      releaseSecureRead = resolve;
    });
    const registry = new WalletRegistry([{
      id: 'wallet-a',
      name: 'Alpha',
      onboardingStatus: 'ready',
      connectionReference: 'connection-a',
      miningCredentialReference: 'credential-a',
    }]);
    const gateway: BeeSdkGatewayContract = {
      initialize: vi.fn(async () => undefined),
      readiness: () => Object.freeze({
        status: 'ready',
        version: 'test',
        failure: null,
      }),
      dispose: vi.fn(async () => undefined),
    };
    const preflight = new RuntimePreflight(
      resolveProductionConfiguration({
        endpoints: ['https://example.test'],
        appId: 'test-app-id',
      }),
      gateway,
      registry,
      {
        hasSecureValue: vi.fn(async () => {
          await secureRead;
          return true;
        }),
      },
      null,
      { verifyMiningCredentialPropagation: vi.fn(async () => undefined) },
      {
        readiness: () => Object.freeze({
          status: 'ready' as const,
          code: 'test-pacing-ready',
          message: 'Tap pacing is ready.',
        }),
      },
      () => 'idle',
    );

    const oldAssessment = preflight.assess('wallet-a');
    preflight.forgetWallet('wallet-a');
    registry.removeWallet('wallet-a');
    releaseSecureRead();
    await oldAssessment;

    expect(preflight.preview('wallet-a')).toMatchObject({
      ready: false,
      reasonCode: 'wallet-not-found',
    });

    preflight.dispose();
    await expect(preflight.assess('wallet-a')).rejects.toThrow('disposed');
  });

  it('inspects current static readiness without secure or binding I/O', () => {
    const initialize = vi.fn(async () => undefined);
    const hasSecureValue = vi.fn(async () => true);
    const verifyMiningCredentialPropagation = vi.fn(async () => undefined);
    let runtimeStatus: 'idle' | 'running' = 'idle';
    const preflight = new RuntimePreflight(
      resolveProductionConfiguration({
        endpoints: ['https://example.test'],
        appId: 'test-app-id',
      }),
      {
        initialize,
        readiness: () => Object.freeze({
          status: 'ready' as const,
          version: 'test',
          failure: null,
        }),
        dispose: vi.fn(async () => undefined),
      },
      new WalletRegistry([{
        id: 'wallet-a',
        name: 'Alpha',
        onboardingStatus: 'ready',
        connectionReference: 'connection-a',
        miningCredentialReference: 'credential-a',
      }]),
      { hasSecureValue },
      null,
      { verifyMiningCredentialPropagation },
      {
        readiness: () => Object.freeze({
          status: 'ready' as const,
          code: 'test-pacing-ready',
          message: 'Tap pacing is ready.',
        }),
      },
      () => runtimeStatus,
    );

    expect(preflight.inspect('wallet-a')).toMatchObject({
      ready: true,
      reasonCode: 'ready',
    });
    runtimeStatus = 'running';
    expect(preflight.inspect('wallet-a')).toMatchObject({
      ready: false,
      reasonCode: 'runtime-not-idle',
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(hasSecureValue).not.toHaveBeenCalled();
    expect(verifyMiningCredentialPropagation).not.toHaveBeenCalled();
  });
});
