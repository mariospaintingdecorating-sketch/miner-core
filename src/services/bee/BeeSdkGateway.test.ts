import { describe, expect, it, vi } from 'vitest';
import { CoreEventEmitter } from '../../shared/events';
import type {
  BeeSdkOwnedResource,
  BeeSdkRuntimeAdapter,
} from './contracts';
import { BeeSdkGateway } from './BeeSdkGateway';
import { TeamGoshBeeSdkRuntimeAdapter } from './TeamGoshBeeSdkRuntimeAdapter';

function runtimeAdapter(
  overrides: Partial<BeeSdkRuntimeAdapter> = {},
): BeeSdkRuntimeAdapter {
  return {
    initialize: vi.fn(async () => undefined),
    version: vi.fn(() => 'test-version'),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('BeeSdkGateway', () => {
  it('creates the production WASM adapter without initializing external work', async () => {
    const gateway = new BeeSdkGateway(new TeamGoshBeeSdkRuntimeAdapter());

    expect(gateway.readiness()).toEqual({
      status: 'idle',
      version: null,
      failure: null,
    });

    await gateway.dispose();
    expect(gateway.readiness().status).toBe('disposed');
  });

  it('initializes once and exposes immutable readiness', async () => {
    let finishInitialization: (() => void) | undefined;
    const initialize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInitialization = resolve;
        }),
    );
    const adapter = runtimeAdapter({ initialize });
    const gateway = new BeeSdkGateway(adapter);

    const firstInitialization = gateway.initialize();
    const secondInitialization = gateway.initialize();

    expect(firstInitialization).toBe(secondInitialization);
    expect(gateway.readiness()).toEqual({
      status: 'initializing',
      version: null,
      failure: null,
    });

    finishInitialization?.();
    await Promise.all([firstInitialization, secondInitialization]);
    await gateway.initialize();

    const readiness = gateway.readiness();
    expect(initialize).toHaveBeenCalledOnce();
    expect(readiness).toEqual({
      status: 'ready',
      version: 'test-version',
      failure: null,
    });
    expect(Object.isFrozen(readiness)).toBe(true);
  });

  it('owns and explicitly frees SDK resources during disposal', async () => {
    const adapter = runtimeAdapter();
    const gateway = new BeeSdkGateway(adapter);
    const first = { free: vi.fn() } satisfies BeeSdkOwnedResource;
    const second = { free: vi.fn() } satisfies BeeSdkOwnedResource;

    await gateway.initialize();
    expect(gateway.ownResource(first)).toBe(first);
    expect(gateway.ownResource(second)).toBe(second);

    const firstDisposal = gateway.dispose();
    const secondDisposal = gateway.dispose();
    expect(firstDisposal).toBe(secondDisposal);
    await firstDisposal;

    expect(first.free).toHaveBeenCalledOnce();
    expect(second.free).toHaveBeenCalledOnce();
    expect(adapter.dispose).toHaveBeenCalledOnce();
    expect(gateway.readiness().status).toBe('disposed');
  });

  it('releases an owned resource exactly once before gateway disposal', async () => {
    const resource = { free: vi.fn() };
    const gateway = new BeeSdkGateway(runtimeAdapter());
    await gateway.initialize();
    gateway.ownResource(resource);

    gateway.releaseResource(resource);
    gateway.releaseResource(resource);
    await gateway.dispose();

    expect(resource.free).toHaveBeenCalledOnce();
  });

  it('keeps ownership when an explicit resource release fails', async () => {
    const releaseFailure = new Error('First release failed');
    const resource = {
      free: vi
        .fn<() => void>()
        .mockImplementationOnce(() => {
          throw releaseFailure;
        })
        .mockImplementationOnce(() => undefined),
    };
    const gateway = new BeeSdkGateway(runtimeAdapter());
    await gateway.initialize();
    gateway.ownResource(resource);

    expect(() => gateway.releaseResource(resource)).toThrow(releaseFailure);
    await gateway.dispose();

    expect(resource.free).toHaveBeenCalledTimes(2);
    expect(gateway.readiness()).toMatchObject({
      status: 'disposed',
      failure: {
        code: 'bee-sdk-disposal-failed',
        message: 'First release failed',
      },
    });
  });

  it('releases a resource returned after gateway disposal starts', async () => {
    const resource = { free: vi.fn() };
    const gateway = new BeeSdkGateway(runtimeAdapter());
    await gateway.initialize();

    const disposal = gateway.dispose();
    expect(() => gateway.ownResource(resource)).toThrow(
      'resource was released because the gateway is disposing',
    );
    await disposal;

    expect(resource.free).toHaveBeenCalledOnce();
    expect(gateway.readiness().status).toBe('disposed');
  });

  it('keeps a late resource tracked when its first cleanup attempt fails', async () => {
    const cleanupFailure = new Error('Late resource cleanup failed');
    const resource = {
      free: vi
        .fn<() => void>()
        .mockImplementationOnce(() => {
          throw cleanupFailure;
        })
        .mockImplementationOnce(() => undefined),
    };
    const gateway = new BeeSdkGateway(runtimeAdapter());
    await gateway.initialize();

    const disposal = gateway.dispose();
    expect(() => gateway.ownResource(resource)).toThrow(AggregateError);
    await disposal;

    expect(resource.free).toHaveBeenCalledTimes(2);
    expect(gateway.readiness()).toMatchObject({
      status: 'disposed',
      failure: {
        code: 'bee-sdk-disposal-failed',
        message: 'Late resource cleanup failed',
      },
    });
  });

  it('continues cleanup and exposes disposal failures', async () => {
    const resourceFailure = new Error('Resource free failed');
    const adapter = runtimeAdapter();
    const gateway = new BeeSdkGateway(adapter);
    const failingResource = {
      free: vi.fn(() => {
        throw resourceFailure;
      }),
    };
    const releasedResource = { free: vi.fn() };
    await gateway.initialize();
    gateway.ownResource(failingResource);
    gateway.ownResource(releasedResource);

    await expect(gateway.dispose()).rejects.toBeInstanceOf(AggregateError);

    expect(failingResource.free).toHaveBeenCalledOnce();
    expect(releasedResource.free).toHaveBeenCalledOnce();
    expect(adapter.dispose).toHaveBeenCalledOnce();
    expect(gateway.readiness()).toEqual({
      status: 'disposed',
      version: 'test-version',
      failure: {
        code: 'bee-sdk-disposal-failed',
        message: 'Resource free failed',
      },
    });
  });

  it('makes initialization failures observable without retry ownership', async () => {
    const failure = new Error('WASM failed to load');
    const initialize = vi.fn(async () => {
      throw failure;
    });
    const gateway = new BeeSdkGateway(runtimeAdapter({ initialize }));

    await expect(gateway.initialize()).rejects.toBe(failure);
    await expect(gateway.initialize()).rejects.toBe(failure);

    const readiness = gateway.readiness();
    expect(initialize).toHaveBeenCalledOnce();
    expect(readiness).toEqual({
      status: 'failed',
      version: null,
      failure: {
        code: 'bee-sdk-initialization-failed',
        message: 'WASM failed to load',
      },
    });
    expect(Object.isFrozen(readiness.failure)).toBe(true);

    await gateway.dispose();
    expect(gateway.readiness()).toMatchObject({
      status: 'disposed',
      failure: { code: 'bee-sdk-initialization-failed' },
    });
  });

  it('publishes a sanitized SDK failure while retaining internal failure detail', async () => {
    const eventBus = new CoreEventEmitter();
    const listener = vi.fn();
    eventBus.subscribe('bee-sdk-failed', listener);
    const gateway = new BeeSdkGateway(
      runtimeAdapter({
        initialize: vi.fn(async () => {
          throw new Error('SECRET native loader path');
        }),
      }),
      eventBus,
    );

    await expect(gateway.initialize()).rejects.toThrow('SECRET native loader path');

    expect(gateway.readiness().failure?.message).toBe(
      'SECRET native loader path',
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          version: null,
          code: 'bee-sdk-initialization-failed',
          message:
            'Bee SDK operation failed (bee-sdk-initialization-failed).',
        },
      }),
    );
    expect(JSON.stringify(listener.mock.calls)).not.toContain(
      'SECRET native loader path',
    );
    await gateway.dispose();
  });

  it('finishes initialization cleanup when disposal is requested in flight', async () => {
    let finishInitialization: (() => void) | undefined;
    const adapter = runtimeAdapter({
      initialize: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishInitialization = resolve;
          }),
      ),
    });
    const gateway = new BeeSdkGateway(adapter);
    const initialization = gateway.initialize();
    const disposal = gateway.dispose();

    expect(gateway.readiness().status).toBe('disposing');
    await expect(gateway.initialize()).rejects.toThrow('disposed');
    finishInitialization?.();
    await initialization;
    await disposal;

    expect(adapter.dispose).toHaveBeenCalledOnce();
    expect(gateway.readiness().status).toBe('disposed');
  });

  it('exposes resource ownership but no Core lifecycle controls', async () => {
    const gateway = new BeeSdkGateway(runtimeAdapter());
    await gateway.initialize();

    expect(Object.getOwnPropertyNames(BeeSdkGateway.prototype).sort()).toEqual([
      'constructor',
      'dispose',
      'initialize',
      'ownResource',
      'readiness',
      'releaseResource',
    ]);
    expect('start' in gateway).toBe(false);
    expect('stop' in gateway).toBe(false);
    expect('restart' in gateway).toBe(false);
    expect('createSession' in gateway).toBe(false);
    expect('settle' in gateway).toBe(false);
    expect('executeTap' in gateway).toBe(false);
    expect('synchronizeRewards' in gateway).toBe(false);
  });
});
