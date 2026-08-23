import type { IpcMain, WebContents } from 'electron';

export const BEE_MINING_UTILITY_CHANNELS = Object.freeze({
  request: 'bee-mining-utility:request',
  callback: 'bee-mining-utility:callback',
});

interface UtilityProcessLike {
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}

type UtilityProcessFactory = () => UtilityProcessLike;

interface PendingRequest {
  readonly publicRequestId: string;
  readonly operation: string;
  readonly handleId: string;
  resolve(response: Readonly<Record<string, unknown>>): void;
}

interface HandleOwner {
  readonly sender: WebContents;
  lastSequence: number;
  activeCallbackSessionId: string | null;
}

interface ValidatedRequest extends Record<string, unknown> {
  readonly type: 'request';
  readonly requestId: string;
  readonly operation: string;
  readonly handleId: string;
}

export class BeeMiningUtilitySupervisor {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #owners = new Map<string, HandleOwner>();
  readonly #terminatedOwners = new Map<string, HandleOwner>();
  #process: UtilityProcessLike | null = null;
  #requestSequence = 0;
  #disposed = false;

  constructor(private readonly forkProcess: UtilityProcessFactory) {}

  async request(sender: WebContents, value: unknown): Promise<unknown> {
    const request = validRequest(value);
    if (!request || this.#disposed) {
      return failureResponse(
        request?.requestId ?? 'invalid-request',
        operationStage(request?.operation),
        this.#disposed
          ? 'BEE_UTILITY_DISPOSED'
          : 'BEE_UTILITY_INVALID_REQUEST',
      );
    }
    const owner = this.#owners.get(request.handleId);
    const terminatedOwner = this.#terminatedOwners.get(request.handleId);
    if (terminatedOwner?.sender === sender) {
      if (request.operation === 'free') {
        this.#terminatedOwners.delete(request.handleId);
        return Object.freeze({
          type: 'response',
          requestId: request.requestId,
          ok: true,
          value: null,
        });
      }
      return failureResponse(
        request.requestId,
        operationStage(request.operation),
        'BEE_UTILITY_PROCESS_EXIT',
      );
    }
    if (request.operation !== 'create' && owner?.sender !== sender) {
      return failureResponse(
        request.requestId,
        operationStage(request.operation),
        'BEE_UTILITY_HANDLE_NOT_OWNED',
      );
    }

    const callbackSessionId = request.operation === 'start'
      ? safeText(request.callbackSessionId, 256)
      : null;
    const previousCallbackSessionId = owner?.activeCallbackSessionId ?? null;
    if (callbackSessionId && owner) {
      // Register ownership before the utility receives start. Bee may emit a
      // callback before the corresponding start response reaches Electron.
      owner.activeCallbackSessionId = callbackSessionId;
    }

    const internalRequestId = `utility:${++this.#requestSequence}`;
    const process = this.#ensureProcess();
    const responsePromise = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      this.#pending.set(internalRequestId, {
        publicRequestId: request.requestId,
        operation: request.operation,
        handleId: request.handleId,
        resolve,
      });
    });
    process.postMessage(Object.freeze({
      ...request,
      requestId: internalRequestId,
    }));

    try {
      const response = await responsePromise;
      if (request.operation === 'create' && response.ok === true) {
        if (this.#process !== process) {
          return failureResponse(
            request.requestId,
            'PREPARE',
            'BEE_UTILITY_PROCESS_EXIT',
          );
        }
        this.#owners.set(request.handleId, {
          sender,
          lastSequence: 0,
          activeCallbackSessionId: null,
        });
      }
      if (
        request.operation === 'start' &&
        response.ok !== true &&
        owner?.activeCallbackSessionId === callbackSessionId
      ) {
        owner.activeCallbackSessionId = previousCallbackSessionId;
      }
      return response;
    } finally {
      if (request.operation === 'free') this.#owners.delete(request.handleId);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const process = this.#process;
    this.#process = null;
    process?.kill();
    for (const pending of this.#pending.values()) {
      pending.resolve(failureResponse(
        pending.publicRequestId,
        operationStage(pending.operation),
        'BEE_UTILITY_DISPOSED',
      ));
    }
    this.#pending.clear();
    this.#owners.clear();
    this.#terminatedOwners.clear();
  }

  #ensureProcess(): UtilityProcessLike {
    if (this.#process) return this.#process;
    const process = this.forkProcess();
    this.#process = process;
    process.on('message', (message) => this.#receive(process, message));
    process.on('exit', () => this.#handleExit(process));
    return process;
  }

  #receive(process: UtilityProcessLike, value: unknown): void {
    if (process !== this.#process || !isRecord(value)) return;
    if (value.type === 'response') {
      const requestId = safeText(value.requestId, 256);
      if (!requestId) return;
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      this.#pending.delete(requestId);
      pending.resolve(safeResponse(value, pending));
      return;
    }
    if (value.type !== 'callback') return;
    const handleId = safeText(value.handleId, 256);
    const callbackSessionId = safeText(value.callbackSessionId, 256);
    const callback = safeCallback(value.callback);
    if (!handleId || !callbackSessionId || !callback) return;
    const owner = this.#owners.get(handleId);
    if (
      !owner ||
      owner.sender.isDestroyed() ||
      owner.activeCallbackSessionId !== callbackSessionId
    ) return;
    owner.lastSequence = callback.sequence as number;
    owner.sender.send(BEE_MINING_UTILITY_CHANNELS.callback, Object.freeze({
      type: 'callback',
      handleId,
      callbackSessionId,
      callback,
    }));
    if (isTerminalCallback(callback)) {
      owner.activeCallbackSessionId = null;
    }
  }

  #handleExit(process: UtilityProcessLike): void {
    if (process !== this.#process) return;
    this.#process = null;
    const freedHandles = new Set<string>();
    for (const pending of this.#pending.values()) {
      if (pending.operation === 'free') {
        freedHandles.add(pending.handleId);
        pending.resolve(Object.freeze({
          type: 'response',
          requestId: pending.publicRequestId,
          ok: true,
          value: null,
        }));
      } else {
        pending.resolve(failureResponse(
          pending.publicRequestId,
          operationStage(pending.operation),
          'BEE_UTILITY_PROCESS_EXIT',
        ));
      }
    }
    this.#pending.clear();
    for (const [handleId, owner] of this.#owners) {
      if (owner.sender.isDestroyed()) continue;
      if (!freedHandles.has(handleId)) this.#terminatedOwners.set(handleId, owner);
      const callbackSessionId = owner.activeCallbackSessionId;
      if (!callbackSessionId) continue;
      owner.sender.send(BEE_MINING_UTILITY_CHANNELS.callback, Object.freeze({
        type: 'callback',
        handleId,
        callbackSessionId,
        callback: Object.freeze({
          action: 'native_error',
          sequence: owner.lastSequence + 1,
          status: 'failed',
          errorPresent: true,
          failureStage: 'NATIVE_COMPUTATION',
          errorCategory: 'BEE_UTILITY_PROCESS_EXIT',
        }),
      }));
    }
    this.#owners.clear();
  }

}

export function registerBeeMiningUtilityHandlers(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  supervisor: BeeMiningUtilitySupervisor,
  isAuthorizedSender: (sender: WebContents) => boolean,
): () => void {
  ipc.handle(BEE_MINING_UTILITY_CHANNELS.request, (event, request: unknown) => {
    if (!isAuthorizedSender(event.sender)) {
      return failureResponse(
        'unauthorized-request',
        'PREPARE',
        'BEE_UTILITY_UNAUTHORIZED_RENDERER',
      );
    }
    return supervisor.request(event.sender, request);
  });
  return () => ipc.removeHandler(BEE_MINING_UTILITY_CHANNELS.request);
}

function validRequest(value: unknown): ValidatedRequest | null {
  if (!isRecord(value) || value.type !== 'request') return null;
  if (
    !safeText(value.requestId, 256) ||
    !safeText(value.handleId, 256) ||
    !isOperation(value.operation)
  ) return null;
  if (value.operation === 'create' && !validCreation(value.creation)) return null;
  if (
    value.operation === 'start' &&
    (!Number.isSafeInteger(value.durationMs) ||
      Number(value.durationMs) <= 0 ||
      !safeText(value.callbackSessionId, 256))
  ) return null;
  if (
    value.operation === 'addTap' &&
    (!Number.isFinite(value.x) || !Number.isFinite(value.y))
  ) return null;
  return value as ValidatedRequest;
}

function validCreation(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.endpoints)) return false;
  return value.endpoints.length > 0 && value.endpoints.length <= 16 &&
    value.endpoints.every((endpoint) => Boolean(safeText(endpoint, 2_048))) &&
    Boolean(safeText(value.appId, 512)) &&
    Boolean(safeText(value.minerAddress, 512)) &&
    Boolean(safeText(value.publicKey, 2_048)) &&
    Boolean(safeText(value.secretKey, 4_096));
}

function safeResponse(
  value: Record<string, unknown>,
  pending: PendingRequest,
): Readonly<Record<string, unknown>> {
  if (value.ok === true) {
    return Object.freeze({
      type: 'response',
      requestId: pending.publicRequestId,
      ok: true,
      value: safeResponseValue(pending.operation, value.value),
    });
  }
  return Object.freeze({
    type: 'response',
    requestId: pending.publicRequestId,
    ok: false,
    failure: safeFailure(
      value.failure,
      operationStage(pending.operation),
      'BEE_UTILITY_FAILURE',
    ),
  });
}

function safeResponseValue(operation: string, value: unknown): unknown {
  if (operation === 'canStart') return typeof value === 'boolean' ? value : null;
  if (operation === 'getMinerData' && isRecord(value)) {
    const tapSum = safeText(value.tapSum, 80);
    return tapSum && /^\d+$/.test(tapSum) ? Object.freeze({ tapSum }) : null;
  }
  return null;
}

function safeCallback(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  const action = safeText(value.action, 80);
  const sequence = safeInteger(value.sequence);
  if (!action || sequence === null || sequence < 1) return null;
  const errorPresent = safeBoolean(value.errorPresent) ?? false;
  return Object.freeze({
    action,
    sequence,
    status: safeText(value.status, 80),
    computationCompletedTaps: safeInteger(value.computationCompletedTaps),
    errorPresent,
    ...(errorPresent
      ? safeFailure(value, operationStage(value.failureStage), 'UNKNOWN')
      : {}),
  });
}

function isTerminalCallback(
  callback: Readonly<Record<string, unknown>>,
): boolean {
  const action = safeText(callback.action, 80)?.toLowerCase();
  const status = safeText(callback.status, 80)?.toLowerCase();
  if (action === 'submit_session_root' || action === 'submit_session_proof') {
    return false;
  }
  return action === 'session_accepted' ||
    action === 'session_rejected' ||
    action === 'native_error' ||
    status === 'accepted' ||
    status === 'rejected' ||
    status === 'failed' ||
    status === 'error';
}

function safeFailure(
  value: unknown,
  fallbackStage: string,
  fallbackCategory: string,
): Readonly<Record<string, unknown>> {
  const source = isRecord(value) ? value : {};
  return Object.freeze({
    failureStage: operationStage(source.failureStage || fallbackStage),
    errorCategory: safeText(source.errorCategory, 80) ?? fallbackCategory,
    nativeTopLevelMessage: safeText(source.nativeTopLevelMessage, 240),
    tvmCode: safeInteger(source.tvmCode),
    tvmCodeName: safeText(source.tvmCodeName, 80),
    kitModule: safeText(source.kitModule, 80),
    kitCode: safeCode(source.kitCode),
    serverCode: safeCode(source.serverCode),
    nodeExtensionCode: safeText(source.nodeExtensionCode, 80),
    nodeExtensionMessage: safeText(source.nodeExtensionMessage, 240),
    tvmExitCode: safeInteger(source.tvmExitCode),
    transactionAborted: safeBoolean(source.transactionAborted),
    messageHash: safeText(source.messageHash, 160),
    transactionHash: safeText(source.transactionHash, 160),
    accountId: safeText(source.accountId, 160),
    dappId: safeText(source.dappId, 160),
    threadId: safeText(source.threadId, 160),
    producerFingerprint: safeText(source.producerFingerprint, 160),
    coreVersion: safeText(source.coreVersion, 80),
  });
}

function failureResponse(
  requestId: string,
  failureStage: string,
  errorCategory: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'response',
    requestId,
    ok: false,
    failure: Object.freeze({ failureStage, errorCategory }),
  });
}

function operationStage(operation: unknown): string {
  switch (operation) {
    case 'addTap':
    case 'TAP_EXECUTION': return 'TAP_EXECUTION';
    case 'stop':
    case 'NATIVE_COMPUTATION': return 'NATIVE_COMPUTATION';
    case 'getReward':
    case 'REWARD': return 'REWARD';
    case 'free':
    case 'DISPOSAL': return 'DISPOSAL';
    case 'PREPARE': return 'PREPARE';
    case 'ROOT_SUBMIT': return 'ROOT_SUBMIT';
    case 'PROOF_SUBMIT': return 'PROOF_SUBMIT';
    case 'WAITING_RESULT': return 'WAITING_RESULT';
    default: return 'PREPARE';
  }
}

function isOperation(value: unknown): value is string {
  return typeof value === 'string' && [
    'create', 'canStart', 'start', 'addTap', 'stop',
    'getMinerData', 'getReward', 'free',
  ].includes(value);
}

function safeText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function safeCode(value: unknown): number | string | null {
  return safeInteger(value) ?? safeText(value, 80);
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
