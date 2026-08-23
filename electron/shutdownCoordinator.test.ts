import { describe, expect, it, vi } from 'vitest';
import {
  bindWindowShutdown,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  requestApplicationQuit,
  ShutdownCoordinator,
} from './shutdownCoordinator.js';

describe('ShutdownCoordinator', () => {
  it('disposes Application before storage and final close exactly once', async () => {
    const order: string[] = [];
    const coordinator = new ShutdownCoordinator({
      requestApplicationDispose: vi.fn(async () => {
        order.push('application');
      }),
      closeStorage: vi.fn(async () => {
        order.push('storage');
      }),
      finalizeClose: vi.fn(() => order.push('close')),
      report: vi.fn(),
    });

    await coordinator.request('window-close');

    expect(order).toEqual(['application', 'storage', 'close']);
    expect(coordinator.allowWindowClose).toBe(true);
  });

  it('uses one shutdown Promise for repeated X requests', async () => {
    let finishApplication!: () => void;
    const requestApplicationDispose = vi.fn(
      () => new Promise<void>((resolve) => {
        finishApplication = resolve;
      }),
    );
    const closeStorage = vi.fn(async () => undefined);
    const finalizeClose = vi.fn();
    const coordinator = new ShutdownCoordinator({
      requestApplicationDispose,
      closeStorage,
      finalizeClose,
      report: vi.fn(),
    });

    const first = coordinator.request('window-close');
    const second = coordinator.request('window-close');
    expect(second).toBe(first);
    await vi.waitFor(() => expect(requestApplicationDispose).toHaveBeenCalledOnce());
    finishApplication();
    await first;

    expect(requestApplicationDispose).toHaveBeenCalledOnce();
    expect(closeStorage).toHaveBeenCalledOnce();
    expect(finalizeClose).toHaveBeenCalledOnce();
  });

  it('routes BrowserWindow close and Alt+F4 through the same guarded shutdown', async () => {
    const listeners = new Set<(event: { preventDefault(): void }) => void>();
    const source = {
      on: vi.fn((_event, listener) => listeners.add(listener)),
      removeListener: vi.fn((_event, listener) => listeners.delete(listener)),
    };
    const requestApplicationDispose = vi.fn(async () => undefined);
    const coordinator = new ShutdownCoordinator({
      requestApplicationDispose,
      closeStorage: vi.fn(async () => undefined),
      finalizeClose: vi.fn(),
      report: vi.fn(),
    });
    const unbind = bindWindowShutdown(source, coordinator);
    const firstEvent = { preventDefault: vi.fn() };

    for (const listener of listeners) listener(firstEvent);
    await coordinator.request('window-close');

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(requestApplicationDispose).toHaveBeenCalledOnce();

    const finalEvent = { preventDefault: vi.fn() };
    for (const listener of listeners) listener(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();

    unbind();
    expect(listeners.size).toBe(0);
  });

  it('routes app.quit through the active coordinator without a second disposal', async () => {
    const requestApplicationDispose = vi.fn(async () => undefined);
    const coordinator = new ShutdownCoordinator({
      requestApplicationDispose,
      closeStorage: vi.fn(async () => undefined),
      finalizeClose: vi.fn(),
      report: vi.fn(),
    });
    const firstQuit = { preventDefault: vi.fn() };

    requestApplicationQuit(firstQuit, coordinator);
    await coordinator.request('app-quit');
    requestApplicationQuit({ preventDefault: vi.fn() }, coordinator);

    expect(firstQuit.preventDefault).toHaveBeenCalledOnce();
    expect(requestApplicationDispose).toHaveBeenCalledOnce();
  });

  it('reports Application disposal failure and still closes storage and the app', async () => {
    const report = vi.fn();
    const closeStorage = vi.fn(async () => undefined);
    const finalizeClose = vi.fn();
    const coordinator = new ShutdownCoordinator({
      requestApplicationDispose: vi.fn(async () => {
        throw new Error('private renderer failure');
      }),
      closeStorage,
      finalizeClose,
      report,
    });

    await coordinator.request('window-close');

    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'application-dispose-failed',
      detail: 'Renderer application disposal failed.',
    }));
    expect(closeStorage).toHaveBeenCalledOnce();
    expect(finalizeClose).toHaveBeenCalledOnce();
  });

  it('bounds a hung or non-responsive renderer at 15 seconds', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const closeStorage = vi.fn(async () => undefined);
    const finalizeClose = vi.fn();
    let aborted = false;
    const coordinator = new ShutdownCoordinator({
      requestApplicationDispose: vi.fn((signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<void>(() => undefined);
      }),
      closeStorage,
      finalizeClose,
      report,
    });

    try {
      const shutdown = coordinator.request('window-close');
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS - 1);
      expect(finalizeClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await shutdown;

      expect(report).toHaveBeenCalledWith(expect.objectContaining({
        stage: 'shutdown-timeout',
      }));
      expect(aborted).toBe(true);
      expect(closeStorage).toHaveBeenCalledOnce();
      expect(finalizeClose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finalizes once when storage close throws and diagnostics reporting fails', async () => {
    const finalizeClose = vi.fn();
    const coordinator = new ShutdownCoordinator({
      requestApplicationDispose: vi.fn(async () => undefined),
      closeStorage: vi.fn(async () => {
        throw new Error('storage close failed');
      }),
      finalizeClose,
      report: vi.fn(async () => {
        throw new Error('diagnostics unavailable');
      }),
    });

    await coordinator.request('app-quit');
    await coordinator.request('window-close');

    expect(finalizeClose).toHaveBeenCalledOnce();
    expect(coordinator.allowWindowClose).toBe(true);
  });
});
