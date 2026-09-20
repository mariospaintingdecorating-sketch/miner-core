import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import packageJson from '../../package.json';

describe('production composition', () => {
  it('pins the native protocol boundary to Bee SDK 5.1.1', () => {
    expect(packageJson.dependencies['@teamgosh/bee-sdk']).toBe('5.1.1');
  });

  it('routes every start source into the same wallet-local router', () => {
    const service = source('./MinerApplicationService.ts');
    expect(service).toContain('this.#runtimeRouter.start({ walletId, source })');
    expect(service).toContain('Promise.allSettled(operations)');
    expect(service).toContain('index * START_ALL_STAGGER_MS');
    expect(service).not.toContain('#startLegacyRuntime');
    expect(service).not.toContain('startClaimedLegacyRuntime');
    expect(service).not.toContain('legacyRuntime(');
  });

  it('makes the router structurally new-engine-only', () => {
    const router = source('./MiningRuntimeRouter.ts');
    expect(router).toContain("export type MiningEngineKind = 'NEW_WALLET_WORKER'");
    expect(router).toContain("export type MiningRuntimeOwnership = 'NONE' | 'NEW'");
    expect(router).not.toContain('CURRENT_ENGINE');
    expect(router).not.toContain("'LEGACY'");
    expect(router).not.toContain('one-shot');
    expect(router).not.toContain('firstLive');
  });

  it('uses worker-owned epoch continuation and fleet-wide reward spacing', () => {
    const composition = source('./createMinerApplication.ts');
    const worker = source('../mining/WalletMiningWorker.ts');
    expect(composition).toContain('automaticContinuationEnabled: true');
    expect(composition).toContain('application.activeMiningWalletCount()');
    expect(composition).not.toContain(
      'startDispatchSpacingMs(walletRegistry.wallets().length)',
    );
    expect(composition).toContain('new SpacedRewardDispatchLimiter()');
    expect(composition).toContain('new AdaptiveQueuePressureController(');
    expect(composition).toContain(
      'queuePressureController.startSpacingMs(activeMiningFleetSize())',
    );
    expect(composition).toContain('queuePressureController,');
    expect(worker).toContain("this.#state === 'WAITING_EPOCH' || this.#state === 'BACKOFF'");
  });
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
