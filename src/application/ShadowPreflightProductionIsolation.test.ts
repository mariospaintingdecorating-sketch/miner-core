import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('production mining-engine isolation', () => {
  it('composes only WalletMiningWorker and the official Bee 4 native adapter', () => {
    const source = compositionSource();

    expect(source).toContain('new WalletMiningRuntimeFactory');
    expect(source).toContain('new BeeMiningNativeAdapter');
    expect(source).toContain('new MiningRuntimeRouter');
    expect(source).toContain('automaticContinuationEnabled: true');
    expect(source).toContain('new SpacedRewardDispatchLimiter');
  });

  it('contains no legacy engine allocation or selection gate', () => {
    const source = compositionSource();

    for (const forbidden of [
      'new MinerEngine',
      'new SessionManager',
      'new TapScheduler',
      'new SettlementManager',
      'new RecoveryManager',
      'new WalletRuntimeDirectory',
      'new BeeMinerSessionAdapter',
      'developmentNewWorkerSelectionPolicy',
      'ENABLE_NEW_WORKER_LIVE_ACTIVATION',
      'legacyDirectory',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('does not retain removed legacy implementation files', () => {
    const manifest = import.meta.glob([
      '../core/*.ts',
      './WalletRuntime.ts',
      './BeeRuntimeOperations.ts',
      '../services/bee/BeeMinerSessionAdapter.ts',
    ]);

    expect(Object.keys(manifest)).toEqual([]);
  });
});

function compositionSource(): string {
  return readFileSync(
    new URL('./createMinerApplication.ts', import.meta.url),
    'utf8',
  );
}
