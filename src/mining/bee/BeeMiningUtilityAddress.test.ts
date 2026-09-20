import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_APPLICATION_ID, mobileContractAddress } from '../../shared/chainIdentity';
const sdk=vi.hoisted(()=>({create:vi.fn(async()=>({free:vi.fn()}))}));
vi.mock('@msii/bee-miner',()=>({default:vi.fn(async()=>undefined),Miner:{new:sdk.create}}));
afterEach(()=>{vi.unstubAllGlobals();delete (process as NodeJS.Process&{parentPort?:unknown}).parentPort;vi.resetModules();});
describe('Electron utility production address boundary',()=>{
  it('constructs Miner with raw ABI address while preserving application and keys',async()=>{
    let listener:((event:{data:unknown})=>void)|undefined;
    const postMessage=vi.fn();
    Object.defineProperty(process,'parentPort',{configurable:true,value:{on:(_event:string,fn:typeof listener)=>{listener=fn;},postMessage}});
    // Alias lifetime is managed by the harness, not by the real application.
    vi.stubGlobal('window',globalThis);vi.stubGlobal('self',globalThis);
    vi.stubGlobal('Window',class{static [Symbol.hasInstance](v:unknown){return v===globalThis;}});
    await import('./BeeMiningUtilityWorker');
    const raw='0:'+'ab'.repeat(32);
    listener!({data:{type:'request',requestId:'offline-create',operation:'create',handleId:'h1',creation:{walletId:'synthetic',endpoints:['https://offline.invalid'],appId:CORE_APPLICATION_ID,minerAddress:mobileContractAddress(raw),publicKey:'cd'.repeat(32),secretKey:'ef'.repeat(32)}}});
    await vi.waitFor(()=>expect(postMessage).toHaveBeenCalled());
    expect(sdk.create).toHaveBeenCalledWith(['https://offline.invalid'],CORE_APPLICATION_ID,raw,'cd'.repeat(32),'ef'.repeat(32));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ok:true}));
  });
});
