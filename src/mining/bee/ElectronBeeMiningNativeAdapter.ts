import {
  MiningNativeAdapterError,
  type MiningNativeAdapter,
  type NativeMinerCreationInput,
  type NativeMinerData,
  type NativeMinerHandle,
  type SafeMiningFailure,
  type SafeNativeCallback,
  type SafeNativeCallbackListener,
  type WalletMiningFailureStage,
} from '../WalletMiningRuntime';
import type {
  BeeMiningRendererBridge,
  BeeMiningUtilityOperation,
  BeeMiningUtilityRequest,
} from './BeeMiningUtilityProtocol';

/** Renderer-side handle proxy. Bee Miner and its WASM memory never enter the UI process. */
export class ElectronBeeMiningNativeAdapter implements MiningNativeAdapter {
  readonly #listeners = new Map<
    string,
    Map<string, SafeNativeCallbackListener>
  >();
  readonly #unsubscribe: () => void;

  constructor(private readonly bridge: Readonly<BeeMiningRendererBridge>) {
    this.#unsubscribe = bridge.onCallback((message) => this.#receive(message));
  }

  async createMiner(
    input: Readonly<NativeMinerCreationInput>,
  ): Promise<NativeMinerHandle> {
    const handleId = globalThis.crypto.randomUUID();
    await this.#request('create', handleId, 'PREPARE', { creation: input });
    return new ElectronBeeMiningNativeHandle(
      handleId,
      (operation, stage, fields) =>
        this.#request(operation, handleId, stage, fields),
      (callbackSessionId, listener) =>
        this.#setListener(handleId, callbackSessionId, listener),
      (callbackSessionId) => this.#clearListener(handleId, callbackSessionId),
    );
  }

  dispose(): void {
    this.#listeners.clear();
    this.#unsubscribe();
  }

  async #request(
    operation: BeeMiningUtilityOperation,
    handleId: string,
    stage: NonNullable<WalletMiningFailureStage>,
    fields: Partial<BeeMiningUtilityRequest> = {},
  ): Promise<unknown> {
    const response = await this.bridge.request(Object.freeze({
      type: 'request',
      requestId: globalThis.crypto.randomUUID(),
      operation,
      handleId,
      ...fields,
    }));
    return unwrapResponse(response, stage);
  }

  #receive(message: unknown): void {
    if (!isRecord(message) || message.type !== 'callback') return;
    const handleId = safeString(message.handleId, 256);
    const callbackSessionId = safeString(message.callbackSessionId, 256);
    if (!handleId || !callbackSessionId) return;
    const callback = safeCallback(message.callback);
    if (!callback) return;
    const listeners = this.#listeners.get(handleId);
    listeners?.get(callbackSessionId)?.(callback);
    if (isTerminalCallback(callback)) {
      listeners?.delete(callbackSessionId);
      if (listeners?.size === 0) this.#listeners.delete(handleId);
    }
  }

  #setListener(
    handleId: string,
    callbackSessionId: string,
    listener: SafeNativeCallbackListener,
  ): void {
    const listeners = this.#listeners.get(handleId) ?? new Map();
    listeners.set(callbackSessionId, listener);
    while (listeners.size > 4) {
      const oldest = listeners.keys().next().value as string | undefined;
      if (!oldest) break;
      listeners.delete(oldest);
    }
    this.#listeners.set(handleId, listeners);
  }

  #clearListener(handleId: string, callbackSessionId?: string): void {
    if (!callbackSessionId) {
      this.#listeners.delete(handleId);
      return;
    }
    const listeners = this.#listeners.get(handleId);
    listeners?.delete(callbackSessionId);
    if (listeners?.size === 0) this.#listeners.delete(handleId);
  }
}

class ElectronBeeMiningNativeHandle implements NativeMinerHandle {
  #freed = false;

  constructor(
    private readonly handleId: string,
    private readonly request: (
      operation: BeeMiningUtilityOperation,
      stage: NonNullable<WalletMiningFailureStage>,
      fields?: Partial<BeeMiningUtilityRequest>,
    ) => Promise<unknown>,
    private readonly setListener: (
      callbackSessionId: string,
      listener: SafeNativeCallbackListener,
    ) => void,
    private readonly clearListener: (callbackSessionId?: string) => void,
  ) {}

  async canStart(): Promise<boolean> {
    const result = await this.#ownedRequest('canStart', 'PREPARE');
    if (typeof result !== 'boolean') throw protocolError('PREPARE');
    return result;
  }

  async start(
    durationMs: number,
    listener: SafeNativeCallbackListener,
  ): Promise<void> {
    this.#assertOwned('PREPARE');
    const callbackSessionId = globalThis.crypto.randomUUID();
    this.setListener(callbackSessionId, listener);
    try {
      await this.request('start', 'PREPARE', {
        durationMs,
        callbackSessionId,
      });
    } catch (error) {
      this.clearListener(callbackSessionId);
      throw error;
    }
  }

  async addTap(x: number, y: number): Promise<void> {
    await this.#ownedRequest('addTap', 'TAP_EXECUTION', { x, y });
  }

  async stop(): Promise<void> {
    await this.#ownedRequest('stop', 'NATIVE_COMPUTATION');
  }

  async getMinerData(): Promise<NativeMinerData> {
    const result = await this.#ownedRequest('getMinerData', 'PREPARE');
    if (!isRecord(result) || !/^-?\d+$/.test(String(result.tapSum))) {
      throw protocolError('PREPARE');
    }
    return Object.freeze({
      tapSum: BigInt(String(result.tapSum)),
      free: () => undefined,
    });
  }

  async getReward(): Promise<void> {
    await this.#ownedRequest('getReward', 'REWARD');
  }

  async free(): Promise<void> {
    if (this.#freed) return;
    this.#freed = true;
    try {
      await this.request('free', 'DISPOSAL');
    } finally {
      this.clearListener();
    }
  }

  #ownedRequest(
    operation: BeeMiningUtilityOperation,
    stage: NonNullable<WalletMiningFailureStage>,
    fields?: Partial<BeeMiningUtilityRequest>,
  ): Promise<unknown> {
    this.#assertOwned(stage);
    return this.request(operation, stage, fields);
  }

  #assertOwned(stage: NonNullable<WalletMiningFailureStage>): void {
    if (this.#freed) throw new MiningNativeAdapterError({
      failureStage: stage,
      errorCategory: 'BEE_UTILITY_HANDLE_FREED',
    });
  }
}

function unwrapResponse(
  value: unknown,
  stage: NonNullable<WalletMiningFailureStage>,
): unknown {
  if (!isRecord(value) || value.type !== 'response') throw protocolError(stage);
  if (value.ok === true) return value.value;
  const failure = safeFailure(value.failure, stage);
  throw new MiningNativeAdapterError(failure);
}

function safeFailure(
  value: unknown,
  fallbackStage: NonNullable<WalletMiningFailureStage>,
): Readonly<SafeMiningFailure> {
  if (!isRecord(value)) return genericFailure(fallbackStage);
  return Object.freeze({
    failureStage: safeFailureStage(value.failureStage) ?? fallbackStage,
    errorCategory: safeString(value.errorCategory, 80) ?? 'BEE_UTILITY_FAILURE',
    nativeTopLevelMessage: safeString(value.nativeTopLevelMessage, 240),
    tvmCode: safeNumber(value.tvmCode),
    tvmCodeName: safeString(value.tvmCodeName, 80),
    kitModule: safeString(value.kitModule, 80),
    kitCode: safeCode(value.kitCode),
    serverCode: safeCode(value.serverCode),
    nodeExtensionCode: safeString(value.nodeExtensionCode, 80),
    nodeExtensionMessage: safeString(value.nodeExtensionMessage, 240),
    tvmExitCode: safeNumber(value.tvmExitCode),
    transactionAborted: safeBoolean(value.transactionAborted),
    messageHash: safeString(value.messageHash, 160),
    transactionHash: safeString(value.transactionHash, 160),
    accountId: safeString(value.accountId, 160),
    dappId: safeString(value.dappId, 160),
    threadId: safeString(value.threadId, 160),
    producerFingerprint: safeString(value.producerFingerprint, 160),
    coreVersion: safeString(value.coreVersion, 80),
  });
}

function safeCallback(value: unknown): Readonly<SafeNativeCallback> | null {
  if (!isRecord(value)) return null;
  const action = safeString(value.action, 80);
  const sequence = safeNumber(value.sequence);
  if (!action || sequence === null || sequence < 1) return null;
  const errorPresent = safeBoolean(value.errorPresent) ?? false;
  const failure = errorPresent
    ? safeFailure(value, safeFailureStage(value.failureStage) ?? 'WAITING_RESULT')
    : null;
  return Object.freeze({
    action,
    sequence,
    status: safeString(value.status, 80),
    computationCompletedTaps: safeNumber(value.computationCompletedTaps),
    errorPresent,
    ...(failure ?? {}),
  });
}

function protocolError(
  stage: NonNullable<WalletMiningFailureStage>,
): MiningNativeAdapterError {
  return new MiningNativeAdapterError(genericFailure(stage));
}

function genericFailure(
  failureStage: NonNullable<WalletMiningFailureStage>,
): Readonly<SafeMiningFailure> {
  return Object.freeze({ failureStage, errorCategory: 'BEE_UTILITY_PROTOCOL' });
}

function safeFailureStage(value: unknown): WalletMiningFailureStage {
  return typeof value === 'string' && [
    'PREPARE', 'TAP_EXECUTION', 'NATIVE_COMPUTATION', 'ROOT_SUBMIT',
    'PROOF_SUBMIT', 'WAITING_RESULT', 'REWARD', 'DISPOSAL',
  ].includes(value) ? value as WalletMiningFailureStage : null;
}

function safeString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function safeCode(value: unknown): number | string | null {
  return safeNumber(value) ?? safeString(value, 80);
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalCallback(callback: Readonly<SafeNativeCallback>): boolean {
  const action = callback.action.trim().toLowerCase();
  const status = callback.status?.trim().toLowerCase() ?? '';
  if (action === 'submit_session_root' || action === 'submit_session_proof') {
    return false;
  }
  return action === 'session_accepted' ||
    action === 'session_rejected' ||
    action === 'native_error' ||
    status === 'error' ||
    status === 'failed';
}
