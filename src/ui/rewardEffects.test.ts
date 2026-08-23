import { describe, expect, it, vi } from 'vitest';
import {
  claimRewardAnnouncement,
  isCurrentRunReward,
  isWalletRewardForCurrentRun,
  playRewardSound,
  rewardSoundAllowed,
  scheduleRewardAnimationEnd,
  storedPreference,
} from './rewardEffects';
import {
  rendererPresentationMetrics,
  resetRendererPresentationMetricsForTests,
} from './presentationMetrics';

describe('reward presentation preferences', () => {
  it('enables animation and sound by default and honors an explicit off value', () => {
    expect(storedPreference('reward', { getItem: () => null })).toBe(true);
    expect(storedPreference('reward', { getItem: () => 'on' })).toBe(true);
    expect(storedPreference('reward', { getItem: () => 'off' })).toBe(false);
  });

  it('suppresses reward sound while hidden, disabled, or inside the cooldown', () => {
    expect(rewardSoundAllowed({
      enabled: true,
      pageHidden: false,
      now: 2_000,
      lastSoundAt: 0,
    })).toBe(true);
    expect(rewardSoundAllowed({
      enabled: true,
      pageHidden: true,
      now: 2_000,
      lastSoundAt: 0,
    })).toBe(false);
    expect(rewardSoundAllowed({
      enabled: true,
      pageHidden: false,
      now: 2_000,
      lastSoundAt: 1_500,
    })).toBe(false);
    expect(rewardSoundAllowed({
      enabled: false,
      pageHidden: false,
      now: 2_000,
      lastSoundAt: 0,
    })).toBe(false);
  });

  it('plays the bundled MP3 instead of synthesizing reward audio', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const audio = { play, preload: '', volume: 1 };
    const createAudio = vi.fn(() => audio);

    await playRewardSound(createAudio);

    expect(createAudio).toHaveBeenCalledOnce();
    expect(createAudio).toHaveBeenCalledWith(
      expect.stringContaining('reward-coin.mp3'),
    );
    expect(audio.preload).toBe('auto');
    expect(audio.volume).toBe(0.55);
    expect(play).toHaveBeenCalledOnce();
  });

  it('reuses one browser audio element across reward announcements', async () => {
    resetRendererPresentationMetricsForTests();
    const originalAudio = globalThis.Audio;
    const play = vi.fn().mockResolvedValue(undefined);
    const AudioConstructor = vi.fn(function FakeAudio() {
      return { play, preload: '', volume: 1 };
    });
    Object.defineProperty(globalThis, 'Audio', {
      configurable: true,
      value: AudioConstructor,
    });

    try {
      await playRewardSound();
      await playRewardSound();

      expect(AudioConstructor).toHaveBeenCalledOnce();
      expect(play).toHaveBeenCalledTimes(2);
      expect(rendererPresentationMetrics().rewardAudioElements).toBe(1);
    } finally {
      Object.defineProperty(globalThis, 'Audio', {
        configurable: true,
        value: originalAudio,
      });
    }
  });

  it('does not announce a persisted historical reward after restart', () => {
    expect(isCurrentRunReward({ observedInCurrentRun: false })).toBe(false);
    expect(isCurrentRunReward({ observedInCurrentRun: true })).toBe(true);
    expect(isWalletRewardForCurrentRun('wallet-a', {
      walletId: 'wallet-a',
      observedInCurrentRun: false,
    })).toBe(false);
  });

  it('limits a current reward visual to the wallet that received it', () => {
    const reward = {
      walletId: 'wallet-a',
      observedInCurrentRun: true,
    };

    expect(isWalletRewardForCurrentRun('wallet-a', reward)).toBe(true);
    expect(isWalletRewardForCurrentRun('wallet-b', reward)).toBe(false);
  });

  it('cleans up the existing reward animation timer idempotently', () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();

    try {
      const cancel = scheduleRewardAnimationEnd(onEnd, 700);
      cancel();
      cancel();
      vi.advanceTimersByTime(700);

      expect(onEnd).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps reward events even when audio cooldown suppresses playback', () => {
    const claimed = claimRewardAnnouncement([], 'reward-a');

    expect(claimed).toEqual(['reward-a']);
    expect(rewardSoundAllowed({
      enabled: true,
      pageHidden: false,
      now: 2_000,
      lastSoundAt: 1_500,
    })).toBe(false);
    expect(claimRewardAnnouncement(claimed!, 'reward-b')).toEqual([
      'reward-a',
      'reward-b',
    ]);
    expect(claimRewardAnnouncement(claimed!, 'reward-a')).toBeNull();
  });
});
