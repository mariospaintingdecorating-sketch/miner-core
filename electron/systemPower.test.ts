import type { IpcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  registerSystemPowerHandler,
  SYSTEM_SHUTDOWN_COMPUTER_CHANNEL,
} from './systemPower.js';

describe('system power IPC', () => {
  it('exposes one fixed Windows shutdown operation without renderer arguments', async () => {
    const handlers = new Map<string, () => unknown>();
    const shutdownWindowsComputer = vi.fn(async () => undefined);
    registerSystemPowerHandler({
      handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    } as unknown as Pick<IpcMain, 'handle'>, {
      platform: 'win32',
      isApplicationShuttingDown: () => false,
      shutdownWindowsComputer,
    });

    await expect(
      handlers.get(SYSTEM_SHUTDOWN_COMPUTER_CHANNEL)?.(),
    ).resolves.toBe('requested');
    expect(shutdownWindowsComputer).toHaveBeenCalledOnce();
    expect(handlers).toHaveProperty('size', 1);
  });

  it('does not run a command outside Windows or during application shutdown', async () => {
    const handlers = new Map<string, () => unknown>();
    const shutdownWindowsComputer = vi.fn(async () => undefined);
    const ipc = {
      handle: vi.fn((channel: string, handler: () => unknown) =>
        handlers.set(channel, handler)),
    } as unknown as Pick<IpcMain, 'handle'>;

    registerSystemPowerHandler(ipc, {
      platform: 'linux',
      isApplicationShuttingDown: () => false,
      shutdownWindowsComputer,
    });
    await expect(
      handlers.get(SYSTEM_SHUTDOWN_COMPUTER_CHANNEL)?.(),
    ).resolves.toBe('unsupported');
    expect(shutdownWindowsComputer).not.toHaveBeenCalled();
  });

  it('keeps the preload capability narrow and uses the fixed shutdown.exe command', () => {
    const preload = readFileSync(join(process.cwd(), 'electron', 'preload.cts'), 'utf8');
    const source = readFileSync(join(process.cwd(), 'electron', 'systemPower.ts'), 'utf8');

    expect(preload).toContain("const systemShutdownComputerChannel = 'system:shutdown-computer'");
    expect(preload).toContain('shutdownComputer: () => ipcRenderer.invoke(systemShutdownComputerChannel)');
    expect(preload).not.toContain('child_process');
    expect(source.replace(/\r\n/g, '\n')).toContain("execFile(\n      'shutdown.exe'");
    expect(source).toContain("['/s', '/t', '0']");
    expect(source).toContain('{ windowsHide: true }');
  });
});
