export const SHUTDOWN_CHANNELS = Object.freeze({
  request: 'application:shutdown-requested',
  complete: 'application:shutdown-completed',
});

export type RendererShutdownResult = Readonly<{
  status: 'completed' | 'failed';
}>;
