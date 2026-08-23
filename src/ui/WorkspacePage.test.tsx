import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RuntimePresentationState } from '../application';
import { WorkspacePage } from './WorkspacePage';
import { SidebarEpochProgress } from './components/SidebarEpochProgress';

const runningState: RuntimePresentationState = {
  runtimeStatus: 'running',
  miningExecution: {
    sessionId: 'session-4',
    generation: 4,
    status: 'running',
    sessionProgressPercent: (18 / 70) * 100,
    tapProgress: {
      completedTapCount: 18,
      targetTapCount: 70,
      remainingTapCount: 52,
    },
    approximateIntervalMs: 3_500,
    jitterEnabled: true,
    lastExecutionId: 'tap-18',
  },
  schedulerStatus: 'running',
  settlementStatus: 'completed',
  boundaryStatus: 'completed',
  recoveryStatus: 'idle',
  recoveryIssue: null,
  epochs: {
    miniEpoch: {
      status: 'live',
      id: '12000',
      startBlock: '12000',
      endBlock: '13000',
      currentBlock: '12400',
      progressPercent: 40,
      elapsedMs: 132_000,
      remainingMs: 198_000,
      remainingBlocks: 600,
      elapsedLabel: '2m 12s',
      remainingLabel: '3m 18s',
      startedAt: '2026-08-05T12:00:00.000Z',
      expectedEndAt: '2026-08-05T12:05:30.000Z',
      expectedEndLabel: '5 Aug 2026, 12:05:30',
    },
    mainEpoch: {
      status: 'live',
      id: '0',
      startBlock: '0',
      endBlock: '262000',
      currentBlock: '12400',
      progressPercent: 4.73,
      elapsedMs: 4_092_000,
      remainingMs: 82_368_000,
      remainingBlocks: 249_600,
      elapsedLabel: '1h 8m 12s',
      remainingLabel: '22h 52m 48s',
      startedAt: '2026-08-05T10:51:48.000Z',
      expectedEndAt: '2026-08-06T10:52:48.000Z',
      expectedEndLabel: '6 Aug 2026, 10:52:48',
    },
  },
  health: { uptimeMs: null, lastError: null },
};

const configuration = {
  status: 'missing' as const,
  code: 'production-configuration-missing' as const,
  endpointCount: 0,
  appIdConfigured: false,
  maximumSessionDurationMs: 135_000,
};

const unavailableSystemMetrics = {
  status: 'unavailable' as const,
  reason: 'test-environment',
  current: null,
  history: { oneHour: [], sixHours: [], twentyFourHours: [] },
};

const workspaceObservabilityProps = {
  beeStatus: 'idle',
  systemMetrics: unavailableSystemMetrics,
  onExportDiagnostics: async () => ({
    status: 'unavailable' as const,
    fileName: null,
    message: null,
  }),
  onStartWalletMining: async () => true,
  onStopWalletMining: async () => true,
  globalMiningUptime: Object.freeze({
    active: false,
    activeStartedAt: null,
    todayMs: 0,
    history: Object.freeze([
      Object.freeze({ date: '2026-08-02', durationMs: 0 }),
      Object.freeze({ date: '2026-08-01', durationMs: 0 }),
      Object.freeze({ date: '2026-07-31', durationMs: 0 }),
    ]),
    measuredAt: 0,
  }),
  financialOverview: (() => {
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
  })(),
};

describe('WorkspacePage', () => {
  it.each([
    ['dashboard', 'Total wallets'],
    ['wallets', 'Wallet management'],
    ['health', 'Runtime health'],
    ['settings', 'Application configuration'],
  ] as const)('renders the %s responsibility', (activeView, expectedCopy) => {
    const html = renderToStaticMarkup(
      <WorkspacePage
        {...workspaceObservabilityProps}
        activeView={activeView}
        commandsDisabled={false}
        configuration={configuration}
        diagnostics={[]}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        runtimeState={runningState}
        runtimeStates={new Map()}
        selectedWalletId={null}
        wallets={[]}
      />,
    );

    expect(html).toContain(expectedCopy);
  });

  it('shows unavailable health metrics without inventing values', () => {
    const html = renderToStaticMarkup(
      <WorkspacePage
        {...workspaceObservabilityProps}
        activeView="health"
        commandsDisabled={false}
        configuration={configuration}
        diagnostics={[]}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        runtimeState={runningState}
        runtimeStates={new Map()}
        selectedWalletId={null}
        wallets={[]}
      />,
    );

    expect(html).toContain('Not available');
    expect(html).toContain('CPU usage');
    expect(html).toContain('Memory');
  });

  it('renders Core-provided mini and main epoch presentation data', () => {
    const html = renderToStaticMarkup(
      <SidebarEpochProgress epochs={runningState.epochs} />,
    );

    expect(html).toContain('Mini Epoch');
    expect(html).toContain('Main Epoch');
    expect(html).toContain('3m 18s');
    expect(html).not.toContain('>Epoch<');
    expect(html).not.toContain('>Elapsed<');
    expect(html).not.toContain('>Blocks left<');
    expect(html.match(/role="progressbar"/g)).toHaveLength(2);
    expect(html).toContain('lightweight-progress-blue');
    expect(html).toContain('lightweight-progress-red');
  });

  it('renders real CPU and RAM data on the main dashboard tile', () => {
    const html = renderToStaticMarkup(
      <WorkspacePage
        {...workspaceObservabilityProps}
        activeView="dashboard"
        beeStatus="ready"
        commandsDisabled={false}
        configuration={configuration}
        diagnostics={[]}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        runtimeState={runningState}
        runtimeStates={new Map()}
        selectedWalletId={null}
        systemMetrics={{
          status: 'available',
          reason: null,
          current: {
            timestamp: '2026-08-06T10:00:00.000Z',
            cpuPercent: 12.5,
            memoryBytes: 256 * 1_024 * 1_024,
            uptimeMs: 60_000,
            processCount: 2,
            processes: [],
          },
          history: { oneHour: [], sixHours: [], twentyFourHours: [] },
        }}
        wallets={[]}
      />,
    );

    expect(html).toContain('CPU and memory');
    expect(html).toContain('CPU 12.5%');
    expect(html).toContain('RAM 256.0 MB');
    expect(html.match(/metric-card-prominent-value/g)).toHaveLength(2);
  });

  it('keeps aggregated wallet balances out of the dashboard after moving them to the sidebar', () => {
    const asset = (
      rawTotal: string,
      formattedTotal: string,
    ) => ({
      rawTotal,
      formattedTotal,
      walletCount: 2,
      lastUpdatedAt: '2026-08-06T12:00:00.000Z',
      status: 'fresh' as const,
    });
    const html = renderToStaticMarkup(
      <WorkspacePage
        {...workspaceObservabilityProps}
        activeView="dashboard"
        commandsDisabled={false}
        configuration={configuration}
        diagnostics={[]}
        financialOverview={{
          nacklTotal: {
            ...asset('24690000000', '24.69'),
            status: 'partial',
          },
          nacklLocked: asset('23456000000', '23.456'),
          nacklAvailable: asset('1234000000', '1.234'),
          usdc: asset('4567340000', '4567.34'),
          shell: asset('987654000000', '987.654'),
          dailyRewards: [
            { date: '2026-08-06', amountRaw: '234500000000', rewardCount: 7 },
            { date: '2026-08-05', amountRaw: '198200000000', rewardCount: 6 },
            { date: '2026-08-04', amountRaw: '176800000000', rewardCount: 5 },
            { date: '2026-08-03', amountRaw: '154300000000', rewardCount: 4 },
          ],
        }}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        runtimeState={runningState}
        runtimeStates={new Map()}
        selectedWalletId={null}
        wallets={[]}
      />,
    );

    expect(html).not.toContain('NACKL locked');
    expect(html).not.toContain('NACKL available');
    expect(html).not.toContain('Total NACKL');
    expect(html).not.toContain('Partial data');
    expect(html).not.toContain('USDC');
    expect(html).not.toContain('SHELL');
    expect(html).not.toContain('data-token=');
    expect(html).not.toContain('>LOCKED<');
    expect(html).not.toContain('>AVAILABLE<');
    expect(html).not.toContain('>ECC<');
    expect(html).not.toContain('>◈<');
    expect(html).not.toContain('23.46');
    expect(html).not.toContain('4567.34');
    expect(html).not.toContain('2 wallets');
    expect(html).not.toContain('fresh');
    expect(html).toContain('Daily rewards');
    expect(html).toContain('Up time today');
    expect(html).toContain('234.5 NACKL');
    expect(html).toContain('198.2 NACKL');
    expect(html).toContain('04.08');
    expect(html).toContain('03.08');
    expect(html).not.toContain('06.08');
    expect(html).not.toContain('Mining progress');
    expect(html).not.toContain('Rewards recorded');
  });
});
