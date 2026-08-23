import { describe, expect, it } from 'vitest';
import { collectSystemMetrics } from './systemMetrics.js';

describe('Electron system metrics', () => {
  it('aggregates actual Electron process CPU, RAM, uptime, and process types', () => {
    const sample = collectSystemMetrics(
      [
        {
          pid: 10,
          type: 'Browser',
          cpu: { percentCPUUsage: 3.5 },
          memory: { workingSetSize: 100 },
        },
        {
          pid: 11,
          type: 'Tab',
          cpu: { percentCPUUsage: 6.5 },
          memory: { workingSetSize: 200 },
        },
        {
          pid: 12,
          type: 'Utility',
          name: 'Network Service',
          cpu: { percentCPUUsage: 1 },
          memory: { workingSetSize: 50 },
        },
      ],
      12_000,
      '2026-08-06T10:00:00.000Z',
    );

    expect(sample).toMatchObject({
      timestamp: '2026-08-06T10:00:00.000Z',
      cpuPercent: 11,
      memoryBytes: 350 * 1_024,
      uptimeMs: 12_000,
      processCount: 3,
    });
    expect(sample.processes.map((processMetric) => processMetric.kind)).toEqual([
      'main',
      'renderer',
      'worker',
    ]);
  });
});
