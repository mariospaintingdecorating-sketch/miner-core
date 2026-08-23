import { useEffect, useState } from 'react';
import type {
  MainEpochStartSnapshot,
  TimedMiningSnapshot,
} from '../../application';
import { useUiLanguage } from '../i18n';

export const PRESENTATION_COUNTDOWN_INTERVAL_MS = 1_000;

export interface SidebarAutomationControlsProps {
  readonly commandsDisabled: boolean;
  readonly timedMining: Readonly<TimedMiningSnapshot>;
  readonly mainEpochStart: Readonly<MainEpochStartSnapshot>;
  readonly onStartTimedMining: (
    hours: number,
    shutdown: boolean,
  ) => Promise<boolean>;
  readonly onCancelTimedMining: () => Promise<boolean>;
  readonly onArmMainEpochStart: (hours: number) => Promise<boolean>;
  readonly onCancelMainEpochStart: () => Promise<boolean>;
}

export function SidebarAutomationControls({
  commandsDisabled,
  timedMining,
  mainEpochStart,
  onStartTimedMining,
  onCancelTimedMining,
  onArmMainEpochStart,
  onCancelMainEpochStart,
}: SidebarAutomationControlsProps) {
  return (
    <section className="sidebar-automation" aria-label="Mining automation">
      <TimedMiningControls
        commandsDisabled={commandsDisabled}
        onCancel={onCancelTimedMining}
        onStart={onStartTimedMining}
        state={timedMining}
      />
      <MainEpochStartControls
        commandsDisabled={commandsDisabled}
        onArm={onArmMainEpochStart}
        onCancel={onCancelMainEpochStart}
        state={mainEpochStart}
      />
    </section>
  );
}

export function TimedMiningControls({
  commandsDisabled,
  onCancel,
  onStart,
  state,
}: {
  readonly commandsDisabled: boolean;
  readonly onCancel: () => Promise<boolean>;
  readonly onStart: (hours: number, shutdown: boolean) => Promise<boolean>;
  readonly state: Readonly<TimedMiningSnapshot>;
}) {
  const { t } = useUiLanguage();
  const [hours, setHours] = useState(1);
  const [shutdown, setShutdown] = useState(false);
  const now = usePresentationClock(
    state.status === 'running' ? state.targetEndAt : null,
  );
  const active = state.status === 'running' || state.status === 'stopping';

  return (
    <div className="sidebar-automation-block">
      {active ? (
        <div className="sidebar-automation-status">
          <strong>{state.status === 'stopping'
            ? t('Finishing mining safely')
            : t('Remaining: {time}', {
                time: formatCountdown((state.targetEndAt ?? now) - now),
              })}</strong>
          {state.shutdownAfterCompletion ? <span>{t('Shut down computer')}</span> : null}
          <button
            className="button button-secondary"
            disabled={commandsDisabled || state.status === 'stopping'}
            onClick={() => void onCancel()}
            type="button"
          >
            {t('Cancel timer')}
          </button>
        </div>
      ) : (
        <>
          <div className="sidebar-automation-row">
            <button
              className="button button-secondary button-stop-action"
              disabled={commandsDisabled}
              onClick={() => void onStart(hours, shutdown)}
              type="button"
            >
              {t('Timed mining off')}
            </button>
            <select
              aria-label={t('Duration')}
              disabled={commandsDisabled}
              onChange={(event) => setHours(Number(event.target.value))}
              value={hours}
            >
              {hourOptions(16).map((hour) => (
                <option key={hour} value={hour}>{hour} h</option>
              ))}
            </select>
            <label className="sidebar-shutdown-option">
              <input
                checked={shutdown}
                disabled={commandsDisabled}
                onChange={(event) => setShutdown(event.target.checked)}
                type="checkbox"
              />
              <span>{t('Shut down computer')}</span>
            </label>
          </div>
          {state.status === 'failed' ? (
            <p className="automation-error">
              {t('Automatic shutdown was cancelled because mining did not finish safely.')}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function MainEpochStartControls({
  commandsDisabled,
  onArm,
  onCancel,
  state,
}: {
  readonly commandsDisabled: boolean;
  readonly onArm: (hours: number) => Promise<boolean>;
  readonly onCancel: () => Promise<boolean>;
  readonly state: Readonly<MainEpochStartSnapshot>;
}) {
  const { t } = useUiLanguage();
  const [delayHours, setDelayHours] = useState(1);
  const now = usePresentationClock(
    state.status === 'waiting-for-delay' ? state.targetStartAt : null,
  );
  const active = state.status === 'waiting-for-main-epoch' ||
    state.status === 'waiting-for-delay' || state.status === 'starting';

  return (
    <div className="sidebar-automation-block">
      {active ? (
        <div className="sidebar-automation-status">
          <strong>{state.status === 'waiting-for-main-epoch'
            ? t('Waiting for a new Main Epoch')
            : state.status === 'starting'
              ? t('Starting all miners')
              : t('Starts in: {time}', {
                  time: formatCountdown((state.targetStartAt ?? now) - now),
                })}</strong>
          <button
            className="button button-secondary"
            disabled={commandsDisabled || state.status === 'starting'}
            onClick={() => void onCancel()}
            type="button"
          >
            {t('Cancel')}
          </button>
        </div>
      ) : (
        <div className="sidebar-automation-row sidebar-start-automation-row">
          <button
            className="button button-primary"
            disabled={commandsDisabled}
            onClick={() => void onArm(delayHours)}
            type="button"
          >
            {t('Mining start')}
          </button>
          <select
            aria-label={t('Delay')}
            disabled={commandsDisabled}
            onChange={(event) => setDelayHours(Number(event.target.value))}
            value={delayHours}
          >
            {hourOptions(24).map((hour) => (
              <option key={hour} value={hour}>{hour} h</option>
            ))}
          </select>
        </div>
      )}
      {state.status === 'failed' ? (
        <p className="automation-error">{t('Mining start failed')}</p>
      ) : null}
    </div>
  );
}

export function schedulePresentationCountdown(onTick: () => void): () => void {
  const interval = globalThis.setInterval(onTick, PRESENTATION_COUNTDOWN_INTERVAL_MS);
  return () => globalThis.clearInterval(interval);
}

function usePresentationClock(targetAt: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (targetAt === null) return;
    return schedulePresentationCountdown(() => setNow(Date.now()));
  }, [targetAt]);
  return now;
}

function hourOptions(maximum: number): readonly number[] {
  return Array.from({ length: maximum }, (_, index) => index + 1);
}

export function formatCountdown(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1_000));
  const hours = String(Math.floor(totalSeconds / 3_600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3_600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}
