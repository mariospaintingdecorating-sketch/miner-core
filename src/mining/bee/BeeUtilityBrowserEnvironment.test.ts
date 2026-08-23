import { describe, expect, it } from 'vitest';
import { installBeeUtilityBrowserEnvironment } from './BeeUtilityBrowserEnvironment';

describe('installBeeUtilityBrowserEnvironment', () => {
  it('aliases existing Node fetch and Web Crypto without replacing them', () => {
    const fetch = () => undefined;
    const crypto = {
      getRandomValues: () => undefined,
      subtle: {},
    };
    const target = { fetch, crypto };

    installBeeUtilityBrowserEnvironment(target);

    expect(target).toMatchObject({ fetch, crypto });
    expect((target as { window?: unknown }).window).toBe(target);
    expect((target as { self?: unknown }).self).toBe(target);
    const Window = (target as { Window?: typeof Function }).Window!;
    expect(target instanceof (Window as unknown as typeof Object)).toBe(true);
  });

  it('fails closed when Node browser primitives are unavailable', () => {
    expect(() => installBeeUtilityBrowserEnvironment({})).toThrow(
      'Bee utility browser primitives are unavailable.',
    );
  });

  it('does not overwrite an existing foreign window owner', () => {
    expect(() => installBeeUtilityBrowserEnvironment({
      fetch: () => undefined,
      crypto: { getRandomValues: () => undefined, subtle: {} },
      window: {},
    })).toThrow('Bee utility global window is already owned.');
  });
});
