import {
  BeeConnect,
  Crypto,
  Miner,
  ensure_mining_keys_propagated,
  get_miner_address_by_wallet_name,
} from '@teamgosh/bee-sdk';
import type { BeeSdkOwnedResource } from './contracts';

export interface BeeNativeSharedKeySession extends BeeSdkOwnedResource {
  readonly client_dh_secret: string;
  readonly created_at: bigint;
  readonly deep_link: string;
  readonly description: string;
  readonly expires_at: bigint;
  readonly session_id: string;
}

export interface BeeNativeWalletHello extends BeeSdkOwnedResource {
  readonly session_state_json: string;
  readonly wallet_address: string;
  readonly wallet_name: string;
}

export interface BeeNativeSessionUpdate extends BeeSdkOwnedResource {
  readonly updated_session_state_json: string;
}

export interface BeeNativeMiningKeys extends BeeSdkOwnedResource {
  readonly public: string;
  readonly secret: string;
}

export interface BeeNativeConnect extends BeeSdkOwnedResource {
  create_shared_key_session(
    appId: string,
    ttlSeconds?: number | null,
    nonce?: string | null,
  ): BeeNativeSharedKeySession;
  wait_wallet_hello(
    endpoints: string[],
    sessionId: string,
    description: string,
    clientDhSecret: string,
    createdAtFrom?: bigint | null,
    maxAttempts?: number | null,
    intervalMs?: number | null,
  ): Promise<BeeNativeWalletHello>;
  request_set_mining_keys(
    endpoints: string[],
    sessionId: string,
    description: string,
    sessionStateJson: string,
    appId: string,
    ownerPublic: string,
    maxAttempts?: number | null,
    intervalMs?: number | null,
  ): Promise<BeeNativeSessionUpdate>;
  disconnect_session(
    endpoints: string[],
    sessionId: string,
    description: string,
    sessionStateJson: string,
    reason?: string | null,
    maxAttempts?: number | null,
    intervalMs?: number | null,
  ): Promise<BeeNativeSessionUpdate>;
}

export interface BeeNativeMinerData extends BeeSdkOwnedResource {
  readonly tap_sum: bigint;
  readonly tap_sum_5m: bigint;
}

export interface BeeNativeMiner extends BeeSdkOwnedResource {
  add_tap(x: number, y: number): void;
  can_start(): boolean;
  get_miner_data?(): Promise<BeeNativeMinerData>;
  get_reward(): Promise<void>;
  start(durationMs: number, callback: (...args: unknown[]) => void): void;
  stop(): void;
}

export interface BeeNativeSdkFactory {
  createConnect(): BeeNativeConnect;
  generateMiningKeys(endpoints: readonly string[]): Promise<BeeNativeMiningKeys>;
  resolveMinerAddress(endpoints: readonly string[], walletName: string): Promise<string>;
  ensureMiningKeysPropagated(
    endpoints: readonly string[],
    appId: string,
    minerAddress: string,
    expectedOwnerPublic: string,
    maxAttempts?: number,
    intervalMs?: number,
  ): Promise<void>;
  createMiner(
    endpoints: readonly string[],
    appId: string,
    address: string,
    publicKey: string,
    secretKey: string,
  ): Promise<BeeNativeMiner>;
}

/** Direct @teamgosh/bee-sdk object factory. It owns no lifecycle decisions. */
export class TeamGoshBeeNativeSdk implements BeeNativeSdkFactory {
  createConnect(): BeeNativeConnect {
    return new BeeConnect();
  }

  async generateMiningKeys(
    endpoints: readonly string[],
  ): Promise<BeeNativeMiningKeys> {
    const crypto = new Crypto([...endpoints]);

    try {
      return await crypto.gen_mining_keys();
    } finally {
      crypto.free();
    }
  }

  resolveMinerAddress(
    endpoints: readonly string[],
    walletName: string,
  ): Promise<string> {
    return get_miner_address_by_wallet_name({
      client_config: { network: { endpoints: [...endpoints] } },
      wallet_name: walletName,
    });
  }

  ensureMiningKeysPropagated(
    endpoints: readonly string[],
    appId: string,
    minerAddress: string,
    expectedOwnerPublic: string,
    maxAttempts?: number,
    intervalMs?: number,
  ): Promise<void> {
    return ensure_mining_keys_propagated({
      client_config: { network: { endpoints: [...endpoints] } },
      miner_address: minerAddress,
      app_id: appId,
      expected_owner_public: expectedOwnerPublic,
      max_attempts: maxAttempts,
      interval_ms: intervalMs,
    });
  }

  createMiner(
    endpoints: readonly string[],
    appId: string,
    address: string,
    publicKey: string,
    secretKey: string,
  ): Promise<BeeNativeMiner> {
    return Miner.new([...endpoints], appId, address, publicKey, secretKey);
  }
}
