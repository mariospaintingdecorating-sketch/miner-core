import initializeBeeSdk, { Miner } from '@teamgosh/bee-sdk';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BeeNativeMiner } from '../../services/bee/BeeNativeSdk';
import type { SafeMiningFailure, WalletMiningFailureStage } from '../WalletMiningRuntime';
import { normalizeBeeNativeCallback } from './BeeNativeCallbackParser';
import { normalizeBeeNativeError } from './BeeNativeErrorParser';
import { installBeeUtilityBrowserEnvironment } from './BeeUtilityBrowserEnvironment';
import type {
  BeeMiningUtilityMessage,
  BeeMiningUtilityOperation,
  BeeMiningUtilityRequest,
  BeeMiningUtilityResponse,
} from './BeeMiningUtilityProtocol';

interface BeeUtilityParentPort {
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPortCandidate = (process as NodeJS.Process & {
  readonly parentPort?: BeeUtilityParentPort | null;
}).parentPort;
if (!parentPortCandidate) {
  throw new Error('Bee mining utility requires an Electron parent port.');
}
const port: BeeUtilityParentPort = parentPortCandidate;

const miners = new Map<string, BeeNativeMiner>();
const callbackSequences = new Map<string, number>();
let initialization: Promise<void> | null = null;

port.on('message', (event) => {
  void handleRequest(event.data).then((response) => port.postMessage(response));
});

async function handleRequest(value: unknown): Promise<BeeMiningUtilityResponse> {
  const request = validRequest(value);
  if (!request) {
    return responseFailure('invalid-request', genericFailure(
      'PREPARE',
      'BEE_UTILITY_INVALID_REQUEST',
    ));
  }

  try {
    switch (request.operation) {
      case 'create': {
        const creation = request.creation!;
        await initialize();
        if (miners.has(request.handleId)) {
          throw new Error('Bee mining handle already exists.');
        }
        const miner = await Miner.new(
          [...creation.endpoints],
          creation.appId,
          creation.minerAddress,
          creation.publicKey,
          creation.secretKey,
        );
        miners.set(request.handleId, miner);
        callbackSequences.set(request.handleId, 0);
        return responseSuccess(request.requestId, null);
      }
      case 'canStart':
        return responseSuccess(
          request.requestId,
          ownedMiner(request.handleId).can_start(),
        );
      case 'start': {
        const miner = ownedMiner(request.handleId);
        const callbackSessionId = request.callbackSessionId!;
        miner.start(request.durationMs!, (...nativeArguments: unknown[]) => {
          const sequence = (callbackSequences.get(request.handleId) ?? 0) + 1;
          callbackSequences.set(request.handleId, sequence);
          post(Object.freeze({
            type: 'callback',
            handleId: request.handleId,
            callbackSessionId,
            callback: normalizeBeeNativeCallback(nativeArguments, sequence),
          }));
        });
        return responseSuccess(request.requestId, null);
      }
      case 'addTap':
        ownedMiner(request.handleId).add_tap(request.x!, request.y!);
        return responseSuccess(request.requestId, null);
      case 'stop':
        ownedMiner(request.handleId).stop();
        return responseSuccess(request.requestId, null);
      case 'getMinerData': {
        const miner = ownedMiner(request.handleId);
        if (!miner.get_miner_data) {
          throw new Error('Bee Miner.get_miner_data is unavailable.');
        }
        const data = await miner.get_miner_data();
        try {
          return responseSuccess(request.requestId, Object.freeze({
            tapSum: data.tap_sum.toString(),
          }));
        } finally {
          data.free();
        }
      }
      case 'getReward':
        await ownedMiner(request.handleId).get_reward();
        return responseSuccess(request.requestId, null);
      case 'free': {
        const miner = miners.get(request.handleId);
        miners.delete(request.handleId);
        callbackSequences.delete(request.handleId);
        miner?.free();
        return responseSuccess(request.requestId, null);
      }
    }
  } catch (error) {
    if (request.operation === 'free') {
      miners.delete(request.handleId);
      callbackSequences.delete(request.handleId);
    }
    return responseFailure(
      request.requestId,
      safeOperationFailure(error, request.operation),
    );
  }
}

function initialize(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      installBeeUtilityBrowserEnvironment();
      const require = createRequire(import.meta.url);
      const entry = require.resolve('@teamgosh/bee-sdk');
      const bytes = await readFile(join(dirname(entry), 'bee_sdk_bg.wasm'));
      await initializeBeeSdk({ module_or_path: bytes });
    })();
  }
  return initialization;
}

function ownedMiner(handleId: string): BeeNativeMiner {
  const miner = miners.get(handleId);
  if (!miner) throw new Error('Bee mining handle does not exist.');
  return miner;
}

function safeOperationFailure(
  error: unknown,
  operation: BeeMiningUtilityOperation,
): Readonly<SafeMiningFailure> {
  const failureStage = operationFailureStage(operation);
  const normalized = normalizeBeeNativeError({
    action: `${operation}_failed`,
    status: 'failed',
    rawError: error,
    rawDataMessage: null,
  });
  return Object.freeze({
    failureStage,
    errorCategory: normalized.errorCategory ?? 'UNKNOWN',
    nativeTopLevelMessage: normalized.nativeTopLevelMessage,
    tvmCode: normalized.tvmCode,
    tvmCodeName: normalized.tvmCodeName,
    kitModule: normalized.kitModule,
    kitCode: normalized.kitCode,
    serverCode: normalized.serverCode,
    nodeExtensionCode: normalized.nodeExtensionCode,
    nodeExtensionMessage: normalized.nodeExtensionMessage,
    tvmExitCode: normalized.tvmExitCode,
    transactionAborted: normalized.transactionAborted,
    messageHash: normalized.messageHash,
    transactionHash: normalized.transactionHash,
    accountId: normalized.accountId,
    dappId: normalized.dappId,
    threadId: normalized.threadId,
    producerFingerprint: normalized.producerFingerprint,
    coreVersion: normalized.coreVersion,
  });
}

function operationFailureStage(
  operation: BeeMiningUtilityOperation,
): NonNullable<WalletMiningFailureStage> {
  switch (operation) {
    case 'create':
    case 'canStart':
    case 'start':
    case 'getMinerData':
      return 'PREPARE';
    case 'addTap':
      return 'TAP_EXECUTION';
    case 'stop':
      return 'NATIVE_COMPUTATION';
    case 'getReward':
      return 'REWARD';
    case 'free':
      return 'DISPOSAL';
  }
}

function validRequest(value: unknown): BeeMiningUtilityRequest | null {
  if (!isRecord(value) || value.type !== 'request') return null;
  if (!safeId(value.requestId) || !safeId(value.handleId)) return null;
  if (!isOperation(value.operation)) return null;
  const base = value as unknown as BeeMiningUtilityRequest;
  if (base.operation === 'create' && !validCreation(base.creation)) return null;
  if (
    base.operation === 'start' &&
    (!Number.isSafeInteger(base.durationMs) ||
      base.durationMs! <= 0 ||
      !safeId(base.callbackSessionId))
  ) return null;
  if (
    base.operation === 'addTap' &&
    (!Number.isFinite(base.x) || !Number.isFinite(base.y))
  ) return null;
  return base;
}

function validCreation(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.endpoints)) return false;
  return value.endpoints.length > 0 &&
    value.endpoints.length <= 16 &&
    value.endpoints.every((endpoint) => safeText(endpoint, 2_048)) &&
    safeText(value.appId, 512) &&
    safeText(value.minerAddress, 512) &&
    safeText(value.publicKey, 2_048) &&
    safeText(value.secretKey, 4_096);
}

function isOperation(value: unknown): value is BeeMiningUtilityOperation {
  return typeof value === 'string' && [
    'create',
    'canStart',
    'start',
    'addTap',
    'stop',
    'getMinerData',
    'getReward',
    'free',
  ].includes(value);
}

function responseSuccess(requestId: string, value: unknown): BeeMiningUtilityResponse {
  return Object.freeze({ type: 'response', requestId, ok: true, value });
}

function responseFailure(
  requestId: string,
  failure: Readonly<SafeMiningFailure>,
): BeeMiningUtilityResponse {
  return Object.freeze({ type: 'response', requestId, ok: false, failure });
}

function genericFailure(
  failureStage: NonNullable<WalletMiningFailureStage>,
  errorCategory: string,
): Readonly<SafeMiningFailure> {
  return Object.freeze({ failureStage, errorCategory });
}

function post(message: Readonly<BeeMiningUtilityMessage>): void {
  port.postMessage(message);
}

function safeId(value: unknown): value is string {
  return safeText(value, 256);
}

function safeText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
