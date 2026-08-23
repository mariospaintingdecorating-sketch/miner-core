import type { BrowserWindow, IpcMain, WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bindWindowMaximizedState,
  registerWindowControlHandlers,
  WINDOW_CONTROL_CHANNELS,
} from './windowControls.js';

describe('window controls', () => {
  it('controls only the BrowserWindow belonging to the IPC sender', async () => {
    const handlers = new Map<string, (event: { sender: WebContents }) => unknown>();
    const ipc = {
      handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    } as unknown as Pick<IpcMain, 'handle'>;
    const window = fakeWindow();
    const sender = {} as WebContents;
    const requestClose = vi.fn();
    registerWindowControlHandlers(
      ipc,
      (candidate: WebContents) =>
        candidate === sender ? window.value : null,
      requestClose,
    );

    await handlers.get(WINDOW_CONTROL_CHANNELS.minimize)?.({ sender });
    await handlers.get(WINDOW_CONTROL_CHANNELS.toggleMaximize)?.({ sender });
    window.maximized.value = true;
    await handlers.get(WINDOW_CONTROL_CHANNELS.toggleMaximize)?.({ sender });
    await handlers.get(WINDOW_CONTROL_CHANNELS.close)?.({ sender });

    expect(window.minimize).toHaveBeenCalledOnce();
    expect(window.maximize).toHaveBeenCalledOnce();
    expect(window.unmaximize).toHaveBeenCalledOnce();
    expect(requestClose).toHaveBeenCalledOnce();
    expect(requestClose).toHaveBeenCalledWith(window.value);
    expect(window.close).not.toHaveBeenCalled();
  });

  it('publishes maximize and restore state from BrowserWindow events', () => {
    const window = fakeWindow();
    const dispose = bindWindowMaximizedState(window.value);

    window.maximized.value = true;
    window.listeners.get('maximize')?.();
    window.maximized.value = false;
    window.listeners.get('unmaximize')?.();

    expect(window.send).toHaveBeenNthCalledWith(
      1,
      WINDOW_CONTROL_CHANNELS.maximizedChanged,
      true,
    );
    expect(window.send).toHaveBeenNthCalledWith(
      2,
      WINDOW_CONTROL_CHANNELS.maximizedChanged,
      false,
    );

    dispose();
    expect(window.removeListener).toHaveBeenCalledTimes(2);
  });

  it('keeps the preload bridge narrow and uses no state polling', () => {
    const preload = readFileSync(
      join(process.cwd(), 'electron', 'preload.cts'),
      'utf8',
    );
    const main = readFileSync(
      join(process.cwd(), 'electron', 'main.ts'),
      'utf8',
    );
    const rendererBootstrap = readFileSync(
      join(process.cwd(), 'src', 'main.tsx'),
      'utf8',
    );

    expect(preload).toContain("minimize: () => ipcRenderer.invoke(windowControlChannels.minimize)");
    expect(preload).toContain('onMaximizedChanged: (listener: (maximized: boolean) => void)');
    expect(preload).toContain("request: 'application:shutdown-requested'");
    expect(preload).toContain('ipcRenderer.once(shutdownChannels.request');
    expect(preload).toContain("status: 'completed'");
    expect(preload).toContain("status: 'failed'");
    expect(preload).not.toContain('error.message');
    expect(preload).not.toContain('setInterval');
    expect(preload).not.toContain('remote');
    expect(preload).not.toContain("exposeInMainWorld('electron'");
    expect(rendererBootstrap).toContain(
      'window.minerCoreApp?.lifecycle.onShutdownRequested',
    );
    expect(rendererBootstrap).toContain('await application.dispose()');
    expect(main).toContain('Menu.setApplicationMenu(null)');
    expect(main).toContain('window.removeMenu()');
    expect(main).toContain('window.setMenuBarVisibility(false)');
    expect(main).toContain('frame: false');
    expect(main).toContain('thickFrame: true');
    expect(main).toContain('backgroundThrottling: false');
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('nodeIntegration: false');
    expect(main).toContain('sandbox: true');
    expect(main).toContain("shutdownCoordinator.request('window-close')");
  });

  it('uses the approved multi-size ICO for the Windows runtime icon', () => {
    const main = readFileSync(
      join(process.cwd(), 'electron', 'main.ts'),
      'utf8',
    );
    const packageConfiguration = readFileSync(
      join(process.cwd(), 'package.json'),
      'utf8',
    );

    expect(main).toContain("'msii-miner-core-approved.ico'");
    expect(main).toContain('window.setAppDetails({');
    expect(main).toContain('appIconPath: applicationIconPath');
    expect(packageConfiguration).toContain(
      '"from": "assets/logo/msii-miner-core-approved.ico"',
    );
  });
});

function fakeWindow() {
  const maximized = { value: false };
  const listeners = new Map<string, () => void>();
  const minimize = vi.fn();
  const maximize = vi.fn();
  const unmaximize = vi.fn();
  const close = vi.fn();
  const send = vi.fn();
  const removeListener = vi.fn((event: string) => listeners.delete(event));
  const value = {
    minimize,
    maximize,
    unmaximize,
    close,
    isMaximized: () => maximized.value,
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send,
    },
    on: (event: string, listener: () => void) => {
      listeners.set(event, listener);
      return value;
    },
    removeListener,
  } as unknown as BrowserWindow;

  return {
    value,
    maximized,
    listeners,
    minimize,
    maximize,
    unmaximize,
    close,
    send,
    removeListener,
  };
}
