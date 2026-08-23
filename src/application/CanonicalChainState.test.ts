import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanonicalChainStateMonitor } from './CanonicalChainState';
import {
  minerProductionConfigurationFromEnvironment,
  resolveProductionConfiguration,
} from './productionConfiguration';

const monitors: CanonicalChainStateMonitor[] = [];

afterEach(() => {
  for (const monitor of monitors.splice(0)) {
    monitor.dispose();
  }
  vi.useRealTimers();
});

describe('CanonicalChainStateMonitor', () => {
  it('isolates the DEV canonical GraphQL request from the Bee connection pool', async () => {
    const dev = resolveProductionConfiguration(
      minerProductionConfigurationFromEnvironment({
        DEV: true,
        VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example',
        VITE_MINER_CORE_BEE_APP_ID: 'app-id',
      }, 'http://localhost:5173'),
    ).value!;
    const production = resolveProductionConfiguration(
      minerProductionConfigurationFromEnvironment({
        DEV: false,
        VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example',
        VITE_MINER_CORE_BEE_APP_ID: 'app-id',
      }),
    ).value!;
    const devFetch = vi.fn(async () => responseWithBlock('12000'));
    const productionFetch = vi.fn(async () => responseWithBlock('12000'));
    const devMonitor = new CanonicalChainStateMonitor(
      dev.canonicalEndpoint,
      devFetch as typeof fetch,
    );
    const productionMonitor = new CanonicalChainStateMonitor(
      production.canonicalEndpoint,
      productionFetch as typeof fetch,
    );
    monitors.push(devMonitor, productionMonitor);

    await devMonitor.synchronize();
    await productionMonitor.synchronize();

    expect(devFetch).toHaveBeenCalledWith(
      'http://[::1]:5173/graphql',
      expect.objectContaining({
        body: expect.stringContaining('blocks(last: 1)'),
      }),
    );
    expect(productionFetch).toHaveBeenCalledWith(
      'https://mainnet.example/graphql',
      expect.anything(),
    );
  });

  it('refreshes N+1 while six DEV Bee requests still occupy their host pool', async () => {
    const configuration = resolveProductionConfiguration(
      minerProductionConfigurationFromEnvironment({
        DEV: true,
        VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example',
        VITE_MINER_CORE_BEE_APP_ID: 'app-id',
      }, 'http://localhost:5173'),
    ).value!;
    const network = originLimitedNetwork('13040');
    const beeRequests = Array.from({ length: 6 }, () =>
      network.occupy(`${configuration.endpoints[0]}/v2/account`),
    );
    await Promise.resolve();
    expect(network.active(configuration.endpoints[0]!)).toBe(6);

    const monitor = new CanonicalChainStateMonitor(
      configuration.canonicalEndpoint,
      network.fetcher,
    );
    monitors.push(monitor);

    const snapshot = await settlesBefore(monitor.synchronize(), 100);
    expect(snapshot).toMatchObject({
      status: 'live',
      miniEpochStart: '13000',
      currentBlock: '13040',
    });
    expect(beeRequests.every((request) => request.released() === false)).toBe(true);

    for (const request of beeRequests) request.release();
    await Promise.all(beeRequests.map((request) => request.operation));
  });

  it('derives mini and main epoch windows from the canonical block source', async () => {
    let now = Date.parse('2026-08-05T12:00:00.000Z');
    const blocks = ['12000', '12500'];
    const fetcher = vi.fn(async () => responseWithBlock(blocks.shift()!));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
      () => now,
    );
    monitors.push(monitor);

    const atStart = await monitor.synchronize();

    expect(fetcher).toHaveBeenCalledWith(
      'https://node.example/graphql',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(atStart).toMatchObject({
      status: 'live',
      currentBlock: '12000',
      miniEpochStart: '12000',
      miniEpochRemainingMs: 330_000,
      miniEpoch: {
        id: '12000',
        progressPercent: 0,
        remainingBlocks: 1_000,
      },
      mainEpoch: {
        id: '0',
        startBlock: '0',
        endBlock: '262000',
        remainingBlocks: 250_000,
      },
    });

    now += 165_000;
    const midEpoch = await monitor.synchronize();

    expect(midEpoch).toMatchObject({
      currentBlock: '12500',
      miniEpochStart: '12000',
      miniEpochRemainingMs: 165_000,
      miniEpoch: {
        progressPercent: 50,
        elapsedMs: 165_000,
        remainingMs: 165_000,
        remainingBlocks: 500,
      },
      mainEpoch: {
        id: '0',
        remainingBlocks: 249_500,
      },
    });
  });

  it('publishes a new mini epoch and ignores regressing block data', async () => {
    let now = Date.parse('2026-08-05T12:00:00.000Z');
    const blocks = ['12999', '13000', '12900'];
    const fetcher = vi.fn(async () => responseWithBlock(blocks.shift()!));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example/graphql',
      fetcher as typeof fetch,
      () => now,
    );
    monitors.push(monitor);
    const listener = vi.fn();
    monitor.subscribe(listener);

    await monitor.synchronize();
    now += 330;
    await monitor.synchronize();

    expect(monitor.snapshot()).toMatchObject({
      currentBlock: '13000',
      miniEpochStart: '13000',
      miniEpoch: { progressPercent: 0, remainingBlocks: 1_000 },
    });
    const notificationsAfterTransition = listener.mock.calls.length;

    now += 330;
    await monitor.synchronize();

    expect(monitor.snapshot().currentBlock).toBe('13000');
    expect(listener).toHaveBeenCalledTimes(notificationsAfterTransition);
  });

  it('refreshes canonical state on the five second poll after a local boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-05T12:00:00.000Z');
    const blocks = ['12999', '13000'];
    const fetcher = vi.fn(async () => responseWithBlock(blocks.shift()!));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
    );
    monitors.push(monitor);

    const beforeBoundary = await monitor.synchronize();
    expect(beforeBoundary).toMatchObject({
      miniEpochStart: '12000',
      miniEpoch: { remainingBlocks: 1, remainingMs: 330 },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot()).toMatchObject({
      currentBlock: '12999',
      miniEpochStart: '13000',
      confidence: 'estimated',
    });

    await vi.advanceTimersByTimeAsync(4_000);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(monitor.snapshot()).toMatchObject({
      currentBlock: '13000',
      miniEpochStart: '13000',
      miniEpoch: {
        remainingBlocks: 1_000,
      },
    });
    expect(monitor.snapshot().miniEpoch.progressPercent).toBeGreaterThanOrEqual(0);
    expect(monitor.snapshot().miniEpoch.progressPercent).toBeLessThan(2);
    expect(monitor.snapshot().miniEpoch.remainingMs).toBeGreaterThan(329_000);
    expect(monitor.snapshot().miniEpoch.remainingMs).toBeLessThanOrEqual(330_000);
  });

  it('advances the mini and main epoch clocks locally at the shared boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-05T12:00:00.000Z');
    const fetcher = vi.fn(async () => responseWithBlock('261999'));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
    );
    monitors.push(monitor);

    await monitor.synchronize();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot()).toMatchObject({
      miniEpochStart: '262000',
      confidence: 'estimated',
      miniEpoch: { id: '262000' },
      mainEpoch: { id: '262000' },
    });
  });

  it('leaves a full five second idle window after a slow canonical refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-05T12:00:00.000Z');
    let finishFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      finishFirst = resolve;
    });
    let requestCount = 0;
    const fetcher = vi.fn(async (): Promise<Response> => {
      requestCount += 1;
      return requestCount === 1
        ? firstResponse
        : responseWithBlock('13001');
    });
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
    );
    monitors.push(monitor);

    const first = monitor.synchronize();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(fetcher).toHaveBeenCalledTimes(1);

    finishFirst(responseWithBlock('13000'));
    await first;
    await vi.advanceTimersByTimeAsync(0);

    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);

    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('accepts the next boundary immediately but confirms a skipped epoch twice', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-05T12:00:00.000Z');
    const blocks = ['12999', '15000', '15000'];
    const fetcher = vi.fn(async () => responseWithBlock(blocks.shift()!));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
    );
    monitors.push(monitor);

    const beforeBoundary = await monitor.synchronize();
    const expectedEndAt = beforeBoundary.miniEpoch.expectedEndAt;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot()).toMatchObject({
      currentBlock: '12999',
      miniEpochStart: '13000',
      code: 'canonical-chain-state-estimated',
      confidence: 'estimated',
      miniEpoch: {
        id: '13000',
        startBlock: '13000',
        endBlock: '14000',
      },
    });
    expect(monitor.snapshot().miniEpoch.progressPercent).toBeGreaterThan(0);
    expect(monitor.snapshot().miniEpoch.progressPercent).toBeLessThan(1);

    await monitor.synchronize();

    expect(monitor.snapshot()).toMatchObject({
      currentBlock: '15000',
      miniEpochStart: '13000',
    });

    await monitor.synchronize();

    expect(monitor.snapshot()).toMatchObject({
      currentBlock: '15000',
      miniEpochStart: '15000',
      code: 'canonical-chain-state-live',
      confidence: 'canonical',
    });
    expect(new Date(expectedEndAt!).getTime()).toBeLessThan(
      new Date(monitor.snapshot().miniEpoch.expectedEndAt!).getTime(),
    );
  });

  it('keeps the shared 330 second clock running when canonical refreshes fail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-05T12:00:00.000Z');
    let firstRequest = true;
    const fetcher = vi.fn(async () => {
      if (firstRequest) {
        firstRequest = false;
        return responseWithBlock('12950');
      }
      return responseWithGraphqlError(
        'pool timed out while waiting for an open connection',
      );
    });
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
    );
    monitors.push(monitor);

    await monitor.synchronize();
    await vi.advanceTimersByTimeAsync(17_000);

    expect(monitor.snapshot()).toMatchObject({
      currentBlock: '12950',
      miniEpochStart: '13000',
      code: 'canonical-chain-state-estimated',
      confidence: 'estimated',
      lastFailureCode: 'CANONICAL_GRAPHQL_POOL_TIMEOUT',
      miniEpoch: {
        id: '13000',
        progressPercent: expect.any(Number),
        remainingMs: 329_500,
      },
    });
    expect(monitor.snapshot().miniEpoch.progressPercent).toBeGreaterThan(0);
    expect(monitor.snapshot().miniEpoch.progressPercent).toBeLessThan(1);
  });

  it('continues across more than one offline mini epoch without a chain response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-05T12:00:00.000Z');
    let firstRequest = true;
    const fetcher = vi.fn(async () => {
      if (firstRequest) {
        firstRequest = false;
        return responseWithBlock('12000');
      }
      throw new TypeError('network unavailable');
    });
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
    );
    monitors.push(monitor);

    await monitor.synchronize();
    await vi.advanceTimersByTimeAsync(665_000);

    expect(monitor.snapshot()).toMatchObject({
      currentBlock: '12000',
      miniEpochStart: '14000',
      code: 'canonical-chain-state-estimated',
      confidence: 'estimated',
      lastFailureCode: 'CANONICAL_TRANSPORT_ERROR',
      miniEpoch: {
        id: '14000',
        elapsedMs: 5_000,
        remainingMs: 325_000,
      },
    });
  });

  it('exposes a safe GraphQL pool timeout code without a raw response', async () => {
    const fetcher = vi.fn(async () => responseWithGraphqlError(
      'pool timed out while waiting for an open connection',
    ));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
    );
    monitors.push(monitor);

    const snapshot = await monitor.synchronize();

    expect(snapshot).toMatchObject({
      status: 'synchronizing',
      code: 'canonical-chain-state-unavailable',
      confidence: 'none',
      lastFailureCode: 'CANONICAL_GRAPHQL_POOL_TIMEOUT',
    });
  });

  it('moves the visible epoch percentage smoothly between canonical block reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-05T12:00:00.000Z');
    const fetcher = vi.fn(async () => responseWithBlock('12500'));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
    );
    monitors.push(monitor);

    const initial = await monitor.synchronize();
    expect(initial.miniEpoch.progressPercent).toBe(50);
    const authoritativeUpdatedAt = initial.updatedAt;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().miniEpoch.progressPercent).toBeGreaterThan(50);
    expect(monitor.snapshot().miniEpoch.progressPercent).toBeLessThan(51);
    expect(monitor.snapshot().miniEpoch.remainingBlocks).toBe(500);
    expect(monitor.snapshot().updatedAt).toBe(authoritativeUpdatedAt);
  });

  it('keeps the 330-second mini-epoch duration across irregular observations', async () => {
    let now = Date.parse('2026-08-05T12:00:00.000Z');
    const blocks = ['12000', '13000', '14000'];
    const fetcher = vi.fn(async () => responseWithBlock(blocks.shift()!));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
      () => now,
    );
    monitors.push(monitor);

    await monitor.synchronize();
    now += 415_000;
    await monitor.synchronize();
    expect(monitor.snapshot().averageBlockTimeMs).toBe(330);

    now += 273_000;
    await monitor.synchronize();

    expect(monitor.snapshot()).toMatchObject({
      miniEpochStart: '14000',
      miniEpochRemainingMs: 330_000,
      averageBlockTimeMs: 330,
    });
  });

  it('reanchors the local clock when a newer canonical block is behind it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-05T12:00:00.000Z');
    const blocks = ['12500', '12500', '12501'];
    const fetcher = vi.fn(async () => responseWithBlock(blocks.shift()!));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
    );
    monitors.push(monitor);

    await monitor.synchronize();
    await vi.advanceTimersByTimeAsync(9_000);

    expect(monitor.snapshot().miniEpoch.progressPercent).toBeGreaterThan(52);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(monitor.snapshot().miniEpoch).toMatchObject({
      progressPercent: 50.1,
      remainingBlocks: 499,
    });
    expect(monitor.snapshot().miniEpoch.remainingMs).toBeGreaterThan(164_000);
  });

  it('uses the block generation time instead of adding HTTP latency', async () => {
    const generatedAt = Date.parse('2026-08-05T12:00:00.000Z');
    const observedAt = generatedAt + 5_000;
    const fetcher = vi.fn(async () => responseWithBlock(
      '12500',
      String(generatedAt / 1_000),
    ));
    const monitor = new CanonicalChainStateMonitor(
      'https://node.example',
      fetcher as typeof fetch,
      () => observedAt,
    );
    monitors.push(monitor);

    const snapshot = await monitor.synchronize();

    expect(snapshot.miniEpoch).toMatchObject({
      progressPercent: 50,
      remainingBlocks: 500,
      remainingMs: 160_000,
      expectedEndAt: '2026-08-05T12:02:45.000Z',
    });
  });
});

function responseWithBlock(block: string, genUtime = '0'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        blockchain: {
          blocks: {
            edges: [{ node: { seq_no: block, gen_utime: genUtime } }],
          },
        },
      },
    }),
  } as Response;
}

function responseWithGraphqlError(message: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ errors: [{ message }] }),
  } as Response;
}

function originLimitedNetwork(block: string, limit = 6) {
  const activeByOrigin = new Map<string, number>();
  const pendingByOrigin = new Map<string, Array<() => void>>();

  const schedule = <T>(url: string, operation: () => Promise<T>): Promise<T> => {
    const origin = new URL(url).origin;

    return new Promise<T>((resolve, reject) => {
      const start = () => {
        activeByOrigin.set(origin, (activeByOrigin.get(origin) ?? 0) + 1);
        void operation().then(resolve, reject).finally(() => {
          activeByOrigin.set(origin, (activeByOrigin.get(origin) ?? 1) - 1);
          pendingByOrigin.get(origin)?.shift()?.();
        });
      };

      if ((activeByOrigin.get(origin) ?? 0) < limit) {
        start();
      } else {
        const pending = pendingByOrigin.get(origin) ?? [];
        pending.push(start);
        pendingByOrigin.set(origin, pending);
      }
    });
  };

  return {
    active: (url: string) => activeByOrigin.get(new URL(url).origin) ?? 0,
    fetcher: ((input: URL | RequestInfo) =>
      schedule(String(input), async () => responseWithBlock(block))) as typeof fetch,
    occupy: (url: string) => {
      let releaseGate: (() => void) | null = null;
      let wasReleased = false;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const operation = schedule(url, async () => {
        await gate;
        return new Response(null, { status: 204 });
      });

      return {
        operation,
        released: () => wasReleased,
        release: () => {
          wasReleased = true;
          releaseGate?.();
        },
      };
    },
  };
}

async function settlesBefore<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Canonical request waited behind Bee connections.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
