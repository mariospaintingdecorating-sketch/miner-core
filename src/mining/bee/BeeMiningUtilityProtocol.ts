import type {
  NativeMinerCreationInput,
  SafeMiningFailure,
  SafeNativeCallback,
} from '../WalletMiningRuntime';

export type BeeMiningUtilityOperation =
  | 'create'
  | 'canStart'
  | 'start'
  | 'addTap'
  | 'stop'
  | 'getMinerData'
  | 'getReward'
  | 'free';

export interface BeeMiningUtilityRequest {
  readonly type: 'request';
  readonly requestId: string;
  readonly operation: BeeMiningUtilityOperation;
  readonly handleId: string;
  readonly creation?: Readonly<NativeMinerCreationInput>;
  readonly durationMs?: number;
  readonly callbackSessionId?: string;
  readonly x?: number;
  readonly y?: number;
}

export interface BeeMiningUtilityResponse {
  readonly type: 'response';
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly failure?: Readonly<SafeMiningFailure>;
}

export interface BeeMiningUtilityCallback {
  readonly type: 'callback';
  readonly handleId: string;
  readonly callbackSessionId: string;
  readonly callback: Readonly<SafeNativeCallback>;
}

export type BeeMiningUtilityMessage =
  | BeeMiningUtilityResponse
  | BeeMiningUtilityCallback;

export interface BeeMiningRendererBridge {
  request(request: Readonly<BeeMiningUtilityRequest>): Promise<unknown>;
  onCallback(listener: (message: unknown) => void): () => void;
}
