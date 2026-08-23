import { contextBridge, ipcRenderer } from 'electron';

export interface MinerCoreAppInfo {
  readonly platform: NodeJS.Platform;
  readonly versions: {
    readonly chrome: string;
    readonly electron: string;
    readonly node: string;
  };
  readonly walletApp: {
    open(
      walletId: string,
      deepLink: string,
    ): Promise<'adb_success' | 'fallback_required'>;
  };
  readonly mamaBoard: {
    readOnChain(endpoint: string, minerAddress: string): Promise<number | null>;
  };
  readonly observability: {
    systemMetrics(): Promise<unknown>;
    exportDiagnostics(bundle: unknown): Promise<unknown>;
  };
  readonly beeMining: {
    request(request: unknown): Promise<unknown>;
    onCallback(listener: (message: unknown) => void): () => void;
  };
  readonly lifecycle: {
    onShutdownRequested(listener: () => void | Promise<void>): () => void;
  };
  readonly system: {
    shutdownComputer(): Promise<
      'requested' | 'unsupported' | 'failed' | 'busy'
    >;
  };
  readonly windowControls: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(listener: (maximized: boolean) => void): () => void;
  };
}

// Sandboxed Electron preloads cannot import local modules. Keep this narrow
// channel list aligned with storageChannels.ts and expose functions, never
// ipcRenderer itself.
const storageChannels = Object.freeze({
  listWallets: 'storage:wallets:list',
  saveWallet: 'storage:wallets:save',
  removeWallet: 'storage:wallets:remove',
  appendReward: 'storage:rewards:append',
  rewardsForWallet: 'storage:rewards:wallet',
  appendWalletBalanceSnapshot: 'storage:analytics:balance:append',
  walletBalanceSnapshots: 'storage:analytics:balance:wallet',
  saveWalletSessionResult: 'storage:analytics:session:save',
  walletSessionResults: 'storage:analytics:session:wallet',
  appendDiagnostic: 'storage:diagnostics:append',
  recentDiagnostics: 'storage:diagnostics:recent',
  saveSecureValue: 'storage:secure:save',
  hasSecureValue: 'storage:secure:has',
  loadSecureValue: 'storage:secure:load',
  removeSecureValue: 'storage:secure:remove',
  globalMiningUptimeSnapshot: 'storage:uptime:snapshot',
  startGlobalMiningUptime: 'storage:uptime:start',
  heartbeatGlobalMiningUptime: 'storage:uptime:heartbeat',
  stopGlobalMiningUptime: 'storage:uptime:stop',
  loadMainEpochStartSchedule: 'storage:automation:main-epoch-start:load',
  saveMainEpochStartSchedule: 'storage:automation:main-epoch-start:save',
});

const walletAppOpenChannel = 'walletApp:open';
const mamaBoardReadChannel = 'mamaBoard:readOnChain';
const systemMetricsChannel = 'observability:system-metrics';
const diagnosticsExportChannel = 'observability:export-diagnostics';
const beeMiningUtilityChannels = Object.freeze({
  request: 'bee-mining-utility:request',
  callback: 'bee-mining-utility:callback',
});
const systemShutdownComputerChannel = 'system:shutdown-computer';
const shutdownChannels = Object.freeze({
  request: 'application:shutdown-requested',
  complete: 'application:shutdown-completed',
});
const windowControlChannels = Object.freeze({
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  close: 'window:close',
  isMaximized: 'window:is-maximized',
  maximizedChanged: 'window:maximized-changed',
});

let shutdownListener: (() => void | Promise<void>) | null = null;
let shutdownRequestPending = false;
let shutdownRequestDelivered = false;

function deliverShutdownRequest(): void {
  if (shutdownRequestDelivered) return;
  if (!shutdownListener) {
    shutdownRequestPending = true;
    return;
  }

  shutdownRequestDelivered = true;
  shutdownRequestPending = false;
  const listener = shutdownListener;
  shutdownListener = null;
  void Promise.resolve()
    .then(listener)
    .then(
      () => ipcRenderer.send(shutdownChannels.complete, { status: 'completed' }),
      () => ipcRenderer.send(shutdownChannels.complete, { status: 'failed' }),
    );
}

ipcRenderer.once(shutdownChannels.request, deliverShutdownRequest);

const appInfo: MinerCoreAppInfo = Object.freeze({
  platform: process.platform,
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  }),
  walletApp: Object.freeze({
    open: (walletId: string, deepLink: string) =>
      ipcRenderer.invoke(walletAppOpenChannel, walletId, deepLink),
  }),
  mamaBoard: Object.freeze({
    readOnChain: (endpoint: string, minerAddress: string) =>
      ipcRenderer.invoke(mamaBoardReadChannel, endpoint, minerAddress),
  }),
  observability: Object.freeze({
    systemMetrics: () => ipcRenderer.invoke(systemMetricsChannel),
    exportDiagnostics: (bundle: unknown) =>
      ipcRenderer.invoke(diagnosticsExportChannel, bundle),
  }),
  beeMining: Object.freeze({
    request: (request: unknown) =>
      ipcRenderer.invoke(beeMiningUtilityChannels.request, request),
    onCallback: (listener: (message: unknown) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, message: unknown) => {
        listener(message);
      };
      ipcRenderer.on(beeMiningUtilityChannels.callback, receive);
      return () => ipcRenderer.removeListener(
        beeMiningUtilityChannels.callback,
        receive,
      );
    },
  }),
  lifecycle: Object.freeze({
    onShutdownRequested: (listener: () => void | Promise<void>) => {
      shutdownListener = listener;
      if (shutdownRequestPending) queueMicrotask(deliverShutdownRequest);

      return () => {
        if (shutdownListener === listener) shutdownListener = null;
      };
    },
  }),
  system: Object.freeze({
    shutdownComputer: () => ipcRenderer.invoke(systemShutdownComputerChannel),
  }),
  windowControls: Object.freeze({
    minimize: () => ipcRenderer.invoke(windowControlChannels.minimize),
    toggleMaximize: () =>
      ipcRenderer.invoke(windowControlChannels.toggleMaximize),
    close: () => ipcRenderer.invoke(windowControlChannels.close),
    isMaximized: () => ipcRenderer.invoke(windowControlChannels.isMaximized),
    onMaximizedChanged: (listener: (maximized: boolean) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, maximized: unknown) => {
        if (typeof maximized === 'boolean') listener(maximized);
      };
      ipcRenderer.on(windowControlChannels.maximizedChanged, receive);
      return () => {
        ipcRenderer.removeListener(windowControlChannels.maximizedChanged, receive);
      };
    },
  }),
});

contextBridge.exposeInMainWorld('minerCoreApp', appInfo);

const storageBridge = Object.freeze({
  listWallets: () => ipcRenderer.invoke(storageChannels.listWallets),
  saveWallet: (wallet: unknown) =>
    ipcRenderer.invoke(storageChannels.saveWallet, wallet),
  removeWallet: (walletId: string) =>
    ipcRenderer.invoke(storageChannels.removeWallet, walletId),
  appendReward: (reward: unknown) =>
    ipcRenderer.invoke(storageChannels.appendReward, reward),
  rewardsForWallet: (walletId: string, limit?: number) =>
    ipcRenderer.invoke(storageChannels.rewardsForWallet, walletId, limit),
  appendWalletBalanceSnapshot: (snapshot: unknown) =>
    ipcRenderer.invoke(storageChannels.appendWalletBalanceSnapshot, snapshot),
  walletBalanceSnapshots: (walletId: string, limit?: number) =>
    ipcRenderer.invoke(storageChannels.walletBalanceSnapshots, walletId, limit),
  saveWalletSessionResult: (result: unknown) =>
    ipcRenderer.invoke(storageChannels.saveWalletSessionResult, result),
  walletSessionResults: (walletId: string, limit?: number) =>
    ipcRenderer.invoke(storageChannels.walletSessionResults, walletId, limit),
  appendDiagnostic: (diagnostic: unknown) =>
    ipcRenderer.invoke(storageChannels.appendDiagnostic, diagnostic),
  recentDiagnostics: (limit: number) =>
    ipcRenderer.invoke(storageChannels.recentDiagnostics, limit),
  saveSecureValue: (reference: string, value: string) =>
    ipcRenderer.invoke(storageChannels.saveSecureValue, reference, value),
  hasSecureValue: (reference: string) =>
    ipcRenderer.invoke(storageChannels.hasSecureValue, reference),
  loadSecureValue: (reference: string) =>
    ipcRenderer.invoke(storageChannels.loadSecureValue, reference),
  removeSecureValue: (reference: string) =>
    ipcRenderer.invoke(storageChannels.removeSecureValue, reference),
  globalMiningUptimeSnapshot: (at: number) =>
    ipcRenderer.invoke(storageChannels.globalMiningUptimeSnapshot, at),
  startGlobalMiningUptime: (startedAt: number) =>
    ipcRenderer.invoke(storageChannels.startGlobalMiningUptime, startedAt),
  heartbeatGlobalMiningUptime: (activeAt: number) =>
    ipcRenderer.invoke(storageChannels.heartbeatGlobalMiningUptime, activeAt),
  stopGlobalMiningUptime: (endedAt: number) =>
    ipcRenderer.invoke(storageChannels.stopGlobalMiningUptime, endedAt),
  loadMainEpochStartSchedule: () =>
    ipcRenderer.invoke(storageChannels.loadMainEpochStartSchedule),
  saveMainEpochStartSchedule: (snapshot: unknown) =>
    ipcRenderer.invoke(storageChannels.saveMainEpochStartSchedule, snapshot),
});

contextBridge.exposeInMainWorld('minerCoreStorage', storageBridge);
