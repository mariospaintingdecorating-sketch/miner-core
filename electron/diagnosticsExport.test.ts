import { describe, expect, it } from 'vitest';
import {
  createDiagnosticsArchive,
  diagnosticsArchiveFileName,
  sanitizeDiagnosticsBundle,
} from './diagnosticsExport.js';

describe('diagnostics export', () => {
  it('redacts secret-bearing fields and text before writing the archive', () => {
    const sanitized = sanitizeDiagnosticsBundle({
      logs: [{ message: 'privateKey=do-not-export', credential: 'hidden' }],
      runtimeState: { token: 'hidden-token', status: 'idle' },
      walletSummary: [{ walletId: 'wallet-a', connectionReference: 'secure-ref' }],
      epochState: { miniEpoch: '12000' },
      systemMetrics: { memoryBytes: 123 },
      recoveryHistory: [],
      rewardHistory: [],
      balanceSnapshots: [],
      sessionResults: [],
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('do-not-export');
    expect(serialized).not.toContain('hidden-token');
    expect(serialized).not.toContain('secure-ref');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('wallet-a');
  });

  it('creates a ZIP containing the stable diagnostics and runtime history files', () => {
    const archive = createDiagnosticsArchive({
      logs: [],
      runtimeState: {},
      walletSummary: [],
      epochState: {},
      systemMetrics: {},
      recoveryHistory: [],
      rewardHistory: [],
      balanceSnapshots: [],
      sessionResults: [],
    });
    const archiveText = archive.toString('utf8');

    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archiveText).toContain('logs.json');
    expect(archiveText).toContain('runtime-state.json');
    expect(archiveText).toContain('wallet-summary.json');
    expect(archiveText).toContain('epoch-state.json');
    expect(archiveText).toContain('system-metrics.json');
    expect(archiveText).toContain('recovery-history.json');
    expect(archiveText).toContain('reward-history.json');
    expect(archiveText).toContain('balance-snapshots.json');
    expect(archiveText).toContain('session-results.json');
    expect(diagnosticsArchiveFileName(new Date('2026-08-06T10:00:00.000Z')))
      .toBe('core-miner-diagnostics-2026-08-06.zip');
  });
});
