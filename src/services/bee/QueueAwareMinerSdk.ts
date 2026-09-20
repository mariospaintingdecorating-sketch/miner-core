import initialize, { Miner } from '@msii/bee-miner';
import wasmUrl from '@msii/bee-miner/bee_miner_bg.wasm?url';
import { mobileContractAddress } from '../../shared/chainIdentity';
import type { BeeNativeMiner } from './BeeNativeSdk';
let initialization: Promise<unknown> | null = null;
export async function createQueueAwareMiner(endpoints: readonly string[], appId: string, address: string,
  publicKey: string, secretKey: string): Promise<BeeNativeMiner> {
  initialization ??= initialize({ module_or_path: wasmUrl }).catch((error: unknown) => { initialization = null; throw error; });
  await initialization;
  return Miner.new([...endpoints], appId, mobileContractAddress(address), publicKey, secretKey);
}
