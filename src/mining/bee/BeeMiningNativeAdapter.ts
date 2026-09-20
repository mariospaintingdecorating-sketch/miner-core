import type {
  BeeNativeMiner,
  BeeNativeMinerData,
  BeeNativeSdkFactory,
} from '../../services/bee/BeeNativeSdk';
import type { BeeSdkRuntimeAdapter } from '../../services/bee/contracts';
import { TeamGoshBeeNativeSdk } from '../../services/bee/BeeNativeSdk';
import { TeamGoshBeeSdkRuntimeAdapter } from '../../services/bee/TeamGoshBeeSdkRuntimeAdapter';
import type {
  MiningNativeAdapter,
  NativeMinerCreationInput,
  NativeMinerData,
  NativeMinerHandle,
  SafeNativeCallbackListener,
} from '../WalletMiningRuntime';
import { normalizeBeeNativeCallback } from './BeeNativeCallbackParser';
import { beeMiningNativeAdapterError } from './BeeNativeErrorParser';

export interface BeeMiningNativeSdkAccess {
  initialize(): Promise<void>;
  createMiner(
    endpoints: readonly string[],
    appId: string,
    minerAddress: string,
    publicKey: string,
    secretKey: string,
  ): Promise<BeeNativeMiner>;
}

/** Official Bee SDK bindings only; it owns no Miner or wallet lifecycle state. */
export class TeamGoshBeeMiningNativeSdkAccess
  implements BeeMiningNativeSdkAccess
{
  readonly #runtime: Pick<BeeSdkRuntimeAdapter, 'initialize'>;
  readonly #nativeSdk: BeeNativeSdkFactory;

  constructor(
    runtime: Pick<BeeSdkRuntimeAdapter, 'initialize'> =
      new TeamGoshBeeSdkRuntimeAdapter(),
    nativeSdk: BeeNativeSdkFactory = new TeamGoshBeeNativeSdk(),
  ) {
    this.#runtime = runtime;
    this.#nativeSdk = nativeSdk;
  }

  initialize(): Promise<void> {
    return this.#runtime.initialize();
  }

  createMiner(
    endpoints: readonly string[],
    appId: string,
    minerAddress: string,
    publicKey: string,
    secretKey: string,
  ): Promise<BeeNativeMiner> {
    return this.#nativeSdk.createMiner(
      endpoints,
      appId,
      minerAddress,
      publicKey,
      secretKey,
    );
  }
}

/** Official Bee SDK translation boundary for the WalletMiningWorker contract. */
export class BeeMiningNativeAdapter implements MiningNativeAdapter {
  #initialization: Promise<void> | null = null;

  constructor(
    private readonly sdk: BeeMiningNativeSdkAccess =
      new TeamGoshBeeMiningNativeSdkAccess(),
  ) {}

  async createMiner(
    input: Readonly<NativeMinerCreationInput>,
  ): Promise<NativeMinerHandle> {
    await this.#initialize();
    try {
      const miner = await this.sdk.createMiner(
        [...input.endpoints],
        input.appId,
        input.minerAddress,
        input.publicKey,
        input.secretKey,
      );
      return new BeeMiningNativeHandle(miner);
    } catch (error) {
      throw beeMiningNativeAdapterError(error, 'PREPARE');
    }
  }

  #initialize(): Promise<void> {
    if (!this.#initialization) {
      this.#initialization = this.sdk.initialize().catch((error: unknown) => {
        throw beeMiningNativeAdapterError(error, 'PREPARE');
      });
    }
    return this.#initialization;
  }
}

class BeeMiningNativeHandle implements NativeMinerHandle {
  #callbackSequence = 0;
  #freed = false;

  constructor(private miner: BeeNativeMiner | null) {}

  canStart(): boolean {
    try {
      return this.#ownedMiner('PREPARE').can_start();
    } catch (error) {
      throw beeMiningNativeAdapterError(error, 'PREPARE');
    }
  }

  start(durationMs: number, listener: SafeNativeCallbackListener): void {
    try {
      this.#ownedMiner('PREPARE').start(durationMs, (...nativeArguments: unknown[]) => {
        if (this.#freed) return;
        this.#callbackSequence += 1;
        listener(normalizeBeeNativeCallback(
          nativeArguments,
          this.#callbackSequence,
        ));
      });
    } catch (error) {
      throw beeMiningNativeAdapterError(error, 'PREPARE');
    }
  }

  addTap(x: number, y: number): void {
    try {
      this.#ownedMiner('TAP_EXECUTION').add_tap(x, y);
    } catch (error) {
      throw beeMiningNativeAdapterError(error, 'TAP_EXECUTION');
    }
  }

  stop(): void {
    try {
      this.#ownedMiner('NATIVE_COMPUTATION').stop();
    } catch (error) {
      throw beeMiningNativeAdapterError(error, 'NATIVE_COMPUTATION');
    }
  }

  async getMinerData(): Promise<NativeMinerData> {
    const miner = this.#ownedMiner('PREPARE');
    if (!miner.get_miner_data) {
      throw beeMiningNativeAdapterError(
        new Error('Bee Miner.get_miner_data is unavailable.'),
        'PREPARE',
      );
    }
    try {
      const data = await miner.get_miner_data();
      return neutralMinerData(data);
    } catch (error) {
      throw beeMiningNativeAdapterError(error, 'PREPARE');
    }
  }

  async getReward(): Promise<void> {
    try {
      await this.#ownedMiner('REWARD').get_reward();
    } catch (error) {
      throw beeMiningNativeAdapterError(error, 'REWARD');
    }
  }

  free(): void {
    if (this.#freed) return;
    this.#freed = true;
    const miner = this.miner;
    this.miner = null;
    if (!miner) return;
    try {
      miner.free();
    } catch (error) {
      throw beeMiningNativeAdapterError(error, 'DISPOSAL');
    }
  }

  #ownedMiner(
    stage: Parameters<typeof beeMiningNativeAdapterError>[1],
  ): BeeNativeMiner {
    if (this.miner && !this.#freed) return this.miner;
    throw beeMiningNativeAdapterError(
      new Error('Bee Miner handle has already been freed.'),
      stage,
    );
  }
}

function neutralMinerData(data: BeeNativeMinerData): Readonly<NativeMinerData> {
  return Object.freeze({
    tapSum: data.tap_sum,
    free: () => data.free(),
  });
}
