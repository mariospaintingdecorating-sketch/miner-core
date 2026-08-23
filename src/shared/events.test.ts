import { describe, expect, it, vi } from 'vitest';
import type { CoreEvent } from './events';
import { CORE_EVENT_TYPES, CoreEventEmitter } from './events';

describe('CoreEventEmitter', () => {
  it('emits an event to its listener', () => {
    const emitter = new CoreEventEmitter();
    const listener = vi.fn();
    const event: CoreEvent<'session-created'> = {
      id: 'event-1',
      occurredAt: '2026-08-03T12:00:00.000Z',
      type: 'session-created',
      payload: {
        sessionId: 'session-1',
        generation: 1,
      },
    };
    emitter.subscribe('session-created', listener);

    emitter.publish(event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('delivers the correct typed payload', () => {
    const emitter = new CoreEventEmitter();
    const receivedPayloads: CoreEvent<'tap-progress'>['payload'][] = [];
    emitter.subscribe('tap-progress', (event) => {
      receivedPayloads.push(event.payload);
    });

    emitter.publish({
      id: 'event-2',
      occurredAt: '2026-08-03T12:01:00.000Z',
      type: 'tap-progress',
      payload: {
        sessionId: 'session-1',
        generation: 1,
        completedTapCount: 12,
      },
    });

    expect(receivedPayloads).toEqual([
      {
        sessionId: 'session-1',
        generation: 1,
        completedTapCount: 12,
      },
    ]);
  });

  it('notifies multiple listeners independently', () => {
    const emitter = new CoreEventEmitter();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = emitter.subscribe('warning', firstListener);
    emitter.subscribe('warning', secondListener);
    const event: CoreEvent<'warning'> = {
      id: 'event-3',
      occurredAt: '2026-08-03T12:02:00.000Z',
      type: 'warning',
      payload: {
        code: 'runtime-warning',
        message: 'Runtime warning',
      },
    };

    emitter.publish(event);
    unsubscribeFirst();
    emitter.publish(event);

    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).toHaveBeenCalledTimes(2);
  });

  it('isolates throwing listeners and continues delivery without an error event storm', () => {
    const listenerError = new Error('Listener failed');
    const onListenerError = vi.fn(() => {
      throw new Error('Error reporting also failed');
    });
    const emitter = new CoreEventEmitter(onListenerError);
    const firstListener = vi.fn(() => {
      throw listenerError;
    });
    const secondListener = vi.fn();
    const thirdListener = vi.fn();
    emitter.subscribe('warning', firstListener);
    emitter.subscribe('warning', secondListener);
    emitter.subscribe('warning', thirdListener);
    const event: CoreEvent<'warning'> = {
      id: 'event-listener-failure',
      occurredAt: '2026-08-09T12:00:00.000Z',
      type: 'warning',
      payload: {
        code: 'listener-failure-test',
        message: 'Listener failure isolation test',
      },
    };

    expect(() => emitter.publish(event)).not.toThrow();

    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).toHaveBeenCalledOnce();
    expect(thirdListener).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledWith(listenerError, event);
  });

  it('does not expose lifecycle controls', () => {
    const emitter = new CoreEventEmitter();

    expect('start' in emitter).toBe(false);
    expect('stop' in emitter).toBe(false);
    expect('dispose' in emitter).toBe(false);
  });

  it('provides one event catalog for application observers', () => {
    expect(new Set(CORE_EVENT_TYPES).size).toBe(CORE_EVENT_TYPES.length);
    expect(CORE_EVENT_TYPES).toContain('session-started');
    expect(CORE_EVENT_TYPES).toContain('tap-execution-failed');
    expect(CORE_EVENT_TYPES).toContain('settlement-completed');
    expect(CORE_EVENT_TYPES).toContain('recovery-completed');
    expect(CORE_EVENT_TYPES).toContain('reward-received');
    expect(CORE_EVENT_TYPES).toContain('reward-recorded');
  });
});
