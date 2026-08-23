import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimePresentationUpdate,
  RuntimePresentationState,
  WalletPresentation,
  WalletPresentationUpdate,
  WalletRuntimePresentationStates,
} from '../../application';
import {
  rendererPresentationMetrics,
  resetRendererPresentationMetricsForTests,
} from '../presentationMetrics';
import {
  mergeCurrentRuntimePresentation,
  mergeRuntimePresentationUpdate,
  mergeWalletPresentationUpdate,
  subscribeToRuntimePresentation,
} from './useMinerPresentation';

describe('runtime presentation subscription', () => {
  it('updates only the lightweight runtime projection and cleans up once', () => {
    resetRendererPresentationMetricsForTests();
    const unsubscribe = vi.fn();
    let deliver!: (update: Readonly<RuntimePresentationUpdate>) => void;
    const subscribeToRuntimeUpdates = vi.fn(
      (listener: (update: Readonly<RuntimePresentationUpdate>) => void) => {
      deliver = listener;
      return unsubscribe;
      },
    );
    const listener = vi.fn();
    const release = subscribeToRuntimePresentation(
      { subscribeToRuntimeUpdates },
      listener,
    );
    const state = { runtimeStatus: 'running' } as RuntimePresentationState;
    const update: RuntimePresentationUpdate = {
      scope: 'wallet',
      walletId: 'wallet-a',
      currentRuntimeState: state,
      runtimeStates: new Map([['wallet-a', state]]),
    };

    deliver(update);
    expect(listener).toHaveBeenCalledWith(update);
    expect(subscribeToRuntimeUpdates).toHaveBeenCalledOnce();
    expect(rendererPresentationMetrics().activeSubscriptions).toBe(1);

    release();
    release();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(rendererPresentationMetrics().activeSubscriptions).toBe(0);
  });

  it('replaces only one runtime entry and preserves the other twelve references', () => {
    const states = new Map(
      Array.from({ length: 13 }, (_, index) => {
        const walletId = `wallet-${index + 1}`;
        return [
          walletId,
          { runtimeStatus: 'idle' } as RuntimePresentationState,
        ] as const;
      }),
    );
    const updated = { runtimeStatus: 'running' } as RuntimePresentationState;

    const next = mergeRuntimePresentationUpdate(states, {
      scope: 'wallet',
      walletId: 'wallet-1',
      currentRuntimeState: updated,
      runtimeStates: new Map([['wallet-1', updated]]),
    });

    expect(next.get('wallet-1')).toBe(updated);
    for (let index = 2; index <= 13; index += 1) {
      expect(next.get(`wallet-${index}`)).toBe(states.get(`wallet-${index}`));
    }
  });

  it('updates global canonical epochs without rebuilding wallet runtime projections', () => {
    const currentEpochs = { miniEpoch: { id: '12000' } } as RuntimePresentationState['epochs'];
    const nextEpochs = {
      miniEpoch: { id: '13000', progressPercent: 40 },
      mainEpoch: { id: '0', progressPercent: 4 },
    } as RuntimePresentationState['epochs'];
    const current = {
      runtimeStatus: 'stopping',
      epochs: currentEpochs,
    } as RuntimePresentationState;
    const runtimeStates = new Map([
      ['wallet-a', current],
      ['wallet-b', current],
    ]);
    const update: RuntimePresentationUpdate = {
      scope: 'canonical',
      walletId: null,
      currentRuntimeState: null,
      runtimeStates: new Map(),
      canonicalEpochs: nextEpochs,
    };

    expect(mergeRuntimePresentationUpdate(runtimeStates, update)).toBe(
      runtimeStates,
    );
    expect(mergeCurrentRuntimePresentation(current, update)).toMatchObject({
      runtimeStatus: 'stopping',
      epochs: nextEpochs,
    });
  });

  it('does not let a late wallet projection move global epochs backward', () => {
    const currentEpochs = {
      miniEpoch: { id: '13000', progressPercent: 40 },
      mainEpoch: { id: '0', progressPercent: 4 },
    } as RuntimePresentationState['epochs'];
    const staleEpochs = {
      miniEpoch: { id: '12000', progressPercent: 100 },
      mainEpoch: { id: '0', progressPercent: 3 },
    } as RuntimePresentationState['epochs'];
    const current = {
      runtimeStatus: 'stopping',
      epochs: currentEpochs,
    } as RuntimePresentationState;
    const staleWallet = {
      runtimeStatus: 'waiting',
      epochs: staleEpochs,
    } as RuntimePresentationState;

    const next = mergeCurrentRuntimePresentation(current, {
      scope: 'wallet',
      walletId: 'wallet-a',
      currentRuntimeState: staleWallet,
      runtimeStates: new Map([['wallet-a', staleWallet]]),
    });

    expect(next.runtimeStatus).toBe('waiting');
    expect(next.epochs).toBe(currentEpochs);
    expect(next.epochs.miniEpoch.id).toBe('13000');
  });

  it('replaces only the changed wallet presentation', () => {
    const wallets = Object.freeze(
      Array.from({ length: 13 }, (_, index) => ({
        id: `wallet-${index + 1}`,
        name: `Wallet ${index + 1}`,
      })) as unknown as readonly WalletPresentation[],
    );
    const updated = {
      ...wallets[0],
      name: 'Updated wallet',
    } as WalletPresentation;
    const update: WalletPresentationUpdate = {
      scope: 'wallet',
      walletId: 'wallet-1',
      wallets: Object.freeze([updated]),
      financialChanged: true,
    };

    const next = mergeWalletPresentationUpdate(wallets, update);

    expect(next[0]).toBe(updated);
    for (let index = 1; index < wallets.length; index += 1) {
      expect(next[index]).toBe(wallets[index]);
    }
  });
});
