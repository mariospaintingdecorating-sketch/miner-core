import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WalletPresentation } from '../../application';
import { WalletCard } from './WalletCard';

const firstWallet: WalletPresentation = {
  id: 'wallet-alpha',
  name: 'illiil',
  status: 'running',
  walletAddress: '0:wallet-a',
  mamaBoardLevel: 25,
  connectionStatus: 'connected',
  connection: {
    onboardingStatus: 'ready',
    phase: 'connected',
    availability: 'available',
    approvalPending: false,
    approval: null,
    connectionStateStored: true,
    miningCredentialStored: true,
    miningReady: true,
    operationPending: false,
    operationStep: null,
    lastFailureCode: null,
  },
  sessionId: 'session-alpha',
  generation: 3,
  runtimeStatus: 'running',
  schedulerStatus: 'running',
  settlementStatus: 'idle',
  progressPercent: 35,
  completedTaps: 24,
  tapTarget: 70,
  latestReward: {
    id: 'reward-alpha',
    amountLabel: '12 ALPHA',
    recordedAtLabel: 'Current session',
    sessionId: 'session-alpha',
    generation: 3,
  },
  balance: {
    walletId: 'wallet-alpha',
    values: {
      nacklLockedRaw: '23450000000',
      nacklAvailableRaw: '4567340000000',
      usdcRaw: '12463000',
      shellRaw: '987654000000',
    },
    synchronizedAt: '2026-08-06T10:00:00.000Z',
    status: 'fresh',
    errorCode: null,
  },
  recovery: {
    walletId: 'wallet-alpha',
    state: 'healthy',
    attempt: 0,
    maximumAttempts: 5,
    issueCode: null,
    issueMessage: null,
    nextAttemptAt: null,
    updatedAt: '2026-08-06T10:00:00.000Z',
  },
  latestMiningReward: null,
  miningRewards: Array.from({ length: 6 }, (_, index) => ({
    id: `mining-reward-${index + 1}`,
    walletId: 'wallet-alpha',
    amountRaw: `${index + 1}000000000`,
    detectedAt: `2026-08-0${index + 1}T10:00:00.000Z`,
    sessionId: `session-${index + 1}`,
    generation: index + 1,
    lockedNacklBeforeRaw: '0',
    lockedNacklAfterRaw: `${index + 1}000000000`,
    observedInCurrentRun: true,
    source: 'settlement' as const,
  })),
};

const secondWallet: WalletPresentation = {
  id: 'wallet-beta',
  name: 'Beta',
  status: 'warning',
  walletAddress: null,
  mamaBoardLevel: null,
  connectionStatus: 'disconnected',
  connection: {
    onboardingStatus: 'disconnected',
    phase: 'disconnected',
    availability: 'available',
    approvalPending: false,
    approval: null,
    connectionStateStored: false,
    miningCredentialStored: false,
    miningReady: false,
    operationPending: false,
    operationStep: null,
    lastFailureCode: null,
  },
  sessionId: 'session-beta',
  generation: 8,
  runtimeStatus: 'waiting',
  schedulerStatus: 'stopped',
  settlementStatus: 'completed',
  progressPercent: 80,
  completedTaps: 56,
  tapTarget: 70,
  latestReward: {
    id: 'reward-beta',
    amountLabel: '4 BETA',
    recordedAtLabel: 'Previous session',
    sessionId: 'session-beta',
    generation: 8,
  },
  balance: null,
  recovery: {
    walletId: 'wallet-beta',
    state: 'healthy',
    attempt: 0,
    maximumAttempts: 5,
    issueCode: null,
    issueMessage: null,
    nextAttemptAt: null,
    updatedAt: '2026-08-06T10:00:00.000Z',
  },
  latestMiningReward: null,
  miningRewards: [],
};

describe('WalletCard', () => {
  it('shows four wallet-scoped rewards without technical session or secondary balance fields', () => {
    const firstMarkup = renderToStaticMarkup(<WalletCard wallet={firstWallet} />);
    const secondMarkup = renderToStaticMarkup(<WalletCard wallet={secondWallet} />);
    const latestRewardTime = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date('2026-08-06T10:00:00.000Z'));

    expect(firstMarkup).toContain('illiil');
    expect(firstMarkup).toContain('Mining');
    expect(firstMarkup).toContain('wallet-card-running');
    expect(firstMarkup).toContain('wallet-card-compact');
    expect(firstMarkup).toContain('status-badge-success');
    expect(firstMarkup).not.toContain('wallet-alpha');
    expect(firstMarkup).toContain('MamaBoard Level 25');
    expect(firstMarkup).toContain('24/70');
    expect(firstMarkup).not.toContain('35%');
    expect(firstMarkup).toContain('role="progressbar"');
    expect(firstMarkup).toContain('wallet-card-progress-fill');
    expect(firstMarkup).toContain('transform:scaleX(0.34285714285714286)');
    expect(firstMarkup).not.toContain('lightweight-progress-mixed');
    expect(firstMarkup).toContain('aria-valuenow="24"');
    expect(firstMarkup).toContain('aria-valuemax="70"');
    expect(firstMarkup).not.toContain('Confirmed taps');
    expect(firstMarkup).not.toContain('<dt>Connection</dt>');
    expect(firstMarkup).not.toContain('24 / 70 taps');
    expect(firstMarkup).not.toContain('Recent rewards');
    expect(firstMarkup).toContain('wallet-reward-controls');
    expect(firstMarkup).toContain('wallet-runtime-actions');
    expect(firstMarkup).toContain(latestRewardTime);
    expect(firstMarkup).toContain('+6 NACKL');
    expect(firstMarkup).not.toContain('06.08');
    expect(firstMarkup).not.toContain('<dt>Session</dt>');
    expect(firstMarkup).not.toContain('Last session');
    expect(firstMarkup).not.toContain('Tap result');
    expect(firstMarkup.match(/data-token="nackl"/g)).toHaveLength(2);
    expect(firstMarkup).not.toContain('data-token="usdc"');
    expect(firstMarkup).not.toContain('data-token="shell"');
    expect(firstMarkup).toContain('>LOCKED<');
    expect(firstMarkup).toContain('>AVAILABLE<');
    expect(firstMarkup).toContain('23.45');
    expect(firstMarkup).toContain('4567.34');
    expect(firstMarkup).not.toContain('12.46');
    expect(firstMarkup).not.toContain('987.65');

    expect(secondMarkup).toContain('Beta');
    expect(secondMarkup).toContain('Waiting');
    expect(secondMarkup).toContain('wallet-card-warning');
    expect(secondMarkup).not.toContain('wallet-card-running');
    expect(secondMarkup).not.toContain('wallet-beta');
    expect(secondMarkup).toContain('MamaBoard Level Unavailable');
    expect(secondMarkup).toContain('56/70');
    expect(secondMarkup).not.toContain('80%');
    expect(secondMarkup).toContain('role="progressbar"');
    expect(secondMarkup).toContain('aria-valuenow="56"');
    expect(secondMarkup).not.toContain('>0<');
    expect(secondMarkup).toContain('No mining rewards recorded');
    expect(secondMarkup).not.toContain('+6 NACKL');
    expect(firstMarkup.match(/<li>/g)).toHaveLength(4);
  });

  it('keeps recovery in the primary status without a separate recovery tile', () => {
    const healthyMarkup = renderToStaticMarkup(<WalletCard wallet={firstWallet} />);
    const recoveringMarkup = renderToStaticMarkup(
      <WalletCard
        wallet={{
          ...firstWallet,
          recovery: {
            ...firstWallet.recovery,
            state: 'recovering',
            attempt: 2,
          },
        }}
      />,
    );
    const failedMarkup = renderToStaticMarkup(
      <WalletCard
        wallet={{
          ...firstWallet,
          recovery: {
            ...firstWallet.recovery,
            state: 'recovery-failed',
            issueMessage: 'Native worker unavailable',
          },
        }}
      />,
    );

    expect(healthyMarkup).not.toContain('wallet-recovery-summary');
    expect(healthyMarkup).not.toContain('No recovery');
    expect(recoveringMarkup).toContain('Recovering');
    expect(recoveringMarkup).not.toContain('Attempt 2 of 5');
    expect(failedMarkup).toContain('Error');
    expect(failedMarkup).not.toContain('Native worker unavailable');
  });

  it('offers an immediate setup entry point without performing wallet work', () => {
    const localMarkup = renderToStaticMarkup(
      <WalletCard
        managementActions
        onContinueOnboarding={() => undefined}
        wallet={{ ...secondWallet, sessionId: null }}
      />,
    );
    const readyMarkup = renderToStaticMarkup(
      <WalletCard
        managementActions
        onContinueOnboarding={() => undefined}
        wallet={firstWallet}
      />,
    );

    expect(localMarkup).toContain('Continue setup');
    expect(readyMarkup).toContain('View wallet readiness');
    expect(localMarkup).not.toContain('private-connection');
    expect(localMarkup).not.toContain('private-credential');
  });

  it('derives the wallet mining action and status from the runtime projection', () => {
    const readyWallet: WalletPresentation = {
      ...firstWallet,
      status: 'idle',
      sessionId: null,
      generation: null,
      runtimeStatus: 'idle',
      schedulerStatus: 'idle',
      progressPercent: null,
      completedTaps: null,
      tapTarget: null,
    };
    const readyMarkup = renderToStaticMarkup(
      <WalletCard onStart={() => undefined} wallet={readyWallet} />,
    );
    const runningMarkup = renderToStaticMarkup(
      <WalletCard onStop={() => undefined} wallet={firstWallet} />,
    );
    const settlingMarkup = renderToStaticMarkup(
      <WalletCard
        onStop={() => undefined}
        wallet={{
          ...firstWallet,
          runtimeStatus: 'stopping',
          settlementStatus: 'pending',
        }}
      />,
    );

    expect(readyMarkup).toContain('Ready for mining');
    expect(readyMarkup).toContain('START');
    expect(readyMarkup).not.toContain('STOP');
    expect(runningMarkup).toContain('Mining');
    expect(runningMarkup).toContain('STOP');
    expect(settlingMarkup).toContain('Settling');
    expect(settlingMarkup).toContain('STOP');
    expect(readyMarkup).not.toContain('wallet-alpha');
  });
});
