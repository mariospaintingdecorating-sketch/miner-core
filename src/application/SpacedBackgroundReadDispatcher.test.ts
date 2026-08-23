import { describe, expect, it } from 'vitest';
import {
  deferredValue,
  type DeferredValue,
} from '../mining/testing/DeterministicMiningFakes';
import { SpacedBackgroundReadDispatcher } from './SpacedBackgroundReadDispatcher';

describe('SpacedBackgroundReadDispatcher', () => {
  it('runs shared Bee reads one at a time with a cooldown between them', async () => {
    const cooldowns: Array<DeferredValue<void>> = [];
    const dispatcher = new SpacedBackgroundReadDispatcher(350, async () => {
      const cooldown = deferredValue<void>();
      cooldowns.push(cooldown);
      await cooldown.promise;
    });
    const firstResult = deferredValue<string>();
    const starts: string[] = [];

    const first = dispatcher.dispatch(async () => {
      starts.push('first');
      return firstResult.promise;
    });
    const second = dispatcher.dispatch(async () => {
      starts.push('second');
      return 'second-result';
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toEqual(['first']);
    firstResult.resolve('first-result');
    await expect(first).resolves.toBe('first-result');
    expect(starts).toEqual(['first']);
    expect(cooldowns).toHaveLength(1);

    cooldowns[0]!.resolve(undefined);
    await expect(second).resolves.toBe('second-result');
    expect(starts).toEqual(['first', 'second']);
  });

  it('releases the next read after a failed operation', async () => {
    const cooldowns: Array<DeferredValue<void>> = [];
    const dispatcher = new SpacedBackgroundReadDispatcher(350, async () => {
      const cooldown = deferredValue<void>();
      cooldowns.push(cooldown);
      await cooldown.promise;
    });
    const starts: string[] = [];

    const failed = dispatcher.dispatch(async () => {
      starts.push('failed');
      throw new Error('read failed');
    });
    const next = dispatcher.dispatch(async () => {
      starts.push('next');
      return 'ok';
    });

    await expect(failed).rejects.toThrow('read failed');
    expect(starts).toEqual(['failed']);
    cooldowns[0]!.resolve(undefined);
    await expect(next).resolves.toBe('ok');
    expect(starts).toEqual(['failed', 'next']);
  });

  it('rejects invalid spacing', () => {
    expect(() => new SpacedBackgroundReadDispatcher(-1)).toThrow(RangeError);
  });
});
