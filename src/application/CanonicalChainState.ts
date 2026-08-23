import type {
  MiningEpochListener,
  MiningEpochSourceContract,
} from '../shared/miningRuntime';

const BLOCK_TIME_MS = 330;
const MINI_EPOCH_BLOCKS = 1_000n;
const MAIN_EPOCH_BLOCKS = 262_000n;
const NETWORK_POLL_INTERVAL_MS = 5_000;
const CLOCK_TICK_INTERVAL_MS = 1_000;
const NETWORK_REQUEST_TIMEOUT_MS = 8_000;
const MAX_RECENT_BLOCK_AGE_MS = 120_000;
const SKIPPED_EPOCH_CANDIDATE_CONFIRMATIONS = 2;
const FORWARD_CANDIDATE_MAX_AGE_MS = 60_000;

interface CanonicalBlockObservation {
  readonly block: bigint;
  readonly generatedAtMs: number | null;
}

interface ForwardMiniEpochCandidate {
  readonly start: bigint;
  readonly observations: number;
  readonly firstSeenAtMs: number;
}

export type CanonicalChainFailureCode =
  | 'CANONICAL_REQUEST_TIMEOUT'
  | 'CANONICAL_TRANSPORT_ERROR'
  | 'CANONICAL_HTTP_ERROR'
  | 'CANONICAL_GRAPHQL_POOL_TIMEOUT'
  | 'CANONICAL_GRAPHQL_ERROR'
  | 'CANONICAL_RESPONSE_INVALID';

export interface EpochWindowSnapshot {
  readonly id: string | null;
  readonly startBlock: string | null;
  readonly endBlock: string | null;
  readonly progressPercent: number | null;
  readonly elapsedMs: number | null;
  readonly remainingMs: number | null;
  readonly remainingBlocks: number | null;
  readonly startedAt: string | null;
  readonly expectedEndAt: string | null;
}

export interface CanonicalChainStateSnapshot {
  readonly status: 'not-configured' | 'synchronizing' | 'live';
  readonly code:
    | 'canonical-chain-state-provider-not-configured'
    | 'canonical-chain-state-synchronizing'
    | 'canonical-chain-state-live'
    | 'canonical-chain-state-estimated'
    | 'canonical-chain-state-unavailable';
  readonly confidence: 'none' | 'canonical' | 'estimated';
  readonly lastFailureCode: CanonicalChainFailureCode | null;
  readonly currentBlock: string | null;
  readonly miniEpochStart: string | null;
  readonly miniEpochRemainingMs: number | null;
  readonly miniEpoch: Readonly<EpochWindowSnapshot>;
  readonly mainEpoch: Readonly<EpochWindowSnapshot>;
  readonly averageBlockTimeMs: number | null;
  readonly updatedAt: string | null;
}

export interface CanonicalChainStateProvider
  extends MiningEpochSourceContract {
  snapshot(): Readonly<CanonicalChainStateSnapshot>;
  synchronize(): Promise<Readonly<CanonicalChainStateSnapshot>>;
  subscribe(listener: MiningEpochListener): () => void;
  dispose(): void;
}

const EMPTY_EPOCH_WINDOW: Readonly<EpochWindowSnapshot> = Object.freeze({
  id: null,
  startBlock: null,
  endBlock: null,
  progressPercent: null,
  elapsedMs: null,
  remainingMs: null,
  remainingBlocks: null,
  startedAt: null,
  expectedEndAt: null,
});

const NOT_CONFIGURED_SNAPSHOT: Readonly<CanonicalChainStateSnapshot> =
  Object.freeze({
    status: 'not-configured',
    code: 'canonical-chain-state-provider-not-configured',
    confidence: 'none',
    lastFailureCode: null,
    currentBlock: null,
    miniEpochStart: null,
    miniEpochRemainingMs: null,
    miniEpoch: EMPTY_EPOCH_WINDOW,
    mainEpoch: EMPTY_EPOCH_WINDOW,
    averageBlockTimeMs: null,
    updatedAt: null,
  });

export const CANONICAL_CHAIN_STATE_NOT_CONFIGURED: CanonicalChainStateProvider =
  Object.freeze({
    snapshot: () => NOT_CONFIGURED_SNAPSHOT,
    synchronize: async () => NOT_CONFIGURED_SNAPSHOT,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  });

export class CanonicalChainStateMonitor
  implements CanonicalChainStateProvider
{
  readonly #listeners = new Set<MiningEpochListener>();
  #snapshot: Readonly<CanonicalChainStateSnapshot> = synchronizingSnapshot();
  #synchronization: Promise<Readonly<CanonicalChainStateSnapshot>> | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #clockTimer: ReturnType<typeof setInterval> | null = null;
  #lastBlock: bigint | null = null;
  #pendingMiniEpoch: Readonly<ForwardMiniEpochCandidate> | null = null;

  constructor(
    endpoint: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.graphqlEndpoint = resolveGraphqlEndpoint(endpoint);
  }

  private readonly graphqlEndpoint: string;

  snapshot(): Readonly<CanonicalChainStateSnapshot> {
    return this.#snapshot;
  }

  synchronize(): Promise<Readonly<CanonicalChainStateSnapshot>> {
    this.#ensureMonitoring();

    if (this.#synchronization) {
      return this.#synchronization;
    }

    this.#clearPollTimer();
    const synchronization = this.#readCanonicalBlock();
    this.#synchronization = synchronization;
    void synchronization.finally(() => {
      if (this.#synchronization === synchronization) {
        this.#synchronization = null;
        this.#scheduleNextPoll();
      }
    });
    return synchronization;
  }

  subscribe(listener: MiningEpochListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#clearPollTimer();
    if (this.#clockTimer) {
      clearInterval(this.#clockTimer);
      this.#clockTimer = null;
    }
    this.#listeners.clear();
  }

  async #readCanonicalBlock(): Promise<Readonly<CanonicalChainStateSnapshot>> {
    if (this.#snapshot.status !== 'live') {
      this.#setSnapshot(synchronizingSnapshot());
    }

    try {
      const observation = await fetchLatestBlock(
        this.graphqlEndpoint,
        this.fetcher,
      );
      const timestamp = this.now();
      const block = observation.block;

      if (this.#lastBlock !== null && block < this.#lastBlock) {
        return this.#snapshot;
      }
      const candidateMiniEpoch = block - (block % MINI_EPOCH_BLOCKS);
      const currentMiniEpoch = parseEpochId(this.#snapshot.miniEpoch.id);
      if (
        this.#lastBlock !== null &&
        block === this.#lastBlock &&
        (currentMiniEpoch === null || candidateMiniEpoch <= currentMiniEpoch)
      ) {
        if (this.#snapshot.lastFailureCode !== null) {
          this.#setSnapshot(Object.freeze({
            ...this.#snapshot,
            lastFailureCode: null,
          }));
        }
        return this.#snapshot;
      }
      this.#lastBlock = block;

      if (this.#snapshot.status !== 'live' || currentMiniEpoch === null) {
        this.#pendingMiniEpoch = null;
        this.#setSnapshot(snapshotFromBlock(
          block,
          timestamp,
          recentBlockTimestamp(observation.generatedAtMs, timestamp),
        ));
        return this.#snapshot;
      }

      if (candidateMiniEpoch < currentMiniEpoch) {
        return this.#snapshot;
      }

      if (candidateMiniEpoch > currentMiniEpoch) {
        const skippedKnownBoundary =
          candidateMiniEpoch - currentMiniEpoch > MINI_EPOCH_BLOCKS;
        if (skippedKnownBoundary) {
          this.#observeForwardCandidate(candidateMiniEpoch, timestamp);
          if (
            !this.#pendingMiniEpoch ||
            this.#pendingMiniEpoch.observations <
              SKIPPED_EPOCH_CANDIDATE_CONFIRMATIONS
          ) {
            this.#setSnapshot(snapshotWithPendingMiniEpoch(
              this.#snapshot,
              block,
              timestamp,
              recentBlockTimestamp(observation.generatedAtMs, timestamp),
            ));
            return this.#snapshot;
          }
        }
        this.#pendingMiniEpoch = null;
      } else {
        this.#pendingMiniEpoch = null;
      }

      const nextSnapshot = snapshotFromBlock(
        block,
        timestamp,
        recentBlockTimestamp(observation.generatedAtMs, timestamp),
      );
      this.#setSnapshot(reconcileCanonicalProgress(
        this.#snapshot,
        nextSnapshot,
      ));
    } catch (error) {
      const lastFailureCode = canonicalChainFailureCode(error);
      if (this.#snapshot.status !== 'live') {
        this.#setSnapshot(Object.freeze({
          ...synchronizingSnapshot(),
          code: 'canonical-chain-state-unavailable',
          lastFailureCode,
        }));
      } else if (this.#snapshot.lastFailureCode !== lastFailureCode) {
        this.#setSnapshot(Object.freeze({
          ...this.#snapshot,
          lastFailureCode,
        }));
      }
    }

    return this.#snapshot;
  }

  #observeForwardCandidate(start: bigint, timestamp: number): void {
    const pending = this.#pendingMiniEpoch;
    if (
      !pending ||
      pending.start !== start ||
      timestamp - pending.firstSeenAtMs > FORWARD_CANDIDATE_MAX_AGE_MS
    ) {
      this.#pendingMiniEpoch = Object.freeze({
        start,
        observations: 1,
        firstSeenAtMs: timestamp,
      });
      return;
    }
    this.#pendingMiniEpoch = Object.freeze({
      ...pending,
      observations: pending.observations + 1,
    });
  }

  #ensureMonitoring(): void {
    if (!this.#clockTimer) {
      this.#clockTimer = setInterval(() => this.#tickClock(), CLOCK_TICK_INTERVAL_MS);
    }
  }

  #scheduleNextPoll(): void {
    this.#clearPollTimer();
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.synchronize();
    }, NETWORK_POLL_INTERVAL_MS);
  }

  #clearPollTimer(): void {
    if (!this.#pollTimer) return;
    clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }

  #tickClock(): void {
    if (this.#snapshot.status !== 'live') {
      return;
    }

    const timestamp = this.now();
    const miniEpoch = tickEpochWindow(
      this.#snapshot.miniEpoch,
      timestamp,
      MINI_EPOCH_BLOCKS,
    );
    const mainEpoch = tickEpochWindow(
      this.#snapshot.mainEpoch,
      timestamp,
      MAIN_EPOCH_BLOCKS,
    );
    this.#setSnapshot(Object.freeze({
      ...this.#snapshot,
      code: 'canonical-chain-state-estimated',
      confidence: 'estimated',
      miniEpochStart: miniEpoch.id,
      miniEpoch,
      mainEpoch,
      miniEpochRemainingMs: miniEpoch.remainingMs,
    }));
  }

  #setSnapshot(snapshot: Readonly<CanonicalChainStateSnapshot>): void {
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // Observers cannot control the canonical epoch source.
      }
    }
  }
}

function synchronizingSnapshot(): Readonly<CanonicalChainStateSnapshot> {
  return Object.freeze({
    status: 'synchronizing',
    code: 'canonical-chain-state-synchronizing',
    confidence: 'none',
    lastFailureCode: null,
    currentBlock: null,
    miniEpochStart: null,
    miniEpochRemainingMs: null,
    miniEpoch: EMPTY_EPOCH_WINDOW,
    mainEpoch: EMPTY_EPOCH_WINDOW,
    averageBlockTimeMs: null,
    updatedAt: null,
  });
}

function snapshotFromBlock(
  block: bigint,
  timestamp: number,
  blockGeneratedAtMs: number | null,
): Readonly<CanonicalChainStateSnapshot> {
  const miniStart = block - (block % MINI_EPOCH_BLOCKS);
  const mainStart = block - (block % MAIN_EPOCH_BLOCKS);
  const miniEpoch = epochWindow(
    block,
    miniStart,
    MINI_EPOCH_BLOCKS,
    timestamp,
    BLOCK_TIME_MS,
    blockGeneratedAtMs,
  );
  const mainEpoch = epochWindow(
    block,
    mainStart,
    MAIN_EPOCH_BLOCKS,
    timestamp,
    BLOCK_TIME_MS,
    blockGeneratedAtMs,
  );

  return Object.freeze({
    status: 'live',
    code: 'canonical-chain-state-live',
    confidence: 'canonical',
    lastFailureCode: null,
    currentBlock: block.toString(),
    miniEpochStart: miniStart.toString(),
    miniEpochRemainingMs: miniEpoch.remainingMs,
    miniEpoch,
    mainEpoch,
    averageBlockTimeMs: BLOCK_TIME_MS,
    updatedAt: new Date(timestamp).toISOString(),
  });
}

function snapshotWithPendingMiniEpoch(
  previous: Readonly<CanonicalChainStateSnapshot>,
  block: bigint,
  timestamp: number,
  blockGeneratedAtMs: number | null,
): Readonly<CanonicalChainStateSnapshot> {
  const observed = snapshotFromBlock(
    block,
    timestamp,
    blockGeneratedAtMs,
  );
  const miniEpoch = tickEpochWindow(
    previous.miniEpoch,
    timestamp,
    MINI_EPOCH_BLOCKS,
  );
  const mainEpoch = epochIdPrecedes(
    observed.mainEpoch.id,
    previous.mainEpoch.id,
  )
    ? previous.mainEpoch
    : observed.mainEpoch;
  return Object.freeze({
    ...observed,
    miniEpochStart: miniEpoch.id,
    miniEpochRemainingMs: miniEpoch.remainingMs,
    miniEpoch,
    mainEpoch,
  });
}

function epochWindow(
  currentBlock: bigint,
  startBlock: bigint,
  totalBlocks: bigint,
  timestamp: number,
  averageBlockTimeMs: number,
  blockGeneratedAtMs: number | null,
): Readonly<EpochWindowSnapshot> {
  const elapsedBlocks = currentBlock - startBlock;
  const remainingBlocks = elapsedBlocks >= totalBlocks
    ? 0n
    : totalBlocks - elapsedBlocks;
  const referenceTimestamp = blockGeneratedAtMs ?? timestamp;
  const blockElapsedMs = Number(elapsedBlocks) * averageBlockTimeMs;
  const blockRemainingMs = Number(remainingBlocks) * averageBlockTimeMs;
  const startedAtMs = referenceTimestamp - blockElapsedMs;
  const expectedEndAtMs = referenceTimestamp + blockRemainingMs;
  const elapsedMs = Math.max(0, timestamp - startedAtMs);
  const remainingMs = Math.max(0, expectedEndAtMs - timestamp);

  return Object.freeze({
    id: startBlock.toString(),
    startBlock: startBlock.toString(),
    endBlock: (startBlock + totalBlocks).toString(),
    progressPercent: clamp(
      (Number(elapsedBlocks) / Number(totalBlocks)) * 100,
      0,
      100,
    ),
    elapsedMs,
    remainingMs,
    remainingBlocks: Number(remainingBlocks),
    startedAt: new Date(startedAtMs).toISOString(),
    expectedEndAt: new Date(expectedEndAtMs).toISOString(),
  });
}

function tickEpochWindow(
  window: Readonly<EpochWindowSnapshot>,
  timestamp: number,
  totalBlocks: bigint,
): Readonly<EpochWindowSnapshot> {
  if (!window.startedAt || !window.expectedEndAt) {
    return window;
  }

  const startedAt = new Date(window.startedAt).getTime();
  const expectedEndAt = new Date(window.expectedEndAt).getTime();
  const durationMs = expectedEndAt - startedAt;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return window;
  }
  const elapsedSinceStartMs = timestamp - startedAt;
  const completedCycles = Math.max(
    0,
    Math.floor(elapsedSinceStartMs / durationMs),
  );

  if (completedCycles > 0 && window.startBlock !== null) {
    try {
      const nextStartBlock =
        BigInt(window.startBlock) + totalBlocks * BigInt(completedCycles);
      const nextStartedAt = startedAt + completedCycles * durationMs;
      const nextExpectedEndAt = nextStartedAt + durationMs;
      const nextElapsedMs = Math.max(0, timestamp - nextStartedAt);
      const nextRemainingMs = Math.max(0, nextExpectedEndAt - timestamp);
      const progressPercent = clamp(
        (nextElapsedMs / durationMs) * 100,
        0,
        99.9,
      );
      const remainingBlocks = Math.max(
        0,
        Math.ceil((nextRemainingMs / durationMs) * Number(totalBlocks)),
      );

      return Object.freeze({
        id: nextStartBlock.toString(),
        startBlock: nextStartBlock.toString(),
        endBlock: (nextStartBlock + totalBlocks).toString(),
        progressPercent,
        elapsedMs: nextElapsedMs,
        remainingMs: nextRemainingMs,
        remainingBlocks,
        startedAt: new Date(nextStartedAt).toISOString(),
        expectedEndAt: new Date(nextExpectedEndAt).toISOString(),
      });
    } catch {
      // A malformed canonical window cannot create an estimated epoch.
    }
  }
  const interpolatedProgress = clamp(
    (elapsedSinceStartMs / durationMs) * 100,
    0,
    99.9,
  );

  return Object.freeze({
    ...window,
    // Before the predicted boundary, keep the canonical identity and smoothly
    // interpolate only its time-based presentation.
    progressPercent: Math.max(
      window.progressPercent ?? 0,
      interpolatedProgress,
    ),
    elapsedMs: Math.max(0, elapsedSinceStartMs),
    remainingMs: Math.max(0, expectedEndAt - timestamp),
  });
}

function reconcileCanonicalProgress(
  previous: Readonly<CanonicalChainStateSnapshot>,
  next: Readonly<CanonicalChainStateSnapshot>,
): Readonly<CanonicalChainStateSnapshot> {
  if (previous.status !== 'live' || next.status !== 'live') return next;
  const miniEpochRegressed = epochIdPrecedes(
    next.miniEpoch.id,
    previous.miniEpoch.id,
  );
  const mainEpochRegressed = epochIdPrecedes(
    next.mainEpoch.id,
    previous.mainEpoch.id,
  );
  const miniEpoch = miniEpochRegressed
    ? previous.miniEpoch
    : next.miniEpoch;
  const mainEpoch = mainEpochRegressed
    ? previous.mainEpoch
    : next.mainEpoch;
  const estimated = miniEpochRegressed || mainEpochRegressed;
  if (
    !estimated &&
    miniEpoch === next.miniEpoch &&
    mainEpoch === next.mainEpoch
  ) return next;
  return Object.freeze({
    ...next,
    code: estimated
      ? 'canonical-chain-state-estimated'
      : 'canonical-chain-state-live',
    confidence: estimated ? 'estimated' : 'canonical',
    miniEpochStart: miniEpoch.id,
    miniEpochRemainingMs: miniEpoch.remainingMs,
    miniEpoch,
    mainEpoch,
  });
}

function epochIdPrecedes(candidate: string | null, current: string | null): boolean {
  if (candidate === null || current === null) return false;
  try {
    return BigInt(candidate) < BigInt(current);
  } catch {
    return false;
  }
}

async function fetchLatestBlock(
  endpoint: string,
  fetcher: typeof fetch,
): Promise<Readonly<CanonicalBlockObservation>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query:
          'query MinerCoreLatestBlock { blockchain { blocks(last: 1) { edges { node { seq_no gen_utime } } } } }',
      }),
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new CanonicalChainReadError('CANONICAL_HTTP_ERROR');
    }

    const payload = await response.json() as {
      errors?: Array<{ message?: unknown }>;
      data?: {
        blockchain?: {
          blocks?: {
            edges?: Array<{
              node?: { seq_no?: unknown; gen_utime?: unknown };
            }>;
          };
        };
      };
    };
    let latest: bigint | null = null;
    let latestGeneratedAtMs: number | null = null;

    for (const edge of payload.data?.blockchain?.blocks?.edges ?? []) {
      const block = parsePositiveBlock(edge.node?.seq_no);
      if (block !== null && (latest === null || block >= latest)) {
        const generatedAtMs = parseBlockTimestamp(edge.node?.gen_utime);
        if (
          latest === null ||
          block > latest ||
          (block === latest && generatedAtMs !== null)
        ) {
          latestGeneratedAtMs = generatedAtMs;
        }
        latest = block;
      }
    }

    if (latest === null) {
      const graphqlMessages = (payload.errors ?? [])
        .map((error) => error.message)
        .filter((message): message is string => typeof message === 'string');
      if (
        graphqlMessages.some((message) =>
          message.toLowerCase().includes(
            'pool timed out while waiting for an open connection',
          ))
      ) {
        throw new CanonicalChainReadError(
          'CANONICAL_GRAPHQL_POOL_TIMEOUT',
        );
      }
      if (graphqlMessages.length > 0) {
        throw new CanonicalChainReadError('CANONICAL_GRAPHQL_ERROR');
      }
      throw new CanonicalChainReadError('CANONICAL_RESPONSE_INVALID');
    }

    return Object.freeze({
      block: latest,
      generatedAtMs: latestGeneratedAtMs,
    });
  } finally {
    clearTimeout(timeout);
  }
}

class CanonicalChainReadError extends Error {
  constructor(readonly code: CanonicalChainFailureCode) {
    super(code);
    this.name = 'CanonicalChainReadError';
  }
}

function canonicalChainFailureCode(error: unknown): CanonicalChainFailureCode {
  if (error instanceof CanonicalChainReadError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') {
    return 'CANONICAL_REQUEST_TIMEOUT';
  }
  if (error instanceof SyntaxError) return 'CANONICAL_RESPONSE_INVALID';
  return 'CANONICAL_TRANSPORT_ERROR';
}

function resolveGraphqlEndpoint(endpoint: string): string {
  const value = endpoint.trim().replace(/\/+$/, '');
  return value.endsWith('/graphql') ? value : `${value}/graphql`;
}

function parsePositiveBlock(value: unknown): bigint | null {
  try {
    const block = BigInt(String(value));
    return block > 0n ? block : null;
  } catch {
    return null;
  }
}

function parseEpochId(value: string | null): bigint | null {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseBlockTimestamp(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  const milliseconds = parsed < 100_000_000_000
    ? parsed * 1_000
    : parsed;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function recentBlockTimestamp(
  generatedAtMs: number | null,
  observedAtMs: number,
): number | null {
  if (
    generatedAtMs === null ||
    generatedAtMs > observedAtMs + CLOCK_TICK_INTERVAL_MS ||
    observedAtMs - generatedAtMs > MAX_RECENT_BLOCK_AGE_MS
  ) {
    return null;
  }
  return generatedAtMs;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
