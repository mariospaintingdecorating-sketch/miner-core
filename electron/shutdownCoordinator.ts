export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 15_000;

export type ShutdownReason = 'window-close' | 'app-quit';

export type ShutdownDiagnosticStage =
  | 'shutdown-requested'
  | 'application-dispose-started'
  | 'application-dispose-completed'
  | 'application-dispose-failed'
  | 'shutdown-timeout'
  | 'storage-close-completed'
  | 'storage-close-failed';

export interface ShutdownDiagnostic {
  readonly stage: ShutdownDiagnosticStage;
  readonly reason: ShutdownReason;
  readonly detail: string | null;
}

export interface ShutdownCoordinatorDependencies {
  requestApplicationDispose(signal: AbortSignal): Promise<void>;
  closeStorage(): Promise<void>;
  finalizeClose(): void;
  report(diagnostic: Readonly<ShutdownDiagnostic>): void | Promise<void>;
  readonly timeoutMs?: number;
}

export interface PreventableCloseEvent {
  preventDefault(): void;
}

export interface CloseEventSource {
  on(event: 'close', listener: (event: PreventableCloseEvent) => void): unknown;
  removeListener(
    event: 'close',
    listener: (event: PreventableCloseEvent) => void,
  ): unknown;
}

export class ShutdownCoordinator {
  #shutdown: Promise<void> | null = null;
  #allowWindowClose = false;

  constructor(private readonly dependencies: ShutdownCoordinatorDependencies) {}

  get allowWindowClose(): boolean {
    return this.#allowWindowClose;
  }

  get isShuttingDown(): boolean {
    return this.#shutdown !== null;
  }

  request(reason: ShutdownReason): Promise<void> {
    if (!this.#shutdown) {
      this.#shutdown = this.#run(reason);
    }

    return this.#shutdown;
  }

  async #run(reason: ShutdownReason): Promise<void> {
    void this.#report({ stage: 'shutdown-requested', reason, detail: null });
    void this.#report({
      stage: 'application-dispose-started',
      reason,
      detail: null,
    });

    const controller = new AbortController();
    const timeoutMs =
      this.dependencies.timeoutMs ?? GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let applicationDisposal: Promise<void>;
    try {
      applicationDisposal = this.dependencies.requestApplicationDispose(
        controller.signal,
      );
    } catch {
      applicationDisposal = Promise.reject(
        new Error('Application disposal request failed.'),
      );
    }
    const disposal = applicationDisposal.then(
      () => 'completed' as const,
      () => 'failed' as const,
    );
    const timedOut = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const applicationResult = await Promise.race([disposal, timedOut]);

    if (timeout) {
      clearTimeout(timeout);
    }
    controller.abort();

    if (applicationResult === 'completed') {
      void this.#report({
        stage: 'application-dispose-completed',
        reason,
        detail: null,
      });
    } else if (applicationResult === 'failed') {
      void this.#report({
        stage: 'application-dispose-failed',
        reason,
        detail: 'Renderer application disposal failed.',
      });
    } else {
      void this.#report({
        stage: 'shutdown-timeout',
        reason,
        detail: `Renderer application disposal exceeded ${timeoutMs} ms.`,
      });
    }

    try {
      await this.dependencies.closeStorage();
      void this.#report({
        stage: 'storage-close-completed',
        reason,
        detail: null,
      });
    } catch {
      void this.#report({
        stage: 'storage-close-failed',
        reason,
        detail: 'Persistent storage close failed.',
      });
    } finally {
      this.#allowWindowClose = true;
      this.dependencies.finalizeClose();
    }
  }

  async #report(diagnostic: Readonly<ShutdownDiagnostic>): Promise<void> {
    try {
      await this.dependencies.report(Object.freeze(diagnostic));
    } catch {
      // Shutdown diagnostics cannot block application shutdown.
    }
  }
}

export function bindWindowShutdown(
  window: CloseEventSource,
  coordinator: ShutdownCoordinator,
): () => void {
  const onClose = (event: PreventableCloseEvent): void => {
    if (coordinator.allowWindowClose) {
      return;
    }

    event.preventDefault();
    void coordinator.request('window-close');
  };

  window.on('close', onClose);
  return () => window.removeListener('close', onClose);
}

export function requestApplicationQuit(
  event: PreventableCloseEvent,
  coordinator: ShutdownCoordinator,
): void {
  if (coordinator.allowWindowClose) {
    return;
  }

  event.preventDefault();
  void coordinator.request('app-quit');
}
