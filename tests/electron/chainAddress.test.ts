import { describe, it, expect } from 'vitest';
import { parseMinerContractAddress } from '../../electron/chainAddress.cjs';
const account='ab'.repeat(32);const dapp='1'.padStart(64,'0');
describe('MamaBoard query routing',()=>{
  it('passes a system partition, never the account id, to GraphQL',()=>{
    const identity=parseMinerContractAddress(`0:${account}`);
    expect(identity).toEqual({accountId:account,dappId:dapp,localAddress:`0:${account}`});
    expect(identity.accountId).not.toBe(identity.dappId);
  });
  it('accepts canonical input but retains the old ABI decoder address form',()=>{
    expect(parseMinerContractAddress(`${dapp}::${account}`).localAddress).toBe(`0:${account}`);
  });
  it('refuses using the Core app id as a contract partition',()=>{
    expect(()=>parseMinerContractAddress(`${'30'.padStart(64,'0')}::${account}`)).toThrow();
  });
});
