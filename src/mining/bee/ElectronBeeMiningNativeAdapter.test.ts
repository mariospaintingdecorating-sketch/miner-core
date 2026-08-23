import { describe, expect, it } from 'vitest';
import { MiningNativeAdapterError, type SafeNativeCallback } from '../WalletMiningRuntime';
import type { BeeMiningRendererBridge } from './BeeMiningUtilityProtocol';
import { ElectronBeeMiningNativeAdapter } from './ElectronBeeMiningNativeAdapter';

class FakeBridge implements BeeMiningRendererBridge {
  readonly requests: Record<string, unknown>[] = [];
  listener: ((message: unknown) => void) | null = null;
  failure: Record<string, unknown> | null = null;

  async request(request: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.requests.push(request);
    if (this.failure) {
      return { type: 'response', ok: false, failure: this.failure };
    }
    switch (request.operation) {
      case 'canStart':
        return { type: 'response', ok: true, value: true };
      case 'getMinerData':
        return { type: 'response', ok: true, value: { tapSum: '70' } };
      default:
        return { type: 'response', ok: true, value: null };
    }
  }

  onCallback(listener: (message: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }
}

const INPUT = Object.freeze({
  endpoints: Object.freeze(['https://synthetic.invalid']),
  appId: 'synthetic-app',
  minerAddress: '0:synthetic',
  publicKey: 'synthetic-public',
  secretKey: 'synthetic-secret',
});

describe('ElectronBeeMiningNativeAdapter', () => {
  it('proxies the complete Miner lifecycle and releases the callback owner on free', async () => {
    const bridge = new FakeBridge();
    const adapter = new ElectronBeeMiningNativeAdapter(bridge);
    const miner = await adapter.createMiner(INPUT);
    const callbacks: SafeNativeCallback[] = [];

    expect(await miner.canStart()).toBe(true);
    await miner.start(135_000, (callback) => callbacks.push(callback));
    const handleId = String(bridge.requests[0].handleId);
    const callbackSessionId = String(
      bridge.requests.find((entry) => entry.operation === 'start')?.callbackSessionId,
    );
    bridge.listener?.({
      type: 'callback',
      handleId,
      callbackSessionId,
      callback: {
        action: 'finished',
        sequence: 1,
        errorPresent: false,
        rawPayload: 'must-not-cross',
      },
    });
    bridge.listener?.({
      type: 'callback',
      handleId,
      callbackSessionId,
      callback: {
        action: 'session_accepted',
        sequence: 2,
        errorPresent: false,
      },
    });
    await miner.addTap(40, 80);
    await miner.stop();
    const data = await miner.getMinerData!();
    expect(data.tapSum).toBe(70n);
    data.free();
    await miner.getReward();
    await miner.free();

    expect(bridge.requests.map((entry) => entry.operation)).toEqual([
      'create', 'canStart', 'start', 'addTap', 'stop',
      'getMinerData', 'getReward', 'free',
    ]);
    expect(callbacks).toHaveLength(2);
    expect(callbacks[0]).not.toHaveProperty('rawPayload');
    expect(callbacks[0].failureStage).toBeUndefined();
    expect(callbacks[1]).toMatchObject({
      action: 'session_accepted',
      errorPresent: false,
    });

    bridge.listener?.({
      type: 'callback',
      handleId,
      callbackSessionId,
      callback: { action: 'tap_computed', sequence: 3 },
    });
    expect(callbacks).toHaveLength(2);
  });

  it('preserves only safe lower-level failure fields', async () => {
    const bridge = new FakeBridge();
    bridge.failure = {
      failureStage: 'PREPARE',
      errorCategory: 'QUEUE',
      serverCode: 621,
      nodeExtensionCode: 'QUEUE_OVERFLOW',
      rawPayload: 'must-not-cross',
    };
    const adapter = new ElectronBeeMiningNativeAdapter(bridge);

    const error = await adapter.createMiner(INPUT).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MiningNativeAdapterError);
    expect((error as MiningNativeAdapterError).safeFailure).toMatchObject({
      failureStage: 'PREPARE',
      errorCategory: 'QUEUE',
      serverCode: 621,
      nodeExtensionCode: 'QUEUE_OVERFLOW',
    });
    expect((error as MiningNativeAdapterError).safeFailure).not.toHaveProperty('rawPayload');
  });

  it('keeps callback ownership after a failed proof callback until the terminal callback', async () => {
    const bridge = new FakeBridge();
    const adapter = new ElectronBeeMiningNativeAdapter(bridge);
    const miner = await adapter.createMiner(INPUT);
    const callbacks: SafeNativeCallback[] = [];
    await miner.start(135_000, (callback) => callbacks.push(callback));
    const handleId = String(bridge.requests[0].handleId);
    const callbackSessionId = String(
      bridge.requests.find((entry) => entry.operation === 'start')?.callbackSessionId,
    );

    bridge.listener?.({
      type: 'callback',
      handleId,
      callbackSessionId,
      callback: {
        action: 'submit_session_proof',
        sequence: 1,
        status: 'failed',
        errorPresent: true,
        failureStage: 'PROOF_SUBMIT',
        serverCode: 621,
      },
    });
    bridge.listener?.({
      type: 'callback',
      handleId,
      callbackSessionId,
      callback: {
        action: 'session_rejected',
        sequence: 2,
        status: 'rejected',
        errorPresent: false,
      },
    });

    expect(callbacks.map((callback) => callback.action)).toEqual([
      'submit_session_proof',
      'session_rejected',
    ]);
  });
});
