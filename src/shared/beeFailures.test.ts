import { describe, expect, it } from 'vitest';
import { inspectBeeFailure } from './beeFailures';

describe('Bee failure classification', () => {
  it('classifies code 621 from the authoritative QUEUE_OVERFLOW extension', () => {
    expect(
      inspectBeeFailure({
        code: 621,
        message: 'Unknown error',
        node_error: {
          extensions: {
            code: 'QUEUE_OVERFLOW',
            message_hash: 'queue-message-hash',
          },
        },
      }),
    ).toMatchObject({
      classification: 'QUEUE_OVERFLOW',
      messageHash: 'queue-message-hash',
    });
  });

  it('gives DUPLICATE_MESSAGE priority over the shared numeric code 621', () => {
    expect(
      inspectBeeFailure({
        code: 621,
        message: 'Unknown error',
        node_error: {
          extensions: {
            code: 'DUPLICATE_MESSAGE',
            message_hash: 'duplicate-message-hash',
          },
        },
      }),
    ).toMatchObject({
      classification: 'DUPLICATE_MESSAGE',
      messageHash: 'duplicate-message-hash',
    });
  });

  it('keeps an unqualified code 621 as an unknown node error', () => {
    expect(inspectBeeFailure({ code: 621, message: 'Unknown error' })).toMatchObject({
      classification: 'UNKNOWN_NODE_ERROR',
      messageHash: null,
    });
  });
});
