import { describe, expect, it } from 'vitest';
import { AdaptiveQueuePressureController } from './AdaptiveQueuePressureController';

const QUEUE_FAILURE = Object.freeze({
  failureStage: 'ROOT_SUBMIT' as const,
  errorCategory: 'QUEUE',
  serverCode: 621,
  nodeExtensionCode: 'QUEUE_OVERFLOW',
});

describe('AdaptiveQueuePressureController', () => {
  it('raises pressure after one and three unique queue failures', () => {
    const controller = new AdaptiveQueuePressureController(() => 13);

    controller.observeQueueFailure('wallet-1', 'epoch-1', 'generation-1', QUEUE_FAILURE);
    expect(controller.pressureLevel()).toBe(1);
    expect(controller.startSpacingMs(13)).toBe(6_500);

    controller.observeQueueFailure('wallet-1', 'epoch-1', 'generation-1', QUEUE_FAILURE);
    controller.observeQueueFailure('wallet-2', 'epoch-1', 'generation-1', QUEUE_FAILURE);
    expect(controller.pressureLevel()).toBe(1);

    controller.observeQueueFailure('wallet-3', 'epoch-1', 'generation-1', QUEUE_FAILURE);
    expect(controller.pressureLevel()).toBe(2);
    expect(controller.startSpacingMs(13)).toBe(8_000);
  });

  it('decays one level only after a complete failure-free fleet epoch', () => {
    const controller = new AdaptiveQueuePressureController(() => 3);
    controller.observeQueueFailure('wallet-1', 'epoch-1', 'generation-1', QUEUE_FAILURE);
    controller.observeQueueFailure('wallet-2', 'epoch-1', 'generation-1', QUEUE_FAILURE);
    controller.observeQueueFailure('wallet-3', 'epoch-1', 'generation-1', QUEUE_FAILURE);
    expect(controller.pressureLevel()).toBe(2);

    controller.reportProductiveOutcome('wallet-1', 'epoch-2', null);
    controller.reportProductiveOutcome('wallet-2', 'epoch-2', null);
    expect(controller.pressureLevel()).toBe(2);
    controller.reportProductiveOutcome('wallet-3', 'epoch-2', null);
    expect(controller.pressureLevel()).toBe(1);

    for (const walletId of ['wallet-1', 'wallet-2', 'wallet-3']) {
      controller.reportProductiveOutcome(walletId, 'epoch-3', null);
    }
    expect(controller.pressureLevel()).toBe(0);
  });

  it('does not decay after a non-queue failure or duplicate an outcome', () => {
    const controller = new AdaptiveQueuePressureController(() => 2);
    controller.observeQueueFailure('wallet-1', 'epoch-1', 'generation-1', QUEUE_FAILURE);
    expect(controller.pressureLevel()).toBe(1);

    controller.reportProductiveOutcome('wallet-1', 'epoch-2', null);
    controller.reportProductiveOutcome('wallet-1', 'epoch-2', null);
    controller.reportProductiveOutcome('wallet-2', 'epoch-2', {
      failureStage: 'PROOF_SUBMIT',
      errorCategory: 'PROOF_REJECTED',
    });
    expect(controller.pressureLevel()).toBe(1);
  });
});
