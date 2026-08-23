import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MinerApplication,
  MinerOperatorState,
  RuntimePresentationState,
} from '../application';
import {
  App,
  OPERATOR_BANNER_AUTO_HIDE_MS,
  OperatorBanner,
  scheduleOperatorBannerAutoHide,
} from './App';

const synchronizingEpoch = Object.freeze({
  status: 'synchronizing' as const,
  id: null,
  startBlock: null,
  endBlock: null,
  currentBlock: null,
  progressPercent: 0,
  elapsedMs: null,
  remainingMs: null,
  remainingBlocks: null,
  elapsedLabel: 'Synchronizing',
  remainingLabel: 'Synchronizing',
  startedAt: null,
  expectedEndAt: null,
  expectedEndLabel: 'Synchronizing',
});

const emptyEpochWindow = Object.freeze({
  id: null,
  startBlock: null,
  endBlock: null,
  progressPercent: null,
  elapsedMs: null,
  remainingMs: null,
  remainingBlocks: null,
  startedAt: null,
  expectedEndAt: null,
});

const idleState: RuntimePresentationState = Object.freeze({
  runtimeStatus: 'idle',
  miningExecution: null,
  schedulerStatus: 'idle',
  settlementStatus: 'idle',
  boundaryStatus: 'idle',
  recoveryStatus: 'idle',
  recoveryIssue: null,
  epochs: Object.freeze({
    miniEpoch: synchronizingEpoch,
    mainEpoch: synchronizingEpoch,
  }),
  health: { uptimeMs: null, lastError: null },
});

const operatorState: MinerOperatorState = Object.freeze({
  configuration: Object.freeze({
    status: 'missing',
    code: 'production-configuration-missing',
    endpointCount: 0,
    appIdConfigured: false,
    maximumSessionDurationMs: 135_000,
  }),
  beeSdk: Object.freeze({ status: 'idle', version: null, failureCode: null }),
  selectedWalletId: null,
  walletReadiness: Object.freeze({
    registered: false,
    onboardingStatus: null,
    connectionReferencePresent: false,
    miningCredentialReferencePresent: false,
  }),
  walletConnection: null,
  runtime: idleState,
  nativeSession: null,
  rewardSynchronization: Object.freeze({
    status: 'idle',
    walletId: null,
    sessionId: null,
    generation: null,
    confirmedRewardCount: 0,
    code: null,
  }),
  tapPacingStatus: 'not-configured',
  canonicalChainState: Object.freeze({
    status: 'not-configured',
    code: 'canonical-chain-state-provider-not-configured',
    confidence: 'none',
    lastFailureCode: null,
    currentBlock: null,
    miniEpochStart: null,
    miniEpochRemainingMs: null,
    miniEpoch: emptyEpochWindow,
    mainEpoch: emptyEpochWindow,
    averageBlockTimeMs: null,
    updatedAt: null,
  }),
  globalMiningUptime: Object.freeze({
    active: false,
    activeStartedAt: null,
    todayMs: 0,
    history: Object.freeze([
      Object.freeze({ date: '2026-08-08', durationMs: 0 }),
      Object.freeze({ date: '2026-08-07', durationMs: 0 }),
      Object.freeze({ date: '2026-08-06', durationMs: 0 }),
    ]),
    measuredAt: 0,
  }),
  timedMining: Object.freeze({
    status: 'inactive',
    startedAt: null,
    durationMs: null,
    targetEndAt: null,
    shutdownAfterCompletion: false,
    failureCode: null,
  }),
  mainEpochStart: Object.freeze({
    status: 'inactive',
    armedAt: null,
    baselineMainEpoch: null,
    delayHours: null,
    detectedMainEpoch: null,
    epochDetectedAt: null,
    targetStartAt: null,
    failureCode: null,
  }),
  diagnostics: Object.freeze([]),
  blockers: Object.freeze([]),
});

function createApplication(): MinerApplication {
  return {
    shadowPreflightMining: vi.fn(async (walletId: string = '') =>
      Object.freeze({
        status: 'BLOCKED' as const,
        walletId,
        checks: Object.freeze({
          configurationReady: false,
          endpointsValid: false,
          appIdValid: false,
          walletRegistered: false,
          credentialReferencePresent: false,
          credentialAvailable: false,
          credentialParsed: false,
          walletIdentityMatches: false,
          minerAddressValid: false,
          publicKeyValid: false,
          keyBindingVerified: false,
          validatedIdentityCreated: false,
          newRuntimeConstructible: false,
        }),
        blockers: Object.freeze([
          Object.freeze({
            code: 'CONFIGURATION_NOT_READY' as const,
            check: 'configurationReady' as const,
            message: 'Shadow mining preflight is not configured.',
          }),
        ]),
        checkedAt: '2026-08-12T00:00:00.000Z',
      }),
    ),
    startMining: vi.fn(async () => ({
      accepted: true,
      reasonCode: 'started' as const,
      message: 'Started',
      walletId: null,
    })),
    stopMining: vi.fn(async () => undefined),
    startWalletMining: vi.fn(async (walletId) => ({
      accepted: true,
      reasonCode: 'started' as const,
      message: 'Started',
      walletId,
    })),
    stopWalletMining: vi.fn(async (walletId) => ({
      accepted: true,
      reasonCode: 'stopped' as const,
      message: 'Stopped',
      walletId,
    })),
    startAllMining: vi.fn(async () => ({
      accepted: true,
      reasonCode: 'all-started' as const,
      message: 'Started all',
      results: [],
    })),
    stopAllMining: vi.fn(async () => ({
      accepted: true,
      reasonCode: 'all-stopped' as const,
      message: 'Stopped all',
      results: [],
    })),
    startTimedMining: vi.fn(async () => ({
      accepted: true,
      reasonCode: 'timed-mining-armed' as const,
      message: 'Timed stop armed.',
    })),
    cancelTimedMining: vi.fn(() => ({
      accepted: true,
      reasonCode: 'timed-mining-cancelled' as const,
      message: 'Timed mining cancelled.',
    })),
    armMainEpochMiningStart: vi.fn(() => ({
      accepted: true,
      reasonCode: 'main-epoch-start-armed' as const,
      message: 'Main Epoch start armed.',
    })),
    cancelMainEpochMiningStart: vi.fn(() => ({
      accepted: true,
      reasonCode: 'main-epoch-start-cancelled' as const,
      message: 'Main Epoch start cancelled.',
    })),
    selectWallet: vi.fn(() => ({
      selected: false,
      walletId: null,
      reasonCode: 'cleared' as const,
    })),
    selectedWalletId: () => null,
    preflightMining: vi.fn(async () => {
      throw new Error('Not used by this presentation test.');
    }),
    beginWalletConnection: vi.fn(async (walletId) => walletCommand(walletId)),
    prepareWalletMiningCredential: vi.fn(async (walletId) => walletCommand(walletId)),
    verifyWalletMiningCredentialPropagation: vi.fn(async (walletId) =>
      walletCommand(walletId)),
    disconnectWallet: vi.fn(async (walletId) => walletCommand(walletId)),
    getWalletConnectionState: vi.fn(async (walletId) => walletCommand(walletId)),
    getOperatorState: () => operatorState,
    getCurrentRuntimeState: () => idleState,
    getRuntimeStates: () => new Map(),
    subscribeToRuntimeUpdates: () => () => undefined,
    subscribeToLifecycleEvents: () => () => undefined,
    getDiagnostics: () => [],
    subscribeToDiagnostics: () => () => undefined,
    getSystemMetrics: () => ({
      status: 'unavailable',
      reason: 'test',
      current: null,
      history: { oneHour: [], sixHours: [], twentyFourHours: [] },
    }),
    subscribeToSystemMetrics: () => () => undefined,
    exportDiagnostics: vi.fn(async () => ({
      status: 'unavailable' as const,
      fileName: null,
      message: null,
    })),
    getWallets: () => [],
    getFinancialOverview: () => emptyFinancialOverview(),
    getRecoveryHistory: () => [],
    getBalanceSnapshots: () => [],
    getRewardDeltas: () => [],
    getSessionResults: () => [],
    refreshWalletBalances: vi.fn(async () => undefined),
    registerWallet: vi.fn(async () => undefined),
    removeWallet: vi.fn(async () => false),
    subscribeToWalletUpdates: () => () => undefined,
    dispose: vi.fn(async () => undefined),
  };
}

function emptyFinancialOverview() {
  const asset = Object.freeze({
    rawTotal: null,
    formattedTotal: null,
    walletCount: 0,
    lastUpdatedAt: null,
    status: 'error' as const,
  });
  return Object.freeze({
    nacklTotal: asset,
    nacklLocked: asset,
    nacklAvailable: asset,
    usdc: asset,
    shell: asset,
    dailyRewards: [],
  });
}

function walletCommand(walletId: string) {
  return {
    accepted: false,
    walletId,
    reasonCode: 'wallet-not-found' as const,
    message: 'Wallet not found.',
    connection: null,
    approval: null,
  };
}

function productionUiFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) {
      return productionUiFiles(path);
    }

    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')
      ? [path]
      : [];
  });
}

describe('App', () => {
  it('renders the operator dashboard from the read-only runtime projection', () => {
    const html = renderToStaticMarkup(
      <App application={createApplication()} initialLanguage="en" />,
    );

    expect(html).toContain('Core Miner MSII');
    expect(html).toContain('No wallets configured');
    expect(html).toContain('Start all miners');
    expect(html).not.toContain('Stop all miners');
    expect(html).toContain('Dashboard');
    expect(html).toContain('Settings');
    expect(html).not.toContain('>File<');
    expect(html).not.toContain('>Edit<');
  });

  it.each([
    ['pl', 'Panel główny', 'Uruchom wszystkie minery'],
    ['ru', 'Панель', 'Запустить все майнеры'],
  ] as const)('renders the operator chrome in %s', (language, dashboard, startMining) => {
    const html = renderToStaticMarkup(
      <App application={createApplication()} initialLanguage={language} />,
    );

    expect(html).toContain(dashboard);
    expect(html).toContain(startMining);
    expect(html).not.toContain('Network latency');
  });

  it('keeps every production UI module outside the Core import boundary', () => {
    const uiDirectory = fileURLToPath(new URL('.', import.meta.url));

    for (const file of productionUiFiles(uiDirectory)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(
        /from ['"][^'"]*\/(?:core|shared|storage|services)(?:\/|['"])/,
      );
      expect(source, file).not.toMatch(
        /new (?:MinerEngine|SessionManager|TapScheduler|SettlementManager|BoundaryManager|RecoveryManager|WalletRegistry|RewardLedger)/,
      );
      expect(source, file).not.toContain('VITE_MINER_CORE_BEE_');
    }
  });
});

describe('operator banner auto-hide', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders a new banner immediately', () => {
    const html = renderToStaticMarkup(
      <OperatorBanner message="Mining start is already requested for this wallet." />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Mining start is already requested for this wallet.');
  });

  it('keeps the banner before 60 seconds and hides it at 60 seconds', () => {
    vi.useFakeTimers();
    const hide = vi.fn();
    scheduleOperatorBannerAutoHide(hide);

    vi.advanceTimersByTime(OPERATOR_BANNER_AUTO_HIDE_MS - 1);
    expect(hide).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledOnce();
  });

  it('cancels the previous timer and gives a new banner a full 60 seconds', () => {
    vi.useFakeTimers();
    const hideFirst = vi.fn();
    const hideSecond = vi.fn();
    const cancelFirst = scheduleOperatorBannerAutoHide(hideFirst);

    vi.advanceTimersByTime(30_000);
    cancelFirst();
    scheduleOperatorBannerAutoHide(hideSecond);
    vi.advanceTimersByTime(30_000);

    expect(hideFirst).not.toHaveBeenCalled();
    expect(hideSecond).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(hideSecond).toHaveBeenCalledOnce();
  });

  it('cleanup cancels the pending timeout and uses no interval', () => {
    vi.useFakeTimers();
    const hide = vi.fn();
    const clearTimeout = vi.spyOn(globalThis, 'clearTimeout');
    const cleanup = scheduleOperatorBannerAutoHide(hide);

    cleanup();
    vi.advanceTimersByTime(OPERATOR_BANNER_AUTO_HIDE_MS);

    expect(clearTimeout).toHaveBeenCalledOnce();
    expect(hide).not.toHaveBeenCalled();
    const source = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');
    expect(source).not.toContain('setInterval');
  });
});
