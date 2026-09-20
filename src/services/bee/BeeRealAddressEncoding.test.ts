import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import initialize, { ensure_mining_keys_propagated } from '@teamgosh/bee-sdk';
import initializeMiner, { Miner } from '@msii/bee-miner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mobileAbiAddress, MOBILE_VERIFIERS_DAPP_ID, CORE_APPLICATION_ID } from '../../shared/chainIdentity';
import { TeamGoshDirectWalletAuthorizationSdk } from './DirectWalletAuthorizationSdk';

// Entirely synthetic, locally constructed active account with intentionally no
// executable Miner code. It exercises address encoding, NOT successful ownership.
const BOC = 'te6ccgEBAgEAPwABccAKurq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urICgGQAAAAAAAAAAAAAAAABejUpRAASQAEAAgA=';
const account = 'ab'.repeat(32), scoped = `${MOBILE_VERIFIERS_DAPP_ID}::${account}`;
const raw = '0:'+account, endpoints = ['https://offline.invalid'];
const require = createRequire(import.meta.url);
afterEach(()=>vi.unstubAllGlobals());
async function environment() {
  const seen: string[] = [];
  vi.stubGlobal('window',globalThis); vi.stubGlobal('self',globalThis);
  vi.stubGlobal('Window',class { static [Symbol.hasInstance](v:unknown) { return v===globalThis; } });
  vi.stubGlobal('fetch',async(input: RequestInfo|URL, options?:RequestInit) => {
    const request = input instanceof Request ? input : new Request(input,options);
    const url = new URL(request.url);
    expect(url.origin).toBe('https://offline.invalid'); expect(request.method).toBe('GET');
    seen.push(request.url);
    const body = url.pathname==='/graphql' ? {data:{info:{version:'1.0',time:Date.now(),latency:0,rempEnabled:false}}} : {boc:BOC};
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  });
  await initialize({module_or_path:readFileSync(require.resolve('@teamgosh/bee-sdk/bee_sdk_bg.wasm'))});
  await initializeMiner({module_or_path:readFileSync(require.resolve('@msii/bee-miner/bee_miner_bg.wasm'))});
  return seen;
}
async function rejection(operation:Promise<unknown>):Promise<string> {
  try { await operation; throw new Error('Unexpected successful authorization of a non-Miner fixture.'); }
  catch(error) { return String(error); }
}
describe('real pinned WASMs with offline account responses',()=>{
  it('reproduces Invalid address before the fix and reaches TVM execution after conversion',async()=>{
    const seen=await environment();
    const input={client_config:{network:{endpoints,query_timeout:100}},miner_address:scoped,app_id:CORE_APPLICATION_ID,expected_owner_public:'cd'.repeat(32),max_attempts:1,interval_ms:1};
    expect(await rejection(ensure_mining_keys_propagated(input))).toMatch(/Encode message.*Invalid address/s);
    seen.length=0;
    const fixed=await rejection(ensure_mining_keys_propagated({...input,miner_address:mobileAbiAddress(scoped)}));
    expect(fixed).not.toContain('Invalid address'); expect(fixed).toContain('Run tvm'); expect(fixed).toContain('Account has no code');
    const read=seen.map(x=>new URL(x)).find(u=>u.pathname==='/v2/account'&&u.searchParams.has('dapp_id'));
    expect(read?.searchParams.get('account_id')).toBe(account); expect(read?.searchParams.get('dapp_id')).toBe(MOBILE_VERIFIERS_DAPP_ID);
    expect(fixed).not.toContain('Unexpected successful');
  });
  it('the actual production verification adapter fixes encoding but never treats a bad contract as authorized',async()=>{
    await environment();
    const error=await rejection(new TeamGoshDirectWalletAuthorizationSdk().verify(endpoints,CORE_APPLICATION_ID,scoped,'cd'.repeat(32)));
    expect(error).toContain('Run tvm'); expect(error).toContain('Account has no code'); expect(error).not.toContain('Invalid address');
  });
  it('the derived mining WASM also needs raw ABI spelling; no taps or writes are performed',async()=>{
    const seen=await environment();
    const before=await rejection(Miner.new(endpoints,CORE_APPLICATION_ID,scoped,'cd'.repeat(32),'ef'.repeat(32)));
    expect(before).toMatch(/Encode message.*Invalid address/s);
    const after=await rejection(Miner.new(endpoints,CORE_APPLICATION_ID,raw,'cd'.repeat(32),'ef'.repeat(32)));
    expect(after).not.toContain('Invalid address'); expect(after).toContain('Run tvm');
    expect(seen.length).toBeGreaterThan(0);
  });
});
