import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
  utilityProcess,
} from 'electron';
import type { IpcMainEvent, WebContents } from 'electron';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedWalletApprovalUrl } from './externalNavigation.js';
import { PersistentStorage } from './PersistentStorage.js';
import { STORAGE_CHANNELS } from './storageChannels.js';
import {
  createDiagnosticsArchive,
  diagnosticsArchiveFileName,
} from './diagnosticsExport.js';
import {
  DIAGNOSTICS_EXPORT_CHANNEL,
  SYSTEM_METRICS_CHANNEL,
} from './observabilityChannels.js';
import { collectSystemMetrics } from './systemMetrics.js';
import {
  openAckiWalletApp,
  WALLET_APP_OPEN_CHANNEL,
} from './walletAppLauncher.js';
import {
  MAMA_BOARD_READ_CHANNEL,
  readMamaBoardLevelOnChain,
} from './mamaBoardReader.js';
import { minerCoreUserDataConfiguration } from './userData.js';
import {
  bindWindowMaximizedState,
  registerWindowControlHandlers,
} from './windowControls.js';
import { SHUTDOWN_CHANNELS } from './shutdownChannels.js';
import type { RendererShutdownResult } from './shutdownChannels.js';
import {
  bindWindowShutdown,
  requestApplicationQuit,
  ShutdownCoordinator,
} from './shutdownCoordinator.js';
import type { ShutdownDiagnostic } from './shutdownCoordinator.js';
import { registerSystemPowerHandler } from './systemPower.js';
import {
  BeeMiningUtilitySupervisor,
  registerBeeMiningUtilityHandlers,
} from './beeMiningUtilitySupervisor.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const isDevelopment = process.argv.includes('--dev');
const WINDOWS_APP_USER_MODEL_ID = 'com.msii.miner-core';
const applicationIconFileName = process.platform === 'win32'
  ? 'msii-miner-core-approved.ico'
  : 'msii-miner-core-approved.png';
const applicationIconPath = app.isPackaged
  ? join(process.resourcesPath, 'logo', applicationIconFileName)
  : join(app.getAppPath(), 'assets', 'logo', applicationIconFileName);
let persistentStorage: PersistentStorage | null = null;
let mainWindow: BrowserWindow | null = null;
let beeMiningUtilitySupervisor: BeeMiningUtilitySupervisor | null = null;
let pendingRendererDisposal: {
  readonly sender: WebContents;
  complete(result: RendererShutdownResult): void;
} | null = null;
let shutdownDiagnosticSequence = 0;

app.setName('Core Miner');

const userDataConfiguration = minerCoreUserDataConfiguration(
  app.getPath('appData'),
  app.isPackaged,
);
mkdirSync(userDataConfiguration.userDataPath, { recursive: true });
app.setPath('userData', userDataConfiguration.userDataPath);
console.info(
  `[storage] profile=${userDataConfiguration.profile} userData=${userDataConfiguration.userDataPath}`,
);

function requestRendererApplicationDispose(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const sender = mainWindow?.webContents;

    if (!sender || sender.isDestroyed()) {
      reject(new Error('Renderer is unavailable for application disposal.'));
      return;
    }

    if (pendingRendererDisposal) {
      reject(new Error('Renderer application disposal is already pending.'));
      return;
    }

    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      sender.removeListener('destroyed', onDestroyed);
      if (pendingRendererDisposal?.sender === sender) {
        pendingRendererDisposal = null;
      }
    };
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onAbort = (): void => {
      settle(() => reject(new Error('Renderer application disposal was cancelled.')));
    };
    const onDestroyed = (): void => {
      settle(() => reject(new Error('Renderer closed before application disposal.')));
    };

    pendingRendererDisposal = {
      sender,
      complete: (result) => {
        settle(() => {
          if (result.status === 'completed') {
            resolve();
          } else {
            reject(new Error('Renderer application disposal failed.'));
          }
        });
      },
    };
    signal.addEventListener('abort', onAbort, { once: true });
    sender.once('destroyed', onDestroyed);

    if (signal.aborted) {
      onAbort();
      return;
    }

    try {
      sender.send(SHUTDOWN_CHANNELS.request);
    } catch {
      settle(() => reject(new Error('Renderer shutdown request could not be sent.')));
    }
  });
}

function registerShutdownResultHandler(): void {
  ipcMain.on(
    SHUTDOWN_CHANNELS.complete,
    (event: IpcMainEvent, result: unknown) => {
      const pending = pendingRendererDisposal;
      if (
        !pending ||
        pending.sender !== event.sender ||
        !isRendererShutdownResult(result)
      ) {
        return;
      }

      pending.complete(result);
    },
  );
}

function isRendererShutdownResult(value: unknown): value is RendererShutdownResult {
  if (!value || typeof value !== 'object') return false;
  const status = (value as { status?: unknown }).status;
  return status === 'completed' || status === 'failed';
}

async function reportShutdownDiagnostic(
  diagnostic: Readonly<ShutdownDiagnostic>,
): Promise<void> {
  const timestamp = new Date().toISOString();
  console.info(
    `[shutdown] stage=${diagnostic.stage} reason=${diagnostic.reason}`,
  );
  const storage = persistentStorage;
  if (!storage || diagnostic.stage === 'storage-close-completed') return;

  shutdownDiagnosticSequence += 1;
  await storage.appendDiagnostic(Object.freeze({
    id: `shutdown:${Date.now()}:${shutdownDiagnosticSequence}`,
    timestamp,
    eventType: 'runtime-error',
    level:
      diagnostic.stage === 'application-dispose-failed' ||
      diagnostic.stage === 'storage-close-failed'
        ? 'error'
        : diagnostic.stage === 'shutdown-timeout'
          ? 'warning'
          : 'info',
    category: 'SYSTEM',
    title: diagnostic.stage,
    detail: diagnostic.detail,
    walletId: null,
    sessionId: null,
    generation: null,
    miniEpoch: null,
    code: diagnostic.stage,
    message: diagnostic.detail,
    details: Object.freeze({ reason: diagnostic.reason }),
  }));
}

async function closePersistentStorage(): Promise<void> {
  const storage = persistentStorage;
  if (!storage) return;

  try {
    await storage.close();
  } finally {
    persistentStorage = null;
  }
}

const shutdownCoordinator = new ShutdownCoordinator({
  requestApplicationDispose: requestRendererApplicationDispose,
  closeStorage: closePersistentStorage,
  report: reportShutdownDiagnostic,
  finalizeClose: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
    app.quit();
  },
});

function registerStorageHandlers(storage: PersistentStorage): void {
  ipcMain.handle(STORAGE_CHANNELS.listWallets, () => storage.listWallets());
  ipcMain.handle(STORAGE_CHANNELS.saveWallet, (_event, wallet: unknown) =>
    storage.saveWallet(wallet),
  );
  ipcMain.handle(STORAGE_CHANNELS.removeWallet, (_event, walletId: unknown) =>
    storage.removeWallet(walletId),
  );
  ipcMain.handle(STORAGE_CHANNELS.appendReward, (_event, reward: unknown) =>
    storage.appendReward(reward),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.rewardsForWallet,
    (_event, walletId: unknown, limit: unknown) =>
      storage.rewardsForWallet(walletId, limit),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.appendWalletBalanceSnapshot,
    (_event, snapshot: unknown) => storage.appendWalletBalanceSnapshot(snapshot),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.walletBalanceSnapshots,
    (_event, walletId: unknown, limit: unknown) =>
      storage.walletBalanceSnapshots(walletId, limit),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.saveWalletSessionResult,
    (_event, result: unknown) => storage.saveWalletSessionResult(result),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.walletSessionResults,
    (_event, walletId: unknown, limit: unknown) =>
      storage.walletSessionResults(walletId, limit),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.appendDiagnostic,
    (_event, diagnostic: unknown) => storage.appendDiagnostic(diagnostic),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.recentDiagnostics,
    (_event, limit: unknown) => storage.recentDiagnostics(limit),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.saveSecureValue,
    (_event, reference: unknown, value: unknown) => {
      if (typeof value !== 'string' || !safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure operating-system storage is unavailable.');
      }

      storage.saveSecureValue(
        reference,
        safeStorage.encryptString(value).toString('base64'),
      );
    },
  );
  ipcMain.handle(
    STORAGE_CHANNELS.hasSecureValue,
    (_event, reference: unknown) => storage.hasSecureValue(reference),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.loadSecureValue,
    (_event, reference: unknown) => {
      const encrypted = storage.loadSecureValue(reference);

      if (encrypted === null) {
        return null;
      }

      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure operating-system storage is unavailable.');
      }

      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    },
  );
  ipcMain.handle(
    STORAGE_CHANNELS.removeSecureValue,
    (_event, reference: unknown) => storage.removeSecureValue(reference),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.globalMiningUptimeSnapshot,
    (_event, at: unknown) => storage.globalMiningUptimeSnapshot(at),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.startGlobalMiningUptime,
    (_event, startedAt: unknown) => storage.startGlobalMiningUptime(startedAt),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.heartbeatGlobalMiningUptime,
    (_event, activeAt: unknown) => storage.heartbeatGlobalMiningUptime(activeAt),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.stopGlobalMiningUptime,
    (_event, endedAt: unknown) => storage.stopGlobalMiningUptime(endedAt),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.loadMainEpochStartSchedule,
    () => storage.loadMainEpochStartSchedule(),
  );
  ipcMain.handle(
    STORAGE_CHANNELS.saveMainEpochStartSchedule,
    (_event, snapshot: unknown) => storage.saveMainEpochStartSchedule(snapshot),
  );
}

function registerWalletAppHandler(): void {
  ipcMain.handle(
    WALLET_APP_OPEN_CHANNEL,
    (_event, walletId: unknown, deepLink: unknown) => {
      if (
        typeof walletId !== 'string' ||
        walletId.trim().length === 0 ||
        walletId.length > 256
      ) {
        throw new Error('Invalid wallet ID.');
      }

      if (
        typeof deepLink !== 'string' ||
        !isAllowedWalletApprovalUrl(deepLink)
      ) {
        throw new Error('Invalid wallet approval link.');
      }

      return openAckiWalletApp(deepLink);
    },
  );
}

function registerMamaBoardHandler(): void {
  ipcMain.handle(
    MAMA_BOARD_READ_CHANNEL,
    (_event, endpoint: unknown, minerAddress: unknown) =>
      readMamaBoardLevelOnChain(endpoint, minerAddress),
  );
}

function registerObservabilityHandlers(): void {
  ipcMain.handle(SYSTEM_METRICS_CHANNEL, () =>
    collectSystemMetrics(
      app.getAppMetrics(),
      process.uptime() * 1_000,
      new Date().toISOString(),
    ),
  );
  ipcMain.handle(
    DIAGNOSTICS_EXPORT_CHANNEL,
    async (_event, bundle: unknown) => {
      const fileName = diagnosticsArchiveFileName();
      const archive = createDiagnosticsArchive(bundle);
      const destination = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('documents'), fileName),
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });

      if (destination.canceled || !destination.filePath) {
        return Object.freeze({
          status: 'cancelled' as const,
          fileName: null,
          message: null,
        });
      }

      await writeFile(destination.filePath, archive);
      return Object.freeze({
        status: 'saved' as const,
        fileName: basename(destination.filePath),
        message: null,
      });
    },
  );
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#070b12',
    autoHideMenuBar: false,
    frame: false,
    thickFrame: true,
    icon: applicationIconPath,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(currentDirectory, 'preload.cjs'),
    },
  });

  window.removeMenu();
  window.setMenuBarVisibility(false);
  if (process.platform === 'win32') {
    window.setAppDetails({
      appId: WINDOWS_APP_USER_MODEL_ID,
      appIconPath: applicationIconPath,
      appIconIndex: 0,
    });
  }
  const unbindMaximizedState = bindWindowMaximizedState(window);
  const unbindShutdown = bindWindowShutdown(window, shutdownCoordinator);
  window.once('closed', () => {
    unbindMaximizedState();
    unbindShutdown();
    if (mainWindow === window) mainWindow = null;
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedWalletApprovalUrl(url)) {
      void shell.openExternal(url).catch(() => undefined);
    }

    return { action: 'deny' };
  });

  if (isDevelopment) {
    void window.loadURL('http://localhost:5173');
  } else {
    void window.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow = window;
  return window;
}

void app.whenReady().then(() => {
  try {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
    Menu.setApplicationMenu(null);
    persistentStorage = new PersistentStorage(
      userDataConfiguration.databasePath,
      userDataConfiguration.diagnosticsPath,
    );
    registerStorageHandlers(persistentStorage);
    registerWalletAppHandler();
    registerMamaBoardHandler();
    registerObservabilityHandlers();
    beeMiningUtilitySupervisor = new BeeMiningUtilitySupervisor(() =>
      utilityProcess.fork(
        join(currentDirectory, 'beeMiningUtilityWorker.js'),
        [],
        {
          serviceName: 'Core Miner Bee Mining',
          stdio: 'ignore',
        },
      ),
    );
    registerBeeMiningUtilityHandlers(
      ipcMain,
      beeMiningUtilitySupervisor,
      (sender) => mainWindow?.webContents === sender,
    );
    registerShutdownResultHandler();
    registerSystemPowerHandler(ipcMain, {
      isApplicationShuttingDown: () => shutdownCoordinator.isShuttingDown,
    });
    registerWindowControlHandlers(
      ipcMain,
      (sender) => BrowserWindow.fromWebContents(sender),
      () => void shutdownCoordinator.request('window-close'),
    );
    createMainWindow();

    app.on('activate', () => {
      if (
        !shutdownCoordinator.isShuttingDown &&
        BrowserWindow.getAllWindows().length === 0
      ) {
        createMainWindow();
      }
    });
  } catch {
    dialog.showErrorBox(
      'Core Miner data unavailable',
      'Core Miner could not prepare its user data directory. Existing data was not removed. Close other Core Miner instances and try again.',
    );
    app.quit();
  }
});

app.on('before-quit', (event) => {
  requestApplicationQuit(event, shutdownCoordinator);
});

app.on('will-quit', () => {
  beeMiningUtilitySupervisor?.dispose();
  beeMiningUtilitySupervisor = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
