import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordRuntimeUpdate,
  recordWalletProjection,
  rendererPresentationMetrics,
  resetRendererPresentationMetricsForTests,
  trackPresentationSubscription,
  trackRewardAnimation,
} from './presentationMetrics';

describe('renderer presentation metrics', () => {
  beforeEach(() => resetRendererPresentationMetricsForTests());

  it('tracks subscription cleanup idempotently for StrictMode remounts', () => {
    const releaseFirst = trackPresentationSubscription();
    const releaseSecond = trackPresentationSubscription();

    expect(rendererPresentationMetrics().activeSubscriptions).toBe(2);
    releaseFirst();
    releaseFirst();
    expect(rendererPresentationMetrics().activeSubscriptions).toBe(1);
    releaseSecond();
    expect(rendererPresentationMetrics().activeSubscriptions).toBe(0);
  });

  it('records only bounded projection counts and active animations', () => {
    recordRuntimeUpdate();
    recordWalletProjection([
      { miningRewards: [1, 2, 3, 4, 5, 6] },
      { miningRewards: [1, 2] },
    ]);
    const releaseAnimation = trackRewardAnimation();

    expect(rendererPresentationMetrics()).toMatchObject({
      runtimeUpdates: 1,
      walletProjectionUpdates: 1,
      walletProjections: 2,
      walletRewardRecords: 8,
      activeRewardAnimations: 1,
    });
    releaseAnimation();
    expect(rendererPresentationMetrics().activeRewardAnimations).toBe(0);
  });

  it('guards every production instrumentation call behind the Vite DEV flag', () => {
    const readSource = (path: string) =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    const presentationHook = readSource('./hooks/useMinerPresentation.ts');
    const walletCard = readSource('./components/WalletCard.tsx');
    const rewardEffects = readSource('./rewardEffects.tsx');

    expect(presentationHook).toMatch(
      /import\.meta\.env\.DEV[\s\S]{0,100}trackPresentationSubscription\(\)/u,
    );
    expect(presentationHook).toMatch(
      /if \(import\.meta\.env\.DEV\) \{\s*recordWalletProjection/u,
    );
    expect(presentationHook).toMatch(
      /if \(import\.meta\.env\.DEV\) \{\s*recordRuntimeUpdate/u,
    );
    expect(walletCard).toMatch(
      /import\.meta\.env\.DEV[\s\S]{0,100}trackRewardAnimation\(\)/u,
    );
    expect(rewardEffects).toMatch(
      /if \(import\.meta\.env\.DEV\) \{\s*recordRewardAudioElement/u,
    );
  });
});
