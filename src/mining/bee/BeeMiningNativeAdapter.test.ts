import { describe, expect, it, vi } from 'vitest';
import type {
  BeeNativeMiner,
  BeeNativeMinerData,
} from '../../services/bee/BeeNativeSdk';
import type {
  NativeMinerCreationInput,
  SafeNativeCallback,
} from '../WalletMiningRuntime';
import { MiningNativeAdapterError } from '../WalletMiningRuntime';
import {
  BeeMiningNativeAdapter,
  type Bee4MiningNativeSdkAccess,
} from './BeeMiningNativeAdapter';

const INPUT: Readonly<NativeMinerCreationInput> = Object.freeze({
  endpoints: Object.freeze([
    'https://synthetic-one.invalid',
    'https://synthetic-two.invalid',
  ]),
  appId: 'synthetic-app-id',
  minerAddress: '0:synthetic-miner-address',
  publicKey: 'synthetic-public-key',
  secretKey: 'synthetic-secret-key',
});

interface CreateCall {
  readonly endpoints: readonly string[];
  readonly appId: string;
  readonly minerAddress: string;
  readonly publicKey: string;
  readonly secretKey: string;
}

class FakeBeeMiner implements BeeNativeMiner {
  canStartValue = true;
  callback: ((...args: unknown[]) => void) | null = null;
  readonly durations: number[] = [];
  readonly tapCalls: Array<readonly [number, number]> = [];
  stopCalls = 0;
  rewardCalls = 0;
  freeCalls = 0;
  minerDataFreeCalls = 0;
  tapSum = 123n;
  addTapError: unknown = null;

  add_tap(x: number, y: number): void {
    if (this.addTapError) throw this.addTapError;
    this.tapCalls.push([x, y]);
  }

  can_start(): boolean {
    return this.canStartValue;
  }

  async get_miner_data(): Promise<BeeNativeMinerData> {
    const owner = this;
    return {
      tap_sum: this.tapSum,
      tap_sum_5m: 0n,
      free() {
        owner.minerDataFreeCalls += 1;
      },
    };
  }

  async get_reward(): Promise<void> {
    this.rewardCalls += 1;
  }

  start(durationMs: number, callback: (...args: unknown[]) => void): void {
    this.durations.push(durationMs);
    this.callback = callback;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  free(): void {
    this.freeCalls += 1;
  }

  emit(value: unknown): void {
    if (!this.callback) throw new Error('Synthetic Bee callback is not ready.');
    this.callback(value);
  }
}

class FakeBee4Access implements Bee4MiningNativeSdkAccess {
  initializeCalls = 0;
  createCalls: CreateCall[] = [];
  createError: unknown = null;

  constructor(readonly miner = new FakeBeeMiner()) {}

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  async createMiner(
    endpoints: readonly string[],
    appId: string,
    minerAddress: string,
    publicKey: string,
    secretKey: string,
  ): Promise<BeeNativeMiner> {
    this.createCalls.push({
      endpoints: [...endpoints],
      appId,
      minerAddress,
      publicKey,
      secretKey,
    });
    if (this.createError) throw this.createError;
    return this.miner;
  }
}

async function fixture(): Promise<{
  readonly access: FakeBee4Access;
  readonly miner: FakeBeeMiner;
  readonly handle: Awaited<ReturnType<BeeMiningNativeAdapter['createMiner']>>;
}> {
  const miner = new FakeBeeMiner();
  const access = new FakeBee4Access(miner);
  const handle = await new BeeMiningNativeAdapter(access).createMiner(INPUT);
  return { access, miner, handle };
}

async function callbackFixture(): Promise<{
  readonly miner: FakeBeeMiner;
  readonly callbacks: Readonly<SafeNativeCallback>[];
}> {
  const { miner, handle } = await fixture();
  const callbacks: Readonly<SafeNativeCallback>[] = [];
  handle.start(330_000, (callback) => callbacks.push(callback));
  return { miner, callbacks };
}

function officialCallback(
  action: string,
  data: Record<string, unknown> | null = {},
  error: unknown = null,
): string {
  return JSON.stringify({ action, data, error });
}

describe('BeeMiningNativeAdapter operations', () => {
  it('passes the exact validated identity arguments to Bee Miner.new access', async () => {
    const { access } = await fixture();
    expect(access.createCalls).toEqual([{
      endpoints: [...INPUT.endpoints],
      appId: INPUT.appId,
      minerAddress: INPUT.minerAddress,
      publicKey: INPUT.publicKey,
      secretKey: INPUT.secretKey,
    }]);
  });

  it('maps Bee can_start true directly', async () => {
    const { handle } = await fixture();
    expect(handle.canStart()).toBe(true);
  });

  it('maps Bee can_start false directly without reinterpreting it', async () => {
    const miner = new FakeBeeMiner();
    miner.canStartValue = false;
    const handle = await new BeeMiningNativeAdapter(
      new FakeBee4Access(miner),
    ).createMiner(INPUT);
    expect(handle.canStart()).toBe(false);
  });

  it('passes the exact supplied duration to Bee start', async () => {
    const { handle, miner } = await fixture();
    handle.start(287_654, () => undefined);
    expect(miner.durations).toEqual([287_654]);
  });

  it('passes the exact x and y coordinates to Bee add_tap', async () => {
    const { handle, miner } = await fixture();
    handle.addTap(17, 29);
    expect(miner.tapCalls).toEqual([[17, 29]]);
  });

  it('preserves the safe native lifecycle message from add_tap', async () => {
    const { handle, miner } = await fixture();
    miner.addTapError = new Error('Mining worker is not running.');

    try {
      handle.addTap(17, 29);
      throw new Error('Expected addTap to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(MiningNativeAdapterError);
      expect((error as MiningNativeAdapterError).safeFailure).toMatchObject({
        failureStage: 'TAP_EXECUTION',
        nativeTopLevelMessage: 'Mining worker is not running.',
      });
    }
  });

  it('calls Bee stop exactly once per neutral stop invocation', async () => {
    const { handle, miner } = await fixture();
    handle.stop();
    handle.stop();
    expect(miner.stopCalls).toBe(2);
  });

  it('reaches native free through the neutral handle', async () => {
    const { handle, miner } = await fixture();
    handle.free();
    expect(miner.freeCalls).toBe(1);
  });

  it('maps get_miner_data to tapSum and a narrow data free wrapper', async () => {
    const { handle, miner } = await fixture();
    const data = await handle.getMinerData?.();
    expect(data?.tapSum).toBe(123n);
    data?.free();
    expect(miner.minerDataFreeCalls).toBe(1);
    expect(Object.keys(data ?? {}).sort()).toEqual(['free', 'tapSum']);
  });

  it('maps get_reward without adding eligibility policy', async () => {
    const { handle, miner } = await fixture();
    await handle.getReward();
    expect(miner.rewardCalls).toBe(1);
  });

  it('initializes Bee access once when creating multiple native miners', async () => {
    const access = new FakeBee4Access();
    const adapter = new BeeMiningNativeAdapter(access);
    await adapter.createMiner(INPUT);
    await adapter.createMiner(INPUT);
    expect(access.initializeCalls).toBe(1);
    expect(access.createCalls).toHaveLength(2);
  });
});

describe('Bee native callback normalization', () => {
  it('normalizes tap_computed into one neutral event', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('tap_computed', { worker_id: 1 }));
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({
      action: 'tap_computed',
      sequence: 1,
      errorPresent: false,
    });
  });

  it('extracts the authoritative computation_completed tap count', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('computation_completed', {
      worker_id: 1,
      taps: 70,
    }));
    expect(callbacks[0]?.computationCompletedTaps).toBe(70);
  });

  it('normalizes a root success callback', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('submit_session_root'));
    expect(callbacks[0]).toMatchObject({
      action: 'submit_session_root',
      errorPresent: false,
      failureStage: null,
    });
  });

  it('normalizes a root error callback at ROOT_SUBMIT', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback(
      'submit_session_root',
      { message: 'TVM_11' },
      'Submit session root failed',
    ));
    expect(callbacks[0]).toMatchObject({
      action: 'submit_session_root',
      errorPresent: true,
      failureStage: 'ROOT_SUBMIT',
      tvmCode: 11,
    });
  });

  it('normalizes a proof success callback separately from root', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('submit_session_proof'));
    expect(callbacks[0]).toMatchObject({
      action: 'submit_session_proof',
      errorPresent: false,
      failureStage: null,
    });
  });

  it('normalizes a proof error callback at PROOF_SUBMIT', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback(
      'submit_session_proof',
      { message: 'proof verification failed' },
      'Native proof error',
    ));
    expect(callbacks[0]).toMatchObject({
      action: 'submit_session_proof',
      errorPresent: true,
      failureStage: 'PROOF_SUBMIT',
    });
  });

  it('keeps misleading Bee root-failure text at PROOF_SUBMIT by action identity', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback(
      'submit_session_proof',
      { message: 'QUEUE_OVERFLOW' },
      'Submit session root failed',
    ));
    expect(callbacks[0]).toMatchObject({
      action: 'submit_session_proof',
      nativeTopLevelMessage: 'Submit session root failed',
      failureStage: 'PROOF_SUBMIT',
    });
  });

  it('normalizes SessionAccepted as authoritative session_accepted', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('SessionAccepted'));
    expect(callbacks[0]?.action).toBe('session_accepted');
  });

  it('normalizes SessionRejected as authoritative session_rejected', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('SessionRejected'));
    expect(callbacks[0]?.action).toBe('session_rejected');
  });

  it('keeps finished as status observation rather than accepted', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('status_updated', { status: 'finished' }));
    expect(callbacks[0]).toMatchObject({
      action: 'status_updated',
      status: 'finished',
    });
    expect(callbacks[0]?.action).not.toBe('session_accepted');
  });

  it('keeps removed as status observation rather than accepted', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('status_updated', { status: 'removed' }));
    expect(callbacks[0]).toMatchObject({
      action: 'status_updated',
      status: 'removed',
    });
    expect(callbacks[0]?.action).not.toBe('session_accepted');
  });
});

describe('Bee safe native error normalization', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['empty string', ''],
    ['empty object', {}],
  ])('does not treat %s as a real error', async (_label, error) => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({ action: 'submit_session_root', data: {}, error });
    expect(callbacks[0]).toMatchObject({
      errorPresent: false,
      failureStage: null,
      errorCategory: null,
    });
  });

  it('extracts TVM_11 and classifies its safe network evidence', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_root',
      error: 'Native submission failed',
      data: {
        message: {
          tvm_code: 11,
          kit_module: 'MvSystem(Miner)',
          kit_code: 501,
          core_version: '4.0.0',
        },
      },
    });
    expect(callbacks[0]).toMatchObject({
      tvmCode: 11,
      tvmCodeName: 'TVM_11',
      kitModule: 'MvSystem(Miner)',
      kitCode: 501,
      coreVersion: '4.0.0',
      errorCategory: 'NETWORK',
    });
  });

  it('extracts QUEUE_OVERFLOW and server code 621', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_proof',
      error: 'Submit session root failed',
      data: {
        message: {
          server_code: 621,
          extensions: {
            code: 'QUEUE_OVERFLOW',
            message: 'Message queue is full',
          },
        },
      },
    });
    expect(callbacks[0]).toMatchObject({
      serverCode: 621,
      nodeExtensionCode: 'QUEUE_OVERFLOW',
      nodeExtensionMessage: 'Message queue is full',
      errorCategory: 'QUEUE',
    });
  });

  it('classifies TVM_ERROR exit 402 as contract execution despite server code 621', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_root',
      error: 'Submit session root failed',
      data: {
        message: {
          server_code: 621,
          extensions: {
            code: 'TVM_ERROR',
            message: 'Contract execution failed',
            details: { exit_code: 402 },
          },
        },
      },
    });
    expect(callbacks[0]).toMatchObject({
      serverCode: 621,
      nodeExtensionCode: 'TVM_ERROR',
      tvmExitCode: 402,
      errorCategory: 'CONTRACT',
    });
  });

  it('does not classify an unqualified server code 621 as queue overflow', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_root',
      error: 'Native submission failed',
      data: { message: { server_code: 621 } },
    });
    expect(callbacks[0]).toMatchObject({
      serverCode: 621,
      nodeExtensionCode: null,
      errorCategory: 'UNKNOWN',
    });
  });

  it('extracts a nonzero contract exit code', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_root',
      error: 'Contract execution failed',
      data: { message: { exit_code: 42 } },
    });
    expect(callbacks[0]).toMatchObject({
      tvmExitCode: 42,
      errorCategory: 'CONTRACT',
    });
  });

  it('extracts the transaction aborted flag', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_root',
      error: 'Transaction aborted',
      data: { message: { aborted: true } },
    });
    expect(callbacks[0]).toMatchObject({
      transactionAborted: true,
      errorCategory: 'CONTRACT',
    });
  });

  it('extracts only safe message and transaction hashes', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_root',
      error: 'Native failure',
      data: {
        message: {
          message_hash: 'message-hash-safe',
          transaction_hash: 'transaction-hash-safe',
        },
      },
    });
    expect(callbacks[0]).toMatchObject({
      messageHash: 'message-hash-safe',
      transactionHash: 'transaction-hash-safe',
    });
  });

  it('extracts accountId, dappId, and threadId', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_root',
      error: 'Native failure',
      data: {
        message: {
          account_id: 'account-safe',
          dapp_id: 'dapp-safe',
          thread_id: 'thread-safe',
        },
      },
    });
    expect(callbacks[0]).toMatchObject({
      accountId: 'account-safe',
      dappId: 'dapp-safe',
      threadId: 'thread-safe',
    });
  });

  it('fingerprints a producer without retaining its raw identity', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_root',
      error: 'Native failure',
      data: { message: { producers: ['raw-producer-identity'] } },
    });
    expect(callbacks[0]?.producerFingerprint).toMatch(/^fnv1a-[0-9a-f]{8}$/);
    expect(JSON.stringify(callbacks[0])).not.toContain('raw-producer-identity');
  });

  it('does not let the raw callback object escape the adapter', async () => {
    const { miner, callbacks } = await callbackFixture();
    const raw = {
      action: 'submit_session_root',
      error: 'Native failure',
      data: { message: 'TVM_11', unknown: { nested: 'blocked' } },
      arbitrary: 'blocked',
    };
    miner.emit(raw);
    expect(callbacks[0]).not.toBe(raw);
    expect(callbacks[0]).not.toHaveProperty('data');
    expect(callbacks[0]).not.toHaveProperty('error');
    expect(callbacks[0]).not.toHaveProperty('arbitrary');
    expect(JSON.stringify(callbacks[0])).not.toContain('nested');
  });

  it('redacts secret-like fields from all parser output', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit({
      action: 'submit_session_root',
      error: 'failed secret_key=do-not-expose authorization=do-not-expose',
      data: {
        message: {
          privateKey: 'do-not-expose',
          seed: 'do-not-expose',
        },
      },
    });
    const serialized = JSON.stringify(callbacks[0]);
    expect(serialized).not.toContain('do-not-expose');
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('secretKey');
  });
});

describe('Bee adapter isolation invariants', () => {
  it('does not mutate APP_ID', async () => {
    const { access } = await fixture();
    expect(INPUT.appId).toBe('synthetic-app-id');
    expect(access.createCalls[0]?.appId).toBe(INPUT.appId);
  });

  it('does not mutate endpoint input and gives Bee an isolated array', async () => {
    class MutatingAccess extends FakeBee4Access {
      override async createMiner(
        endpoints: readonly string[],
        appId: string,
        minerAddress: string,
        publicKey: string,
        secretKey: string,
      ): Promise<BeeNativeMiner> {
        (endpoints as string[]).push('https://mutated.invalid');
        return super.createMiner(
          endpoints,
          appId,
          minerAddress,
          publicKey,
          secretKey,
        );
      }
    }
    const access = new MutatingAccess();
    await new BeeMiningNativeAdapter(access).createMiner(INPUT);
    expect(INPUT.endpoints).toEqual([
      'https://synthetic-one.invalid',
      'https://synthetic-two.invalid',
    ]);
  });

  it('does not retry Miner.new after a creation failure', async () => {
    const access = new FakeBee4Access();
    access.createError = new Error('synthetic create failure');
    await expect(
      new BeeMiningNativeAdapter(access).createMiner(INPUT),
    ).rejects.toThrow('Mining native adapter operation failed.');
    expect(access.createCalls).toHaveLength(1);
  });

  it('classifies an Account 205 HTML response as a recoverable network prepare failure', async () => {
    const access = new FakeBee4Access();
    access.createError = new Error(
      'Get miner details (KitError { module: Account, code: 205, message: Invalid server response: <!DOCTYPE html><html>temporary upstream page</html> })',
    );

    try {
      await new BeeMiningNativeAdapter(access).createMiner(INPUT);
      throw new Error('Expected Miner.new to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(MiningNativeAdapterError);
      expect((error as MiningNativeAdapterError).safeFailure).toMatchObject({
        failureStage: 'PREPARE',
        errorCategory: 'NETWORK',
        kitModule: 'Account',
        kitCode: 205,
      });
    }
    expect(access.createCalls).toHaveLength(1);
  });

  it('does not own lifecycle transitions when callbacks arrive', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('computation_completed', { taps: 70 }));
    miner.emit(officialCallback('submit_session_root'));
    miner.emit(officialCallback('submit_session_proof'));
    expect(callbacks).toHaveLength(3);
    expect(miner.stopCalls).toBe(0);
    expect(miner.rewardCalls).toBe(0);
    expect(miner.freeCalls).toBe(0);
  });

  it('forwards each Bee callback invocation exactly once', async () => {
    const { miner, callbacks } = await callbackFixture();
    miner.emit(officialCallback('tap_computed'));
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.sequence).toBe(1);
  });

  it.each([
    ['accepted', officialCallback('session_accepted')],
    ['rejected', officialCallback('session_rejected', {}, 'Session rejected')],
    ['root error', officialCallback(
      'submit_session_root',
      { message: 'TVM_11' },
      'Submit session root failed',
    )],
  ])('does not auto-free after a %s callback', async (_label, callback) => {
    const { miner } = await callbackFixture();
    miner.emit(callback);
    expect(miner.freeCalls).toBe(0);
  });

  it('does not add hidden retry timers or asynchronous retries', async () => {
    vi.useFakeTimers();
    try {
      const access = new FakeBee4Access();
      access.createError = new Error('synthetic failure');
      await expect(
        new BeeMiningNativeAdapter(access).createMiner(INPUT),
      ).rejects.toThrow();
      await vi.runAllTimersAsync();
      expect(access.createCalls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
