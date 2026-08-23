import type { BrowserWindow, IpcMain, WebContents } from 'electron';

export const WINDOW_CONTROL_CHANNELS = Object.freeze({
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  close: 'window:close',
  isMaximized: 'window:is-maximized',
  maximizedChanged: 'window:maximized-changed',
});

export function registerWindowControlHandlers(
  ipc: Pick<IpcMain, 'handle'>,
  resolveWindow: (sender: WebContents) => BrowserWindow | null,
  requestClose: (window: BrowserWindow) => void,
): void {
  ipc.handle(WINDOW_CONTROL_CHANNELS.minimize, (event) => {
    controlledWindow(resolveWindow(event.sender))?.minimize();
  });
  ipc.handle(WINDOW_CONTROL_CHANNELS.toggleMaximize, (event) => {
    const window = controlledWindow(resolveWindow(event.sender));
    if (!window) return;

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });
  ipc.handle(WINDOW_CONTROL_CHANNELS.close, (event) => {
    const window = controlledWindow(resolveWindow(event.sender));
    if (window) requestClose(window);
  });
  ipc.handle(WINDOW_CONTROL_CHANNELS.isMaximized, (event) =>
    controlledWindow(resolveWindow(event.sender))?.isMaximized() ?? false,
  );
}

export function bindWindowMaximizedState(window: BrowserWindow): () => void {
  const publish = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(
      WINDOW_CONTROL_CHANNELS.maximizedChanged,
      window.isMaximized(),
    );
  };

  window.on('maximize', publish);
  window.on('unmaximize', publish);

  return () => {
    window.removeListener('maximize', publish);
    window.removeListener('unmaximize', publish);
  };
}

function controlledWindow(window: BrowserWindow | null): BrowserWindow | null {
  return window && !window.isDestroyed() ? window : null;
}
