import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createMinerViteConfig,
  MINER_CORE_DEV_GRAPHQL_PROXY_PATH,
  MINER_CORE_DEV_V2_PROXY_PATH,
} from '../../vite.config';

describe('development Mainnet proxy', () => {
  it('proxies the root GraphQL path unchanged without WebSocket proxying', () => {
    const config = createMinerViteConfig({
      VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example',
    });
    const proxy = config.server?.proxy?.[MINER_CORE_DEV_GRAPHQL_PROXY_PATH];

    expect(config.server?.host).toBe('::1');
    expect(config.server?.port).toBe(5173);
    expect(config.server?.strictPort).toBe(true);
    expect(proxy).not.toBeTypeOf('string');
    if (!proxy || typeof proxy === 'string') throw new Error('Proxy unavailable.');
    expect(proxy.target).toBe('https://mainnet.example');
    expect(proxy.changeOrigin).toBe(true);
    expect(proxy.ws).not.toBe(true);
    expect(proxy.rewrite?.('/graphql')).toBe('/graphql');
  });

  it('proxies the observed Bee /v2 API family to the same Mainnet without rewriting its path', () => {
    const config = createMinerViteConfig({
      VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example',
    });
    const graphqlProxy = config.server?.proxy?.[MINER_CORE_DEV_GRAPHQL_PROXY_PATH];
    const v2Proxy = config.server?.proxy?.[MINER_CORE_DEV_V2_PROXY_PATH];

    expect(v2Proxy).not.toBeTypeOf('string');
    if (
      !graphqlProxy || typeof graphqlProxy === 'string' ||
      !v2Proxy || typeof v2Proxy === 'string'
    ) {
      throw new Error('Mainnet proxy unavailable.');
    }
    expect(v2Proxy.target).toBe(graphqlProxy.target);
    expect(v2Proxy.target).toBe('https://mainnet.example');
    expect(v2Proxy.changeOrigin).toBe(true);
    expect(v2Proxy.ws).not.toBe(true);
    expect(v2Proxy.rewrite?.('/v2/account')).toBe('/v2/account');
    expect(v2Proxy.bypass).toBeUndefined();
  });

  it('removes browser-only origin headers at the server-side proxy boundary', () => {
    const config = createMinerViteConfig({
      VITE_ACKI_ENDPOINT: 'https://legacy-mainnet.example',
    });
    const proxy = config.server?.proxy?.[MINER_CORE_DEV_GRAPHQL_PROXY_PATH];
    if (!proxy || typeof proxy === 'string') throw new Error('Proxy unavailable.');
    const listeners = new Map<string, (...args: unknown[]) => void>();
    proxy.configure?.({
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
    } as never, {} as never);
    const removeHeader = vi.fn();
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/graphql',
    });

    listeners.get('proxyReq')?.({ removeHeader }, request);

    expect(removeHeader).toHaveBeenNthCalledWith(1, 'origin');
    expect(removeHeader).toHaveBeenNthCalledWith(2, 'referer');
  });

  it('records one safe response summary for /v2/messages without query, body, or headers', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T22:00:00.000Z'));
    const diagnosticSink = vi.fn();
    const config = createMinerViteConfig(
      { VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example' },
      diagnosticSink,
    );
    const proxy = config.server?.proxy?.[MINER_CORE_DEV_V2_PROXY_PATH];
    if (!proxy || typeof proxy === 'string') throw new Error('Proxy unavailable.');
    const listeners = new Map<string, (...args: any[]) => void>();
    proxy.configure?.({
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      }),
    } as never, {} as never);
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v2/messages?private=query-value',
      body: 'request-body-must-not-be-recorded',
      headers: { authorization: 'secret-auth', cookie: 'secret-cookie' },
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 202,
      complete: true,
      headers: {
        'content-type': 'application/json',
        'content-length': '42',
      },
    });

    listeners.get('start')?.(request);
    listeners.get('proxyReq')?.(
      { removeHeader: vi.fn(), reusedSocket: false },
      request,
      undefined,
      undefined,
      { localPort: 49_001 },
    );
    vi.setSystemTime(new Date('2026-08-10T22:00:00.035Z'));
    listeners.get('proxyRes')?.(response, request);
    response.emit('end');

    expect(diagnosticSink).toHaveBeenCalledOnce();
    expect(diagnosticSink).toHaveBeenCalledWith({
      requestId: 'v2-messages:1',
      timestampStart: '2026-08-10T22:00:00.000Z',
      timestampEnd: '2026-08-10T22:00:00.035Z',
      method: 'POST',
      pathname: '/v2/messages',
      httpStatus: 202,
      durationMs: 35,
      result: 'success',
      contentType: 'application/json',
      contentLength: 42,
      activeGraphqlAtStart: 0,
      activeGraphqlAtEnd: 0,
      peakActiveGraphql: 0,
      completedGraphqlCount: 0,
      failedGraphqlCount: 0,
      upstreamSocketReused: false,
      upstreamLocalPort: 49_001,
      upstreamRemoteHost: 'mainnet.example',
      upstreamHttpVersion: null,
    });
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toMatch(
      /query-value|request-body|secret-auth|secret-cookie/i,
    );
    vi.useRealTimers();
  });

  it('ignores ordinary Vite traffic and isolates a failing diagnostic sink', () => {
    const diagnosticSink = vi.fn(() => {
      throw new Error('diagnostic sink unavailable');
    });
    const config = createMinerViteConfig(
      { VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example' },
      diagnosticSink,
    );
    const proxy = config.server?.proxy?.[MINER_CORE_DEV_V2_PROXY_PATH];
    if (!proxy || typeof proxy === 'string') throw new Error('Proxy unavailable.');
    const listeners = new Map<string, (...args: any[]) => void>();
    proxy.configure?.({
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      }),
    } as never, {} as never);
    const assetRequest = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/@vite/client',
    });
    listeners.get('start')?.(assetRequest);
    listeners.get('proxyReq')?.({ removeHeader: vi.fn() }, assetRequest);
    expect(diagnosticSink).not.toHaveBeenCalled();

    const beeRequest = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v2/messages',
    });
    listeners.get('start')?.(beeRequest);
    listeners.get('proxyReq')?.({ removeHeader: vi.fn() }, beeRequest);
    const timeout = Object.assign(new Error('socket timeout'), {
      code: 'ETIMEDOUT',
    });

    expect(() => listeners.get('error')?.(timeout, beeRequest)).not.toThrow();
    expect(diagnosticSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/v2/messages',
        result: 'timeout',
        httpStatus: null,
      }),
    );
  });

  it('classifies non-2xx upstream responses without changing proxy behavior', () => {
    const diagnosticSink = vi.fn();
    const config = createMinerViteConfig(
      { VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example' },
      diagnosticSink,
    );
    const proxy = config.server?.proxy?.[MINER_CORE_DEV_V2_PROXY_PATH];
    if (!proxy || typeof proxy === 'string') throw new Error('Proxy unavailable.');
    const listeners = new Map<string, (...args: any[]) => void>();
    proxy.configure?.({
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      }),
    } as never, {} as never);
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v2/messages',
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 503,
      complete: true,
      headers: { 'content-type': 'application/json' },
    });

    listeners.get('start')?.(request);
    listeners.get('proxyReq')?.({ removeHeader: vi.fn() }, request);
    listeners.get('proxyRes')?.(response, request);
    response.emit('end');

    expect(diagnosticSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/v2/messages',
        httpStatus: 503,
        result: 'non_2xx',
      }),
    );
  });

  it('records every GraphQL request with bounded safe metadata and exact concurrency', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T23:00:00.000Z'));
    const diagnosticSink = vi.fn();
    const config = createMinerViteConfig(
      { VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example' },
      diagnosticSink,
    );
    const proxy = config.server?.proxy?.[MINER_CORE_DEV_GRAPHQL_PROXY_PATH];
    if (!proxy || typeof proxy === 'string') throw new Error('Proxy unavailable.');
    const listeners = new Map<string, (...args: any[]) => void>();
    proxy.configure?.({
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      }),
    } as never, {} as never);
    const firstRequest = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/graphql?query=must-not-be-recorded',
      body: 'graphql-body-must-not-be-recorded',
      headers: { authorization: 'secret-auth', cookie: 'secret-cookie' },
    });
    const secondRequest = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/graphql?variables=must-not-be-recorded',
    });
    const firstResponse = Object.assign(new EventEmitter(), {
      statusCode: 200,
      complete: true,
      httpVersion: '1.1',
      headers: { 'content-type': 'application/json' },
    });
    const secondResponse = Object.assign(new EventEmitter(), {
      statusCode: 200,
      complete: true,
      httpVersion: '1.1',
      headers: { 'content-type': 'application/json', 'content-length': '512' },
    });

    listeners.get('start')?.(firstRequest);
    listeners.get('proxyReq')?.(
      { removeHeader: vi.fn(), reusedSocket: false },
      firstRequest,
      undefined,
      undefined,
      { localPort: 49_101 },
    );
    vi.setSystemTime(new Date('2026-08-10T23:00:00.010Z'));
    listeners.get('start')?.(secondRequest);
    listeners.get('proxyReq')?.(
      { removeHeader: vi.fn(), reusedSocket: true },
      secondRequest,
      undefined,
      undefined,
      { localPort: 49_102 },
    );

    vi.setSystemTime(new Date('2026-08-10T23:00:00.030Z'));
    listeners.get('proxyRes')?.(secondResponse, secondRequest);
    secondResponse.emit('end');
    vi.setSystemTime(new Date('2026-08-10T23:00:00.050Z'));
    listeners.get('proxyRes')?.(firstResponse, firstRequest);
    firstResponse.emit('end');

    expect(diagnosticSink).toHaveBeenCalledTimes(2);
    expect(diagnosticSink.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'graphql:2',
      pathname: '/graphql',
      httpStatus: 200,
      result: 'success',
      durationMs: 20,
      activeGraphqlAtStart: 2,
      activeGraphqlAtEnd: 1,
      peakActiveGraphql: 2,
      completedGraphqlCount: 1,
      failedGraphqlCount: 0,
      upstreamSocketReused: true,
      upstreamLocalPort: 49_102,
      upstreamRemoteHost: 'mainnet.example',
      upstreamHttpVersion: '1.1',
    });
    expect(diagnosticSink.mock.calls[1]?.[0]).toMatchObject({
      requestId: 'graphql:1',
      durationMs: 50,
      activeGraphqlAtStart: 1,
      activeGraphqlAtEnd: 0,
      peakActiveGraphql: 2,
      completedGraphqlCount: 2,
      failedGraphqlCount: 0,
    });
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toMatch(
      /must-not-be-recorded|graphql-body|secret-auth|secret-cookie/i,
    );
    vi.useRealTimers();
  });

  it('decrements GraphQL concurrency once on abort and proxy error paths', () => {
    const diagnosticSink = vi.fn();
    const config = createMinerViteConfig(
      { VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example' },
      diagnosticSink,
    );
    const proxy = config.server?.proxy?.[MINER_CORE_DEV_GRAPHQL_PROXY_PATH];
    if (!proxy || typeof proxy === 'string') throw new Error('Proxy unavailable.');
    const listeners = new Map<string, (...args: any[]) => void>();
    proxy.configure?.({
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      }),
    } as never, {} as never);
    const abortedRequest = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/graphql',
    });
    const failedRequest = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/graphql',
    });

    listeners.get('start')?.(abortedRequest);
    abortedRequest.emit('aborted');
    listeners.get('error')?.(new Error('late duplicate error'), abortedRequest);
    listeners.get('start')?.(failedRequest);
    listeners.get('error')?.(new Error('proxy unavailable'), failedRequest);

    expect(diagnosticSink).toHaveBeenCalledTimes(2);
    expect(diagnosticSink.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'graphql:1',
      result: 'aborted',
      activeGraphqlAtStart: 1,
      activeGraphqlAtEnd: 0,
      completedGraphqlCount: 1,
      failedGraphqlCount: 1,
    });
    expect(diagnosticSink.mock.calls[1]?.[0]).toMatchObject({
      requestId: 'graphql:2',
      result: 'proxy_error',
      activeGraphqlAtStart: 1,
      activeGraphqlAtEnd: 0,
      completedGraphqlCount: 2,
      failedGraphqlCount: 2,
    });
  });

  it('keeps the persistent proxy logger scoped to the development server', () => {
    const config = createMinerViteConfig({
      VITE_MINER_CORE_BEE_ENDPOINTS: 'https://mainnet.example',
    });
    const ownerPlugin = config.plugins?.find(
      (plugin) =>
        plugin !== null &&
        typeof plugin === 'object' &&
        !Array.isArray(plugin) &&
        'name' in plugin &&
        plugin.name === 'miner-core-dev-proxy-owner',
    );

    expect(ownerPlugin).toMatchObject({ apply: 'serve' });
    expect(config.build).toEqual({ outDir: 'dist', emptyOutDir: true });
  });

});
