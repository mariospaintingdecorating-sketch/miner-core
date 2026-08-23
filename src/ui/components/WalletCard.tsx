import { memo, useEffect, useRef, useState } from 'react';
import type {
  RuntimePresentationState,
  WalletPresentation,
  WalletRewardDelta,
} from '../../application';
import { formatRawAmount } from '../../application/runtimeAnalytics';
import { type Translate, useUiLanguage } from '../i18n';
import { StatusBadge, type StatusTone } from './StatusBadge';
import { TokenIdentity } from './TokenIdentity';
import {
  isWalletRewardForCurrentRun,
  scheduleRewardAnimationEnd,
  useRewardEffects,
} from '../rewardEffects';
import { trackRewardAnimation } from '../presentationMetrics';

const ACCEPTED_FIREWORK_COUNT = 7;
const ACCEPTED_FIREWORK_DURATION_MS = 2_000;
const SEEN_ACCEPTED_SETTLEMENT_LIMIT = 256;
const seenAcceptedSettlements = new Set<string>();

export interface WalletCardProps {
  readonly wallet: WalletPresentation;
  readonly runtimeState?: RuntimePresentationState;
  readonly managementActions?: boolean;
  readonly commandsDisabled?: boolean;
  readonly onContinueOnboarding?: (walletId: string) => void;
  readonly onRemove?: (walletId: string) => void;
  readonly onStart?: (walletId: string) => void;
  readonly onStop?: (walletId: string) => void;
  /** Enabled only by the Dashboard wallet fleet. */
  readonly rewardEffects?: boolean;
}

export const WalletCard = memo(function WalletCard({
  wallet,
  runtimeState,
  managementActions = false,
  commandsDisabled = false,
  onContinueOnboarding,
  onRemove,
  onStart,
  onStop,
  rewardEffects = false,
}: WalletCardProps) {
  const { language, t } = useUiLanguage();
  const { animationEnabled, announceReward } = useRewardEffects();
  const [floatingReward, setFloatingReward] = useState<WalletRewardDelta | null>(
    null,
  );
  const [showingAcceptedFireworks, setShowingAcceptedFireworks] = useState(false);
  const cancelAnimationTimer = useRef<(() => void) | null>(null);
  const releaseAnimation = useRef<(() => void) | null>(null);
  const acceptedFireworkTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const runtimeStatus = runtimeState?.runtimeStatus ?? wallet.runtimeStatus;
  const settlementStatus =
    runtimeState?.settlementStatus ?? wallet.settlementStatus;
  const tapProgress = runtimeState?.miningExecution?.tapProgress;
  const completedTaps = tapProgress?.completedTapCount ?? wallet.completedTaps;
  const tapTarget = tapProgress?.targetTapCount ?? wallet.tapTarget;
  const normalizedTapTarget = validTapTarget(tapTarget);
  const normalizedCompletedTaps = validCompletedTaps(
    completedTaps,
    normalizedTapTarget,
  );
  const tapProgressLabel = formatTapProgress(completedTaps, tapTarget, t);
  const runtimeActive = walletRuntimeActive(runtimeStatus);
  const runtimeStartable =
    wallet.connection.miningReady && runtimeStatus === 'idle';
  const reward = wallet.latestMiningReward;
  const rewardId = reward?.id ?? null;
  const acceptedSettlementKey =
    runtimeState?.settlementOutcome === 'accepted' &&
    runtimeState.settlementSessionId &&
    runtimeState.settlementGeneration !== null &&
    runtimeState.settlementGeneration !== undefined
      ? `${wallet.id}:${runtimeState.settlementSessionId}:${runtimeState.settlementGeneration}`
      : null;

  useEffect(() => {
    if (
      !rewardEffects ||
      !reward ||
      !isWalletRewardForCurrentRun(wallet.id, reward) ||
      !announceReward(reward.id)
    ) {
      return;
    }

    cancelAnimationTimer.current?.();
    cancelAnimationTimer.current = null;
    releaseAnimation.current?.();
    releaseAnimation.current = null;
    if (animationEnabled) {
      setFloatingReward(reward);
      releaseAnimation.current = import.meta.env.DEV
        ? trackRewardAnimation()
        : null;
      cancelAnimationTimer.current = scheduleRewardAnimationEnd(() => {
        setFloatingReward(null);
        cancelAnimationTimer.current = null;
        releaseAnimation.current?.();
        releaseAnimation.current = null;
      });
    }

    return () => {
      cancelAnimationTimer.current?.();
      cancelAnimationTimer.current = null;
      releaseAnimation.current?.();
      releaseAnimation.current = null;
    };
  }, [
    animationEnabled,
    announceReward,
    rewardEffects,
    rewardId,
    wallet.id,
  ]);

  useEffect(() => {
    if (
      !animationEnabled ||
      !acceptedSettlementKey ||
      !claimAcceptedSettlement(acceptedSettlementKey)
    ) {
      return;
    }

    setShowingAcceptedFireworks(true);
    acceptedFireworkTimer.current = setTimeout(() => {
      setShowingAcceptedFireworks(false);
      acceptedFireworkTimer.current = null;
    }, ACCEPTED_FIREWORK_DURATION_MS);

    return () => {
      if (acceptedFireworkTimer.current) {
        clearTimeout(acceptedFireworkTimer.current);
        acceptedFireworkTimer.current = null;
      }
    };
  }, [acceptedSettlementKey, animationEnabled]);

  return (
    <article className={`wallet-card wallet-card-${walletCardVisualState(wallet, runtimeStatus)} wallet-card-compact${floatingReward ? ' wallet-card-rewarding' : ''}${showingAcceptedFireworks ? ' wallet-card-celebrating' : ''}`}>
      {showingAcceptedFireworks ? (
        <span aria-hidden="true" className="wallet-accepted-fireworks">
          {Array.from({ length: ACCEPTED_FIREWORK_COUNT }, (_, index) => (
            <i key={index} />
          ))}
        </span>
      ) : null}
      <span
        aria-label={t('Session progress')}
        aria-valuemax={normalizedTapTarget}
        aria-valuemin={0}
        aria-valuenow={normalizedCompletedTaps}
        aria-valuetext={tapProgressLabel}
        className="wallet-card-progress-fill"
        role="progressbar"
        style={{
          transform: `scaleX(${normalizedCompletedTaps / normalizedTapTarget})`,
        }}
      />
      {floatingReward ? (
        <output className="wallet-reward-float" aria-live="polite">
          +{formatRawAmount(
            floatingReward.amountRaw,
            9,
            2,
            language === 'en' ? '.' : ',',
          )} NACKL
        </output>
      ) : null}
      <div className="wallet-card-heading">
        <div className="wallet-identity">
          <span className="wallet-avatar" aria-hidden="true">
            {wallet.name.slice(0, 1).toLocaleUpperCase() || 'W'}
          </span>
          <div>
            <span>{t('Mining wallet')}</span>
            <h3>{wallet.name}</h3>
          </div>
        </div>
        <StatusBadge
          label={walletCardStatus(wallet, runtimeStatus, settlementStatus)}
          tone={walletCardStatusTone(wallet, runtimeStatus)}
        />
      </div>

      <div className="wallet-progress-summary" aria-label={t('Session progress')}>
        <span>{`${t('MamaBoard Level')} ${
          wallet.mamaBoardLevel === null
            ? t('Unavailable')
            : wallet.mamaBoardLevel
        }`}</span>
        <strong>{tapProgressLabel}</strong>
      </div>

      <dl className="wallet-overview">
        <div className={floatingReward ? 'wallet-balance-rewarding' : undefined}>
          <dt><TokenIdentity accessibleLabel={t('NACKL locked')} badge="LOCKED" size="small" token="nackl" /></dt>
          <dd
            className="wallet-balance-value"
            key={`locked-${wallet.balance?.values?.nacklLockedRaw ?? 'unavailable'}`}
          >
            {balanceValue(wallet, 'nacklLockedRaw', t, language)}
          </dd>
        </div>
        <div>
          <dt><TokenIdentity accessibleLabel={t('NACKL available')} badge="AVAILABLE" size="small" token="nackl" /></dt>
          <dd
            className="wallet-balance-value"
            key={`available-${wallet.balance?.values?.nacklAvailableRaw ?? 'unavailable'}`}
          >
            {balanceValue(wallet, 'nacklAvailableRaw', t, language)}
          </dd>
        </div>
      </dl>

      <div className={`wallet-reward-controls${runtimeActive || runtimeStartable ? '' : ' wallet-reward-controls-history-only'}`}>
        <section className="wallet-reward-history">
          {wallet.miningRewards.length > 0 ? (
            <ol>
              {[...wallet.miningRewards].slice(-4).reverse().map((reward) => (
                <li key={reward.id}>
                  <time dateTime={reward.detectedAt}>
                    {formatRewardTime(reward.detectedAt, language)}
                  </time>
                  <strong>
                    +{formatRawAmount(
                      reward.amountRaw,
                      9,
                      2,
                      language === 'en' ? '.' : ',',
                    )} NACKL
                  </strong>
                </li>
              ))}
            </ol>
          ) : (
            <p>{t('No mining rewards recorded')}</p>
          )}
        </section>

        {runtimeActive || runtimeStartable ? (
          <div className="wallet-runtime-actions" aria-label={t('{wallet} mining controls', { wallet: wallet.name })}>
            {runtimeActive ? (
              <button
                className="button button-secondary"
                disabled={commandsDisabled || !onStop}
              onClick={() => onStop?.(wallet.id)}
              type="button"
            >
                STOP
              </button>
            ) : (
              <button
                className="button button-primary"
                disabled={commandsDisabled || !onStart}
              onClick={() => onStart?.(wallet.id)}
              type="button"
            >
                START
              </button>
            )}
          </div>
        ) : null}
      </div>
      {managementActions ? (
        <div className="wallet-actions" aria-label={`${wallet.name} management`}>
          <button
            className="wallet-setup-action button button-primary"
            disabled={!onContinueOnboarding}
            onClick={() => onContinueOnboarding?.(wallet.id)}
            type="button"
          >
            {t(wallet.connection.miningReady
              ? 'View wallet readiness'
              : 'Continue setup')}
          </button>
          <button
            className="button button-quiet"
            disabled={
              !onRemove ||
              wallet.sessionId !== null ||
              wallet.connection.phase !== 'disconnected' ||
              wallet.connection.operationPending
            }
            onClick={() => onRemove?.(wallet.id)}
            type="button"
          >
            {t('Remove')}
          </button>
        </div>
      ) : null}
    </article>
  );
}, walletCardPropsEqual);

function walletCardPropsEqual(
  previous: Readonly<WalletCardProps>,
  next: Readonly<WalletCardProps>,
): boolean {
  return (
    previous.wallet === next.wallet &&
    previous.managementActions === next.managementActions &&
    previous.commandsDisabled === next.commandsDisabled &&
    previous.rewardEffects === next.rewardEffects &&
    runtimePresentationEqual(previous.runtimeState, next.runtimeState)
  );
}

function runtimePresentationEqual(
  previous: RuntimePresentationState | undefined,
  next: RuntimePresentationState | undefined,
): boolean {
  return (
    previous?.runtimeStatus === next?.runtimeStatus &&
    previous?.schedulerStatus === next?.schedulerStatus &&
    previous?.settlementStatus === next?.settlementStatus &&
    previous?.settlementOutcome === next?.settlementOutcome &&
    previous?.settlementSessionId === next?.settlementSessionId &&
    previous?.settlementGeneration === next?.settlementGeneration &&
    previous?.miningExecution?.sessionId === next?.miningExecution?.sessionId &&
    previous?.miningExecution?.generation === next?.miningExecution?.generation &&
    previous?.miningExecution?.tapProgress.completedTapCount ===
      next?.miningExecution?.tapProgress.completedTapCount &&
    previous?.miningExecution?.tapProgress.targetTapCount ===
      next?.miningExecution?.tapProgress.targetTapCount
  );
}

function claimAcceptedSettlement(key: string): boolean {
  if (seenAcceptedSettlements.has(key)) {
    return false;
  }

  seenAcceptedSettlements.add(key);
  if (seenAcceptedSettlements.size > SEEN_ACCEPTED_SETTLEMENT_LIMIT) {
    const oldest = seenAcceptedSettlements.values().next().value;
    if (oldest) {
      seenAcceptedSettlements.delete(oldest);
    }
  }
  return true;
}

function walletCardStatus(
  wallet: WalletPresentation,
  runtimeStatus: WalletPresentation['runtimeStatus'],
  settlementStatus: WalletPresentation['settlementStatus'],
): string {
  if (wallet.recovery.state === 'recovery-failed') {
    return 'Error';
  }

  if (
    wallet.recovery.state === 'detecting-issue' ||
    wallet.recovery.state === 'recovery-pending' ||
    wallet.recovery.state === 'recovering'
  ) {
    return 'Recovering';
  }

  switch (runtimeStatus) {
    case 'running':
      return 'Mining';
    case 'starting':
      return 'Starting';
    case 'waiting':
      return 'Waiting';
    case 'stopping':
      return settlementStatus === 'pending' ? 'Settling' : 'Stopping';
    case 'disposed':
      return 'Error';
    case 'idle':
      break;
  }

  if (wallet.status === 'error' || wallet.connection.onboardingStatus === 'failed') {
    return 'Error';
  }

  switch (wallet.connection.onboardingStatus) {
    case 'disconnected':
      return 'Disconnected';
    case 'awaiting-connection':
      return 'Waiting for approval';
    case 'connected':
      return 'Wallet approved';
    case 'awaiting-mining-key-approval':
      return wallet.connection.miningCredentialStored
        ? 'Waiting for propagation'
        : 'Generating mining keys';
    case 'propagating-mining-key':
      return 'Waiting for propagation';
    case 'ready':
      return 'Ready for mining';
  }
}

function walletCardStatusTone(
  wallet: WalletPresentation,
  runtimeStatus: WalletPresentation['runtimeStatus'],
): StatusTone {
  if (wallet.recovery.state === 'recovery-failed') {
    return 'error';
  }

  if (
    wallet.recovery.state === 'detecting-issue' ||
    wallet.recovery.state === 'recovery-pending' ||
    wallet.recovery.state === 'recovering'
  ) {
    return 'warning';
  }
  if (runtimeStatus === 'running') {
    return 'success';
  }

  if (
    runtimeStatus === 'starting' ||
    runtimeStatus === 'waiting' ||
    runtimeStatus === 'stopping'
  ) {
    return 'warning';
  }

  if (runtimeStatus === 'disposed') {
    return 'error';
  }

  if (wallet.status === 'error' || wallet.connection.onboardingStatus === 'failed') {
    return 'error';
  }

  if (
    wallet.connection.onboardingStatus === 'awaiting-connection' ||
    wallet.connection.onboardingStatus === 'awaiting-mining-key-approval' ||
    wallet.connection.onboardingStatus === 'propagating-mining-key'
  ) {
    return 'warning';
  }

  return 'neutral';
}

function formatRewardTime(
  value: string,
  language: 'en' | 'pl' | 'ru',
): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(
        language === 'pl' ? 'pl-PL' : language === 'ru' ? 'ru-RU' : 'en-GB',
        { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
      ).format(date);
}

function balanceValue(
  wallet: WalletPresentation,
  field: 'nacklLockedRaw' | 'nacklAvailableRaw',
  t: Translate,
  language: 'en' | 'pl' | 'ru',
): string {
  return wallet.balance?.values
    ? formatRawAmount(
        wallet.balance.values[field],
        9,
        2,
        language === 'en' ? '.' : ',',
      )
    : t('Not synchronized');
}

function formatTapProgress(
  completedTaps: number | null,
  targetTaps: number | null,
  t: Translate,
): string {
  if (
    completedTaps === null ||
    targetTaps === null ||
    !Number.isFinite(completedTaps) ||
    !Number.isFinite(targetTaps)
  ) {
    return t('Not available');
  }

  return `${Math.max(0, Math.trunc(completedTaps))}/${Math.max(0, Math.trunc(targetTaps))}`;
}

function validTapTarget(value: number | null): number {
  return value !== null && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 70;
}

function validCompletedTaps(value: number | null, maximum: number): number {
  return value !== null && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.trunc(value)))
    : 0;
}

function walletRuntimeActive(
  runtimeStatus: WalletPresentation['runtimeStatus'],
): boolean {
  return runtimeStatus !== 'idle' && runtimeStatus !== 'disposed';
}

function walletCardVisualState(
  wallet: WalletPresentation,
  runtimeStatus: WalletPresentation['runtimeStatus'],
): 'running' | 'warning' | 'error' | 'idle' {
  const tone = walletCardStatusTone(wallet, runtimeStatus);

  if (tone === 'success') {
    return 'running';
  }

  if (tone === 'warning') {
    return 'warning';
  }

  return tone === 'error' ? 'error' : 'idle';
}
