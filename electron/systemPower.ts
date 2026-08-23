import { execFile } from 'node:child_process';
import type { IpcMain } from 'electron';

export const SYSTEM_SHUTDOWN_COMPUTER_CHANNEL = 'system:shutdown-computer';

export type SystemShutdownComputerResult =
  | 'requested'
  | 'unsupported'
  | 'failed'
  | 'busy';

export interface SystemPowerDependencies {
  readonly platform?: NodeJS.Platform;
  isApplicationShuttingDown(): boolean;
  shutdownWindowsComputer?(): Promise<void>;
}

export function registerSystemPowerHandler(
  ipc: Pick<IpcMain, 'handle'>,
  dependencies: SystemPowerDependencies,
): void {
  ipc.handle(SYSTEM_SHUTDOWN_COMPUTER_CHANNEL, async () => {
    if (dependencies.isApplicationShuttingDown()) return 'busy';
    if ((dependencies.platform ?? process.platform) !== 'win32') {
      return 'unsupported';
    }

    try {
      await (dependencies.shutdownWindowsComputer ?? shutdownWindowsComputer)();
      return 'requested';
    } catch {
      return 'failed';
    }
  });
}

export function shutdownWindowsComputer(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'shutdown.exe',
      ['/s', '/t', '0'],
      { windowsHide: true },
      (error) => error ? reject(error) : resolve(),
    );
  });
}
