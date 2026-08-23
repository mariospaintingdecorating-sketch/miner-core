import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SYSTEM_METRICS_SAMPLES,
  SystemObservability,
} from './SystemObservability';

function sample(timestamp = '2026-08-06T10:00:00.000Z') {
  return {
    timestamp,
    cpuPercent: 12.5,
    memoryBytes: 256 * 1_024 * 1_024,
    uptimeMs: 90_000,
    processCount: 2,
    processes: [
      {
        pid: 100,
        kind: 'main',
        name: null,
        cpuPercent: 5,
        memoryBytes: 128 * 1_024 * 1_024,
      },
      {
        pid: 101,
        kind: 'renderer',
        name: null,
        cpuPercent: 7.5,
        memoryBytes: 128 * 1_024 * 1_024,
      },
    ],
  };
}

describe('SystemObservability', () => {
  it('reports real bridge CPU and RAM data with bounded history windows', async () => {
    let now = Date.parse('2026-08-06T10:00:00.000Z');
    const systemMetrics = vi.fn(async () => sample(new Date(now).toISOString()));
    const observability = new SystemObservability(
      { systemMetrics, exportDiagnostics: vi.fn() },
      () => now,
    );

    await observability.refresh();
    now += 2 * 60 * 60 * 1_000;
    await observability.refresh();

    const snapshot = observability.snapshot();
    expect(snapshot.status).toBe('available');
    expect(snapshot.current).toMatchObject({
      cpuPercent: 12.5,
      memoryBytes: 256 * 1_024 * 1_024,
      processCount: 2,
    });
    expect(snapshot.history.oneHour).toHaveLength(1);
    expect(snapshot.history.sixHours).toHaveLength(2);
    expect(snapshot.history.twentyFourHours).toHaveLength(2);
  });

  it('reports metrics as explicitly unavailable when no Electron source exists', () => {
    const observability = new SystemObservability();

    expect(observability.snapshot()).toMatchObject({
      status: 'unavailable',
      reason: 'electron-observability-unavailable',
      current: null,
    });
  });

  it('uses the Electron export boundary without exposing an arbitrary path API', async () => {
    const exportDiagnostics = vi.fn(async () => ({
      status: 'saved',
      fileName: 'core-miner-diagnostics-2026-08-06.zip',
      message: null,
    }));
    const observability = new SystemObservability({
      systemMetrics: vi.fn(),
      exportDiagnostics,
    });
    const bundle = {
      logs: [],
      runtimeState: {},
      walletSummary: [],
      epochState: {},
      systemMetrics: {},
      recoveryHistory: [],
      rewardHistory: [],
      balanceSnapshots: [],
      sessionResults: [],
    };

    await expect(observability.exportDiagnostics(bundle)).resolves.toMatchObject({
      status: 'saved',
      fileName: 'core-miner-diagnostics-2026-08-06.zip',
    });
    expect(exportDiagnostics).toHaveBeenCalledWith(bundle);
  });

  it('caps hot metric samples even when sampling more frequently than production', async () => {
    let now = Date.parse('2026-08-06T10:00:00.000Z');
    const observability = new SystemObservability(
      {
        systemMetrics: vi.fn(async () => sample(new Date(now).toISOString())),
        exportDiagnostics: vi.fn(),
      },
      () => now,
    );

    for (let index = 0; index < MAX_SYSTEM_METRICS_SAMPLES + 5; index += 1) {
      await observability.refresh();
      now += 1_000;
    }

    expect(observability.snapshot().history.twentyFourHours).toHaveLength(
      MAX_SYSTEM_METRICS_SAMPLES,
    );
  });
});
