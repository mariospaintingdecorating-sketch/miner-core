import { Children, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NAVIGATION_ITEMS } from '../navigation';
import { DesktopLayout } from './DesktopLayout';
import { Navigation } from './Navigation';

interface NavigationButtonProps {
  readonly onClick: () => void;
  readonly 'aria-current'?: string;
}

describe('Navigation', () => {
  it('renders every required desktop section with one active view', () => {
    const html = renderToStaticMarkup(
      <Navigation activeView="health" onNavigate={() => undefined} />,
    );

    expect(NAVIGATION_ITEMS.map((item) => item.label)).toEqual([
      'Dashboard',
      'Wallets',
      'Health',
      'Settings',
    ]);
    expect(html).toContain('aria-current="page"');
    expect(new Set(NAVIGATION_ITEMS.map((item) => item.id)).size).toBe(4);
    expect(NAVIGATION_ITEMS.map((item) => item.id)).not.toContain('mining');
    expect(NAVIGATION_ITEMS.map((item) => item.id)).not.toContain('rewards');
    expect(NAVIGATION_ITEMS.map((item) => item.id)).not.toContain('logs');
    expect(html).not.toContain('Logs');
  });

  it('reports navigation through the selected presentation view', () => {
    const onNavigate = vi.fn();
    const navigation = Navigation({ activeView: 'dashboard', onNavigate });
    const buttons = Children.toArray(navigation.props.children) as ReactElement<NavigationButtonProps>[];

    buttons[2]?.props.onClick();

    expect(onNavigate).toHaveBeenCalledWith('health');
  });

  it('keeps every navigation entry alongside the approved larger logo', () => {
    const html = renderToStaticMarkup(
      <DesktopLayout
        activeView="dashboard"
        commandsDisabled={false}
        globalMiningActive={false}
        epochs={{
          miniEpoch: {
            id: '1000', status: 'live', progressPercent: 50,
            startBlock: '1000', endBlock: '1999', currentBlock: '1500',
            elapsedMs: 165_000, remainingMs: 165_000,
            remainingLabel: '02:45', elapsedLabel: '02:45',
            startedAt: null, expectedEndAt: null,
            expectedEndLabel: '—', remainingBlocks: null,
          },
          mainEpoch: {
            id: '262000', status: 'live', progressPercent: 25,
            startBlock: '262000', endBlock: '523999', currentBlock: '327500',
            elapsedMs: 1_000, remainingMs: 3_000,
            remainingLabel: '3 days', elapsedLabel: '1 day',
            startedAt: null, expectedEndAt: null,
            expectedEndLabel: '—', remainingBlocks: null,
          },
        }}
        financialOverview={{
          nacklTotal: {
            rawTotal: '24690000000',
            formattedTotal: '24.69',
            walletCount: 2,
            lastUpdatedAt: '2026-08-06T12:00:00.000Z',
            status: 'fresh',
          },
          nacklLocked: { rawTotal: '23456000000', formattedTotal: '23.456', walletCount: 2, lastUpdatedAt: null, status: 'fresh' },
          nacklAvailable: { rawTotal: '1234000000', formattedTotal: '1.234', walletCount: 2, lastUpdatedAt: null, status: 'fresh' },
          usdc: { rawTotal: '4567340000', formattedTotal: '4567.34', walletCount: 2, lastUpdatedAt: null, status: 'fresh' },
          shell: { rawTotal: '987654000000', formattedTotal: '987.654', walletCount: 2, lastUpdatedAt: null, status: 'fresh' },
          dailyRewards: [],
        }}
        onNavigate={() => undefined}
        onArmMainEpochStart={async () => true}
        onCancelMainEpochStart={async () => true}
        onCancelTimedMining={async () => true}
        onStartAllMining={async () => true}
        onStopAllMining={async () => true}
        onStartTimedMining={async () => true}
        runtimeStatus="idle"
        startAllDisabled={false}
        stopAllDisabled
        timedMining={{
          status: 'inactive', startedAt: null, durationMs: null,
          targetEndAt: null, shutdownAfterCompletion: false, failureCode: null,
        }}
        mainEpochStart={{
          status: 'inactive', armedAt: null, baselineMainEpoch: null,
          delayHours: null, detectedMainEpoch: null, epochDetectedAt: null,
          targetStartAt: null, failureCode: null,
        }}
      >
        <p>Operator content</p>
      </DesktopLayout>,
    );

    expect(html).toContain('msii-logo-ui.png');
    expect(html).toContain('width="216"');
    expect(html).toContain('Mini Epoch');
    expect(html).toContain('Main Epoch');
    expect(html).toContain('Timed mining off');
    expect(html).toContain('Mining start');
    expect(html).toContain('Total NACKL');
    expect(html).toContain('24.69 NACKL');
    expect(html).toContain('Start all miners');
    expect(html).not.toContain('Stop all miners');
    expect(html).toContain('button button-secondary button-stop-action');
    expect(html.match(/class="sidebar-balance-row /g)).toHaveLength(4);
    expect(html).toContain('NACKL locked');
    expect(html).toContain('NACKL available');
    expect(html).toContain('USDC');
    expect(html).toContain('SHELL');
    expect(html).toContain('23.46');
    expect(html).toContain('4567.34');
    expect(html).not.toContain('data-token=');
    for (const item of NAVIGATION_ITEMS) {
      expect(html).toContain(item.label);
    }
  });
});
