export interface RendererPresentationMetricsSnapshot {
  readonly activeSubscriptions: number;
  readonly runtimeUpdates: number;
  readonly walletProjectionUpdates: number;
  readonly walletProjections: number;
  readonly walletRewardRecords: number;
  readonly activeRewardAnimations: number;
  readonly rewardAudioElements: number;
}

const metrics = {
  activeSubscriptions: 0,
  runtimeUpdates: 0,
  walletProjectionUpdates: 0,
  walletProjections: 0,
  walletRewardRecords: 0,
  activeRewardAnimations: 0,
  rewardAudioElements: 0,
};

export function trackPresentationSubscription(): () => void {
  metrics.activeSubscriptions += 1;
  let active = true;

  return () => {
    if (!active) {
      return;
    }
    active = false;
    metrics.activeSubscriptions = Math.max(0, metrics.activeSubscriptions - 1);
  };
}

export function recordRuntimeUpdate(): void {
  metrics.runtimeUpdates += 1;
}

export function recordWalletProjection(
  wallets: readonly Readonly<{
    miningRewards: readonly unknown[];
  }>[],
): void {
  metrics.walletProjectionUpdates += 1;
  metrics.walletProjections = wallets.length;
  metrics.walletRewardRecords = wallets.reduce(
    (total, wallet) => total + wallet.miningRewards.length,
    0,
  );
}

export function trackRewardAnimation(): () => void {
  metrics.activeRewardAnimations += 1;
  let active = true;

  return () => {
    if (!active) {
      return;
    }
    active = false;
    metrics.activeRewardAnimations = Math.max(
      0,
      metrics.activeRewardAnimations - 1,
    );
  };
}

export function recordRewardAudioElement(): void {
  metrics.rewardAudioElements += 1;
}

export function rendererPresentationMetrics(): Readonly<RendererPresentationMetricsSnapshot> {
  return Object.freeze({ ...metrics });
}

export function resetRendererPresentationMetricsForTests(): void {
  for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) {
    metrics[key] = 0;
  }
}
