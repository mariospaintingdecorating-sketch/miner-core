export type SystemProcessKind = 'main' | 'renderer' | 'worker';

export interface SystemProcessMetric {
  readonly pid: number;
  readonly kind: SystemProcessKind;
  readonly name: string | null;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
}

export interface SystemMetricsSample {
  readonly timestamp: string;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly uptimeMs: number;
  readonly processCount: number;
  readonly processes: readonly Readonly<SystemProcessMetric>[];
}

export interface SystemMetricsSnapshot {
  readonly status: 'available' | 'unavailable';
  readonly reason: string | null;
  readonly current: Readonly<SystemMetricsSample> | null;
  readonly history: Readonly<{
    oneHour: readonly Readonly<SystemMetricsSample>[];
    sixHours: readonly Readonly<SystemMetricsSample>[];
    twentyFourHours: readonly Readonly<SystemMetricsSample>[];
  }>;
}

export interface DiagnosticsExportBundle {
  readonly logs: unknown;
  readonly runtimeState: unknown;
  readonly walletSummary: unknown;
  readonly epochState: unknown;
  readonly systemMetrics: unknown;
  readonly recoveryHistory: unknown;
  readonly rewardHistory: unknown;
  readonly balanceSnapshots: unknown;
  readonly sessionResults: unknown;
}

export interface DiagnosticsExportResult {
  readonly status: 'saved' | 'cancelled' | 'unavailable' | 'failed';
  readonly fileName: string | null;
  readonly message: string | null;
}

export interface SystemObservabilityBridge {
  systemMetrics(): Promise<unknown>;
  exportDiagnostics(bundle: DiagnosticsExportBundle): Promise<unknown>;
}

export type SystemMetricsListener = (
  snapshot: Readonly<SystemMetricsSnapshot>,
) => void;

export interface SystemObservabilitySource {
  snapshot(): Readonly<SystemMetricsSnapshot>;
  subscribe(listener: SystemMetricsListener): () => void;
  exportDiagnostics(
    bundle: DiagnosticsExportBundle,
  ): Promise<Readonly<DiagnosticsExportResult>>;
  dispose(): void;
}

const ONE_HOUR_MS = 60 * 60 * 1_000;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
export const MAX_SYSTEM_METRICS_SAMPLES = 1_500;

export class SystemObservability implements SystemObservabilitySource {
  readonly #listeners = new Set<SystemMetricsListener>();
  #samples: readonly Readonly<SystemMetricsSample>[] = Object.freeze([]);
  #status: SystemMetricsSnapshot['status'] = 'unavailable';
  #reason: string | null = 'electron-observability-unavailable';
  #timer: ReturnType<typeof setInterval> | null = null;
  #refresh: Promise<void> | null = null;

  constructor(
    private readonly bridge?: SystemObservabilityBridge,
    private readonly now: () => number = () => Date.now(),
    private readonly sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  ) {}

  start(): void {
    if (!this.bridge || this.#timer) {
      return;
    }

    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.sampleIntervalMs);
  }

  refresh(): Promise<void> {
    if (!this.bridge) {
      return Promise.resolve();
    }

    if (this.#refresh) {
      return this.#refresh;
    }

    const operation = this.#readMetrics();
    this.#refresh = operation;
    void operation.finally(() => {
      if (this.#refresh === operation) {
        this.#refresh = null;
      }
    });
    return operation;
  }

  snapshot(): Readonly<SystemMetricsSnapshot> {
    const now = this.now();
    return Object.freeze({
      status: this.#status,
      reason: this.#reason,
      current: this.#samples.at(-1) ?? null,
      history: Object.freeze({
        oneHour: this.#historySince(now - ONE_HOUR_MS),
        sixHours: this.#historySince(now - SIX_HOURS_MS),
        twentyFourHours: this.#historySince(now - TWENTY_FOUR_HOURS_MS),
      }),
    });
  }

  subscribe(listener: SystemMetricsListener): () => void {
    this.#listeners.add(listener);
    this.#deliver(listener);

    return () => this.#listeners.delete(listener);
  }

  async exportDiagnostics(
    bundle: DiagnosticsExportBundle,
  ): Promise<Readonly<DiagnosticsExportResult>> {
    if (!this.bridge) {
      return Object.freeze({
        status: 'unavailable',
        fileName: null,
        message: 'Diagnostics export is available in the Electron application.',
      });
    }

    try {
      return parseExportResult(await this.bridge.exportDiagnostics(bundle));
    } catch {
      return Object.freeze({
        status: 'failed',
        fileName: null,
        message: 'Diagnostics export failed.',
      });
    }
  }

  dispose(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#listeners.clear();
  }

  async #readMetrics(): Promise<void> {
    try {
      const sample = parseSystemMetricsSample(await this.bridge!.systemMetrics());

      if (!sample) {
        this.#status = 'unavailable';
        this.#reason = 'electron-metrics-invalid';
      } else {
        const cutoff = this.now() - TWENTY_FOUR_HOURS_MS;
        this.#samples = Object.freeze(
          [...this.#samples, sample].filter(
            (entry) => Date.parse(entry.timestamp) >= cutoff,
          ).slice(-MAX_SYSTEM_METRICS_SAMPLES),
        );
        this.#status = 'available';
        this.#reason = null;
      }
    } catch {
      this.#status = 'unavailable';
      this.#reason = 'electron-metrics-read-failed';
    }

    for (const listener of [...this.#listeners]) {
      this.#deliver(listener);
    }
  }

  #historySince(timestamp: number): readonly Readonly<SystemMetricsSample>[] {
    return Object.freeze(
      this.#samples.filter((sample) => Date.parse(sample.timestamp) >= timestamp),
    );
  }

  #deliver(listener: SystemMetricsListener): void {
    try {
      listener(this.snapshot());
    } catch {
      // Observability consumers cannot control system sampling.
    }
  }
}

export function parseSystemMetricsSample(
  value: unknown,
): Readonly<SystemMetricsSample> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const sample = value as Record<string, unknown>;
  if (
    typeof sample.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(sample.timestamp)) ||
    !isNonNegativeNumber(sample.cpuPercent) ||
    !isNonNegativeNumber(sample.memoryBytes) ||
    !isNonNegativeNumber(sample.uptimeMs) ||
    !Number.isInteger(sample.processCount) ||
    (sample.processCount as number) < 0 ||
    !Array.isArray(sample.processes)
  ) {
    return null;
  }

  const processes = sample.processes
    .map(parseProcessMetric)
    .filter((entry): entry is Readonly<SystemProcessMetric> => entry !== null);

  if (processes.length !== sample.processes.length) {
    return null;
  }

  return Object.freeze({
    timestamp: sample.timestamp,
    cpuPercent: sample.cpuPercent,
    memoryBytes: sample.memoryBytes,
    uptimeMs: sample.uptimeMs,
    processCount: sample.processCount as number,
    processes: Object.freeze(processes),
  });
}

function parseProcessMetric(value: unknown): Readonly<SystemProcessMetric> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const processMetric = value as Record<string, unknown>;
  if (
    !Number.isInteger(processMetric.pid) ||
    (processMetric.pid as number) < 0 ||
    (processMetric.kind !== 'main' &&
      processMetric.kind !== 'renderer' &&
      processMetric.kind !== 'worker') ||
    !(processMetric.name === null || typeof processMetric.name === 'string') ||
    !isNonNegativeNumber(processMetric.cpuPercent) ||
    !isNonNegativeNumber(processMetric.memoryBytes)
  ) {
    return null;
  }

  return Object.freeze({
    pid: processMetric.pid as number,
    kind: processMetric.kind,
    name: processMetric.name,
    cpuPercent: processMetric.cpuPercent,
    memoryBytes: processMetric.memoryBytes,
  });
}

function parseExportResult(value: unknown): Readonly<DiagnosticsExportResult> {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Invalid diagnostics export result.');
  }
  const result = value as Record<string, unknown>;
  if (
    result.status !== 'saved' &&
    result.status !== 'cancelled' &&
    result.status !== 'unavailable' &&
    result.status !== 'failed'
  ) {
    throw new TypeError('Invalid diagnostics export status.');
  }
  if (
    !(result.fileName === null || typeof result.fileName === 'string') ||
    !(result.message === null || typeof result.message === 'string')
  ) {
    throw new TypeError('Invalid diagnostics export response.');
  }
  return Object.freeze({
    status: result.status,
    fileName: result.fileName,
    message: result.message,
  });
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
