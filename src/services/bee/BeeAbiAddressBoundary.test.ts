import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_APPLICATION_ID as APP, MOBILE_VERIFIERS_DAPP_ID as DAPP, mobileAbiAddress, mobileContractAddress } from '../../shared/chainIdentity';
import { TeamGoshDirectWalletAuthorizationSdk } from './DirectWalletAuthorizationSdk';
import { TeamGoshBeeNativeSdk } from './BeeNativeSdk';
import { BeeWalletBalanceSource } from './BeeWalletBalanceSource';
import { BeeSdkGateway } from './BeeSdkGateway';
import { createQueueAwareMiner } from './QueueAwareMinerSdk';
const native = vi.hoisted(() => ({ verify: vi.fn(), address: vi.fn(), balances: vi.fn(), details: vi.fn(), free: vi.fn(), minerNew: vi.fn() }));
vi.mock('@teamgosh/bee-sdk', () => ({
  ensure_mining_keys_propagated: native.verify,
  get_miner_address_by_wallet_name: vi.fn(),
  gen_mining_keys: vi.fn(), Crypto: class {}, BeeConnect: class {},
  Wallet: class { free=native.free; get_multifactor_data_by_name=native.details; get_miner_address=native.address; get_multifactor_balances=native.balances; },
}));
vi.mock('@msii/bee-miner', () => ({ default: vi.fn(async () => undefined), Miner: { new: native.minerNew } }));
const rawWallet = '0:'+'ab'.repeat(32), rawMiner = '0:'+'cd'.repeat(32);
const scopedWallet = mobileContractAddress(rawWallet), scopedMiner = mobileContractAddress(rawMiner);
const endpoints = ['https://test.invalid'];
beforeEach(() => {
  vi.clearAllMocks(); native.verify.mockResolvedValue(undefined); native.address.mockResolvedValue(rawMiner);
  native.details.mockResolvedValue({ address: rawWallet, free: vi.fn() });
  native.balances.mockResolvedValue({ ecc: {}, popitgame: {}, free: vi.fn() });
  native.minerNew.mockResolvedValue({free:vi.fn()});
});
describe('production Bee ABI address boundary', () => {
  it.each([rawMiner, scopedMiner, scopedMiner.toUpperCase()])('validates then converts %s to raw ABI spelling', value => {
    expect(mobileAbiAddress(value)).toBe(rawMiner);
    expect(mobileContractAddress(value)).toBe(scopedMiner);
  });
  it.each([`${APP.slice(2)}::${'ab'.repeat(32)}`, `2::${'ab'.repeat(32)}`, `-1:${'ab'.repeat(32)}`, '0:bad', `${rawMiner} `])('never strips an unrelated or invalid partition %s', value => {
    expect(() => mobileAbiAddress(value)).toThrow();
  });
  it('keeps stored identities scoped but sends raw multifactor address to Wallet', async () => {
    const sdk = new TeamGoshDirectWalletAuthorizationSdk();
    await expect(sdk.resolve(endpoints, 'offline_account', 'https://api.invalid', APP)).resolves.toEqual({walletAddress:scopedWallet,minerAddress:scopedMiner});
    expect(native.address).toHaveBeenCalledWith({multifactor_address:rawWallet});
    expect(native.free).toHaveBeenCalledOnce();
  });
  it('sends raw miner address and unchanged authorization app ID to verification', async () => {
    await new TeamGoshDirectWalletAuthorizationSdk().verify(endpoints,APP,scopedMiner,'ef'.repeat(32));
    expect(native.verify).toHaveBeenCalledWith(expect.objectContaining({miner_address:rawMiner,app_id:APP,expected_owner_public:'ef'.repeat(32)}));
  });
  it('repairs saved legacy key verification without changing key or DApp', async () => {
    await new TeamGoshBeeNativeSdk().ensureMiningKeysPropagated(endpoints,APP,scopedMiner,'ef'.repeat(32));
    expect(native.verify).toHaveBeenCalledWith(expect.objectContaining({miner_address:rawMiner,app_id:APP,expected_owner_public:'ef'.repeat(32)}));
  });
  it('passes raw addresses to balance and MamaBoard lookup methods', async () => {
    const gateway = new BeeSdkGateway({initialize:async()=>undefined,version:()=> '5.1.1',dispose:()=>undefined});
    const source = new BeeWalletBalanceSource(gateway,{endpoints,apiUrl:'https://api.invalid',appId:APP});
    await source.synchronize('local-test',scopedWallet); await source.readMamaBoardLevel('local-test',scopedWallet);
    expect(native.balances).toHaveBeenCalledWith({multifactor_address:rawWallet});
    expect(native.address).toHaveBeenCalledWith({multifactor_address:rawWallet});
    await gateway.dispose();
  });
  it('passes raw address to the renderer Miner.new without altering the application or keys', async () => {
    await createQueueAwareMiner(endpoints,APP,scopedMiner,'11'.repeat(32),'22'.repeat(32));
    expect(native.minerNew).toHaveBeenCalledWith(endpoints,APP,rawMiner,'11'.repeat(32),'22'.repeat(32));
  });
  it('rejects the application ID used as a contract partition before invoking SDK', async () => {
    const bad = `${APP.slice(2)}::${'ab'.repeat(32)}`;
    expect(() => new TeamGoshDirectWalletAuthorizationSdk().verify(endpoints,APP,bad,'ef'.repeat(32))).toThrow();
    expect(native.verify).not.toHaveBeenCalled();
    expect(DAPP).not.toBe(APP.slice(2));
  });
});
