import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SUBMISSION_GUARD_TIMEOUT_MS,
  SubmissionCriticalSection,
} from './SubmissionCriticalSection';

describe('SubmissionCriticalSection', () => {
  it('pauses background work until every wallet submission releases', async () => {
    vi.useFakeTimers();
    const guard = new SubmissionCriticalSection();
    const releaseFirst = guard.enter('wallet-1', 'generation-1');
    const releaseSecond = guard.enter('wallet-2', 'generation-1');
    let resumed = false;
    const waiting = guard.waitUntilIdle().then(() => { resumed = true; });

    releaseFirst();
    await Promise.resolve();
    expect(resumed).toBe(false);
    releaseSecond();
    await waiting;
    expect(resumed).toBe(true);
    vi.useRealTimers();
  });

  it('automatically releases a lost callback lease after 90 seconds', async () => {
    vi.useFakeTimers();
    const guard = new SubmissionCriticalSection();
    guard.enter('wallet-1', 'generation-1');
    let resumed = false;
    const waiting = guard.waitUntilIdle().then(() => { resumed = true; });

    await vi.advanceTimersByTimeAsync(DEFAULT_SUBMISSION_GUARD_TIMEOUT_MS - 1);
    expect(resumed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(resumed).toBe(true);
    vi.useRealTimers();
  });

  it('lets a cancelled background operation leave the wait queue', async () => {
    const guard = new SubmissionCriticalSection();
    const release = guard.enter('wallet-1', 'generation-1');
    const controller = new AbortController();
    const waiting = guard.waitUntilIdle(controller.signal);
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    release();
  });

  it('atomically moves a terminal wallet into serialized post-submission work', async () => {
    const guard = new SubmissionCriticalSection();
    guard.enter('wallet-1', 'generation-1');
    guard.enter('wallet-2', 'generation-1');
    const firstPost = guard.transitionToPostSubmission('wallet-1', 'generation-1');
    const secondPost = guard.transitionToPostSubmission('wallet-2', 'generation-1');
    let backgroundStarted = false;
    const background = guard
      .acquireIdleLease('balance', 'wallet-3')
      .then((release) => {
        backgroundStarted = true;
        return release;
      });

    const releaseFirstPost = await firstPost;
    expect(backgroundStarted).toBe(false);
    let secondPostStarted = false;
    void secondPost.then(() => { secondPostStarted = true; });
    await Promise.resolve();
    expect(secondPostStarted).toBe(false);

    releaseFirstPost();
    const releaseSecondPost = await secondPost;
    expect(backgroundStarted).toBe(false);
    releaseSecondPost();

    const releaseBackground = await background;
    expect(backgroundStarted).toBe(true);
    releaseBackground();
    await expect(guard.waitUntilIdle()).resolves.toBeUndefined();
  });

  it('gives queued terminal cleanup priority over later background work', async () => {
    const guard = new SubmissionCriticalSection();
    const releaseBackground = await guard.acquireIdleLease('balance', 'wallet-1');
    const post = guard.transitionToPostSubmission('wallet-2', 'generation-1');
    const laterBackground = guard.acquireIdleLease('balance', 'wallet-3');

    releaseBackground();
    const releasePost = await post;
    let laterStarted = false;
    void laterBackground.then(() => { laterStarted = true; });
    await Promise.resolve();
    expect(laterStarted).toBe(false);
    releasePost();
    const releaseLater = await laterBackground;
    releaseLater();
  });
});
