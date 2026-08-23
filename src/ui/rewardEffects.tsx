import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import rewardSoundUrl from './reward-coin.mp3';
import { recordRewardAudioElement } from './presentationMetrics';

const REWARD_ANIMATION_KEY = 'miner-core.reward-animation';
const REWARD_SOUND_KEY = 'miner-core.reward-sound';
const SOUND_COOLDOWN_MS = 1_200;
const MAX_SEEN_REWARDS = 200;
const REWARD_ANIMATION_DURATION_MS = 1_700;

interface RewardEffectsContextValue {
  readonly animationEnabled: boolean;
  readonly soundEnabled: boolean;
  readonly setAnimationEnabled: (enabled: boolean) => void;
  readonly setSoundEnabled: (enabled: boolean) => void;
  /** Claims one wallet-scoped reward signal exactly once across mounted cards. */
  readonly announceReward: (rewardId: string) => boolean;
}

const RewardEffectsContext = createContext<RewardEffectsContextValue>({
  animationEnabled: true,
  soundEnabled: true,
  setAnimationEnabled: () => undefined,
  setSoundEnabled: () => undefined,
  announceReward: () => false,
});

export function RewardEffectsProvider({ children }: { readonly children: ReactNode }) {
  const [animationEnabled, setAnimation] = useState(() =>
    storedPreference(REWARD_ANIMATION_KEY),
  );
  const [soundEnabled, setSound] = useState(() =>
    storedPreference(REWARD_SOUND_KEY),
  );
  const seenRewards = useRef<string[]>([]);
  const lastSoundAt = useRef(0);

  const setAnimationEnabled = useCallback((enabled: boolean) => {
    setAnimation(enabled);
    storePreference(REWARD_ANIMATION_KEY, enabled);
  }, []);
  const setSoundEnabled = useCallback((enabled: boolean) => {
    setSound(enabled);
    storePreference(REWARD_SOUND_KEY, enabled);
  }, []);
  const announceReward = useCallback(
    (rewardId: string): boolean => {
      const claimedRewards = claimRewardAnnouncement(
        seenRewards.current,
        rewardId,
      );
      if (!claimedRewards) {
        return false;
      }

      seenRewards.current = claimedRewards;
      const now = Date.now();
      const pageHidden =
        typeof document !== 'undefined' && document.visibilityState === 'hidden';

      if (
        rewardSoundAllowed({
          enabled: soundEnabled,
          pageHidden,
          now,
          lastSoundAt: lastSoundAt.current,
        })
      ) {
        lastSoundAt.current = now;
        void playRewardSound();
      }

      return true;
    },
    [soundEnabled],
  );
  const value = useMemo<RewardEffectsContextValue>(
    () => ({
      animationEnabled,
      soundEnabled,
      setAnimationEnabled,
      setSoundEnabled,
      announceReward,
    }),
    [
      animationEnabled,
      soundEnabled,
      setAnimationEnabled,
      setSoundEnabled,
      announceReward,
    ],
  );

  return (
    <RewardEffectsContext.Provider value={value}>
      {children}
    </RewardEffectsContext.Provider>
  );
}

export function rewardSoundAllowed(input: Readonly<{
  enabled: boolean;
  pageHidden: boolean;
  now: number;
  lastSoundAt: number;
}>): boolean {
  return (
    input.enabled &&
    !input.pageHidden &&
    input.now - input.lastSoundAt >= SOUND_COOLDOWN_MS
  );
}

export function claimRewardAnnouncement(
  seenRewards: readonly string[],
  rewardId: string,
): string[] | null {
  if (seenRewards.includes(rewardId)) {
    return null;
  }

  return [...seenRewards, rewardId].slice(-MAX_SEEN_REWARDS);
}

export function isCurrentRunReward(
  reward: Readonly<{ observedInCurrentRun: boolean }> | null,
): boolean {
  return reward?.observedInCurrentRun === true;
}

export function isWalletRewardForCurrentRun(
  walletId: string,
  reward: Readonly<{
    walletId: string;
    observedInCurrentRun: boolean;
  }> | null,
): boolean {
  return reward?.walletId === walletId && isCurrentRunReward(reward);
}

export function scheduleRewardAnimationEnd(
  onEnd: () => void,
  delayMs = REWARD_ANIMATION_DURATION_MS,
): () => void {
  let active = true;
  const timer = setTimeout(() => {
    if (!active) {
      return;
    }

    active = false;
    onEnd();
  }, delayMs);

  return () => {
    if (!active) {
      return;
    }

    active = false;
    clearTimeout(timer);
  };
}

export function useRewardEffects(): RewardEffectsContextValue {
  return useContext(RewardEffectsContext);
}

export function storedPreference(
  key: string,
  storage: Pick<Storage, 'getItem'> | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(key) !== 'off';
  } catch {
    return true;
  }
}

function storePreference(key: string, enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, enabled ? 'on' : 'off');
  } catch {
    // Reward presentation remains usable when preferences cannot be persisted.
  }
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

interface RewardAudio {
  preload: string;
  volume: number;
  play(): Promise<void>;
}

type RewardAudioFactory = (source: string) => RewardAudio | null;
let browserRewardAudio: RewardAudio | null = null;

export async function playRewardSound(
  createAudio: RewardAudioFactory = createBrowserAudio,
): Promise<void> {
  const audio = createAudio(rewardSoundUrl);
  if (!audio) {
    return;
  }

  audio.preload = 'auto';
  audio.volume = 0.55;
  try {
    await audio.play();
  } catch {
    // Browser autoplay or a missing audio device cannot affect reward delivery.
  }
}

function createBrowserAudio(source: string): RewardAudio | null {
  if (typeof globalThis.Audio !== 'function') {
    return null;
  }

  if (!browserRewardAudio) {
    browserRewardAudio = new globalThis.Audio(source);
    if (import.meta.env.DEV) {
      recordRewardAudioElement();
    }
  }

  return browserRewardAudio;
}
