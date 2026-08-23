interface ElectronProcessMetric {
  readonly pid: number;
  readonly type: string;
  readonly name?: string;
  readonly cpu: Readonly<{ percentCPUUsage: number }>;
  readonly memory: Readonly<{ workingSetSize: number }>;
}

export interface ElectronSystemMetricsSample {
  readonly timestamp: string;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly uptimeMs: number;
  readonly processCount: number;
  readonly processes: readonly Readonly<{
    pid: number;
    kind: 'main' | 'renderer' | 'worker';
    name: string | null;
    cpuPercent: number;
    memoryBytes: number;
  }>[];
}

export function collectSystemMetrics(
  metrics: readonly ElectronProcessMetric[],
  uptimeMs: number,
  timestamp: string = new Date().toISOString(),
): Readonly<ElectronSystemMetricsSample> {
  const processes = metrics.map((metric) =>
    Object.freeze({
      pid: metric.pid,
      kind: processKind(metric.type),
      name: metric.name ?? null,
      cpuPercent: finiteNonNegative(metric.cpu.percentCPUUsage),
      memoryBytes: finiteNonNegative(metric.memory.workingSetSize) * 1_024,
    }),
  );

  return Object.freeze({
    timestamp,
    cpuPercent: processes.reduce((total, metric) => total + metric.cpuPercent, 0),
    memoryBytes: processes.reduce((total, metric) => total + metric.memoryBytes, 0),
    uptimeMs: finiteNonNegative(uptimeMs),
    processCount: processes.length,
    processes: Object.freeze(processes),
  });
}

function processKind(type: string): 'main' | 'renderer' | 'worker' {
  if (type === 'Browser') return 'main';
  if (type === 'Tab') return 'renderer';
  return 'worker';
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
