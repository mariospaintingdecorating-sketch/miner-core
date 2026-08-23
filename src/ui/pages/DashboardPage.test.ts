import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UiLanguageProvider } from '../i18n';
import {
  formatMiningUptime,
  GlobalUptimeCard,
} from './DashboardPage';
import {
  formatCountdown,
  MainEpochStartControls,
  schedulePresentationCountdown,
  TimedMiningControls,
} from '../components/SidebarAutomationControls';

describe('Dashboard uptime presentation', () => {
  it('formats global uptime without seconds', () => {
    expect(formatMiningUptime(0)).toBe('0 min');
    expect(formatMiningUptime(24 * 60_000 + 59_000)).toBe('24 min');
    expect(formatMiningUptime(65 * 60_000)).toBe('1 h 05 min');
    expect(formatMiningUptime((7 * 60 + 42) * 60_000)).toBe('7 h 42 min');
  });

  it('renders only the three previous local days below today uptime', () => {
    const html = renderToStaticMarkup(
      createElement(
        UiLanguageProvider,
        {
          initialLanguage: 'en',
          children: createElement(GlobalUptimeCard, {
            uptime: {
              active: true,
              activeStartedAt: new Date(2026, 7, 9, 8).getTime(),
              todayMs: (6 * 60 + 42) * 60_000,
              history: [
                { date: '2026-08-08', durationMs: (7 * 60 + 18) * 60_000 },
                { date: '2026-08-07', durationMs: 0 },
                { date: '2026-08-06', durationMs: (5 * 60 + 37) * 60_000 },
              ],
              measuredAt: new Date(2026, 7, 9, 14, 42).getTime(),
            },
          }),
        },
      ),
    );

    expect(html).toContain('Up time today');
    expect(html).toContain('6 h 42 min');
    expect(html).toContain('08.08');
    expect(html).toContain('7 h 18 min');
    expect(html).toContain('07.08');
    expect(html).toContain('0 min');
    expect(html).toContain('06.08');
    expect(html).toContain('5 h 37 min');
    expect(html.match(/<li>/g)).toHaveLength(3);
  });

  it('renders 1-16 timed mining hours and 1-24 Main Epoch delay hours', () => {
    const timed = renderToStaticMarkup(
      createElement(UiLanguageProvider, {
        initialLanguage: 'en',
        children: createElement(TimedMiningControls, {
          commandsDisabled: false,
          onCancel: async () => true,
          onStart: async () => true,
          state: {
            status: 'inactive',
            startedAt: null,
            durationMs: null,
            targetEndAt: null,
            shutdownAfterCompletion: false,
            failureCode: null,
          },
        }),
      }),
    );
    const mainEpoch = renderToStaticMarkup(
      createElement(UiLanguageProvider, {
        initialLanguage: 'en',
        children: createElement(MainEpochStartControls, {
          commandsDisabled: false,
          onArm: async () => true,
          onCancel: async () => true,
          state: {
            status: 'inactive',
            armedAt: null,
            baselineMainEpoch: null,
            delayHours: null,
            detectedMainEpoch: null,
            epochDetectedAt: null,
            targetStartAt: null,
            failureCode: null,
          },
        }),
      }),
    );

    expect(timed.match(/<option/g)).toHaveLength(16);
    expect(timed).toContain('Shut down computer');
    expect(mainEpoch.match(/<option/g)).toHaveLength(24);
    expect(mainEpoch).toContain('Mining start');
  });

  it('formats the live countdown and cleans the presentation interval', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const cleanup = schedulePresentationCountdown(tick);

    vi.advanceTimersByTime(2_000);
    expect(tick).toHaveBeenCalledTimes(2);
    cleanup();
    vi.advanceTimersByTime(2_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(formatCountdown(3_661_000)).toBe('01:01:01');
    vi.useRealTimers();
  });
});
