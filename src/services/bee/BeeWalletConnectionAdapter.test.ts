import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeeWalletConnectionAdapter, parseStoredBeeMiningCredential } from './BeeWalletConnectionAdapter';
import { BeeSdkGateway } from './BeeSdkGateway';
import { CoreEventEmitter } from '../../shared/events';
import { mobileContractAddress, CORE_APPLICATION_ID, miningAuthorizationContext } from '../../shared/chainIdentity';
import { walletLookupEndpointGroups, type DirectWalletAuthorizationSdk } from './DirectWalletAuthorizationSdk';
import { authorizationRead } from './WalletAuthorizationRead';

const PUB = 'a'.repeat(64), SECRET = 'b'.repeat(64);
const walletAddress = mobileContractAddress('0:' + 'c'.repeat(64));
const minerAddress = mobileContractAddress('0:' + 'd'.repeat(64));
const endpoints = ['https://mainnet.ackinacki.org'];
const config = { endpoints, appId: CORE_APPLICATION_ID };
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
function link(publicKey = PUB, appId = CORE_APPLICATION_ID) { return 'https://links.gosh.sh/deeplinks/wallet/v2/set-mining-keys?payload=' + btoa(JSON.stringify({pubkey:publicKey,app_id:appId})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
function fixture() {
  const values = new Map<string,string>();
  const storage = { loadSecureValue: vi.fn(async (ref:string) => values.get(ref) ?? null), saveSecureValue: vi.fn(async (ref:string,value:string) => { values.set(ref,value); }), removeSecureValue: vi.fn(async (ref:string) => { values.delete(ref); }) };
  const gateway = new BeeSdkGateway({initialize:async()=>undefined,version:()=> '5.1.1',dispose:()=>undefined});
  const free = vi.fn();
  const sdk = {generate:vi.fn(async()=>({public:PUB,secret:SECRET,deep_link:link(),free})),resolve:vi.fn(async(_endpoints:readonly string[],_name:string,_api:string,_app:string)=>({walletAddress,minerAddress})),verify:vi.fn(async()=>undefined)} satisfies DirectWalletAuthorizationSdk;
  const eventBus = new CoreEventEmitter(); const events: unknown[] = []; for (const type of ['bee-wallet-connection-started','bee-wallet-connected','bee-wallet-connection-failed'] as const) eventBus.subscribe(type,e=>events.push(e));
  let sequence=0;
  const adapter = new BeeWalletConnectionAdapter(gateway,storage,config,sdk,eventBus,kind=>`${kind}:${++sequence}`);
  return {values,storage,gateway,sdk,free,adapter,events};
}
afterEach(()=>vi.useRealTimers());
describe('Direct wallet mining-key authorization',()=>{
  it('generates official-format public-only QR and encryptable pending state before approval',async()=>{
    const f=fixture();const request=await f.adapter.beginConnection({walletName:'  ALPHA  '});
    expect(request.kind).toBe('mining-key'); expect(f.sdk.generate).toHaveBeenCalledWith(CORE_APPLICATION_ID);
    const payload=JSON.parse(atob(new URL(request.deepLink).searchParams.get('payload')!));
    expect(payload).toEqual({pubkey:PUB,app_id:CORE_APPLICATION_ID}); expect(request.deepLink).not.toContain(SECRET);
    expect(JSON.parse(f.values.get(request.reference)!)).toMatchObject({walletName:'alpha',status:'awaiting-approval',secretKey:SECRET,credentialReference:null});
    expect(f.free).toHaveBeenCalledOnce();expect(f.sdk.verify).not.toHaveBeenCalled();
    expect(JSON.stringify(f.events)).not.toContain(SECRET);
  });
  it('requires an actual account name and does not generate keys for invalid inputs',async()=>{
    const f=fixture();await expect(f.adapter.beginConnection()).rejects.toThrow('account name');
    await expect(f.adapter.beginConnection({walletName:'bad name'})).rejects.toThrow('account name');
    expect(f.sdk.generate).not.toHaveBeenCalled();
  });
  it('keeps multifactor and miner addresses separate and commits only verified keys',async()=>{
    const f=fixture();const r=await f.adapter.beginConnection({walletName:'alpha'});
    await expect(f.adapter.prepareMiningCredential(r.reference)).rejects.toThrow('verified');
    const connected=await f.adapter.awaitConnection(r.reference);
    expect(connected.walletAddress).toBe(walletAddress);
    expect(f.sdk.verify).toHaveBeenCalledWith(endpoints,CORE_APPLICATION_ID,minerAddress,PUB);
    const credential=await f.adapter.prepareMiningCredential(r.reference);
    await f.adapter.verifyMiningCredentialPropagation(r.reference,credential.credentialReference);
    expect(parseStoredBeeMiningCredential(f.values.get(credential.credentialReference)!)).toMatchObject({walletAddress,minerAddress,publicKey:PUB,authorizationContext:miningAuthorizationContext(config)});
    expect(f.sdk.verify).toHaveBeenCalledOnce();
  });
  it('tries Shellnet account discovery but verifies authorization only on mining endpoints',async()=>{
    const f=fixture(); f.sdk.resolve.mockRejectedValueOnce(new Error('mainnet lookup unavailable'));
    const r=await f.adapter.beginConnection({walletName:'alpha'});await f.adapter.awaitConnection(r.reference);
    expect(f.sdk.resolve.mock.calls[1]?.[0]).toEqual(['https://shellnet.ackinacki.org']);
    expect(f.sdk.verify).toHaveBeenCalledWith(endpoints,CORE_APPLICATION_ID,minerAddress,PUB);
  });
  it('does not cross to production endpoints for a custom test network',()=>{
    expect(walletLookupEndpointGroups(['https://test.example'])).toEqual([['https://test.example']]);
  });
  it('does not treat account discovery as mining authorization',async()=>{
    vi.useFakeTimers(); const f=fixture();f.sdk.verify.mockRejectedValue(new Error('owner mismatch '+SECRET));
    const r=await f.adapter.beginConnection({walletName:'alpha'});
    const waiter=f.adapter.awaitConnection(r.reference);const rejection=expect(waiter).rejects.toThrow('without confirmation');
    await vi.advanceTimersByTimeAsync(180_001);await rejection;
    expect((await f.adapter.connectionState(r.reference)).status).toBe('failed');
    await expect(f.adapter.prepareMiningCredential(r.reference)).rejects.toThrow('verified');
    expect(JSON.stringify(f.events)).not.toContain(SECRET);
    expect((await f.adapter.connectionState(r.reference)).failure?.message).not.toContain(SECRET);
  });
  it('resumes a timed-out request with the same key and QR, including after adapter restart',async()=>{
    const f=fixture();const r=await f.adapter.beginConnection({walletName:'alpha'});
    const restarted=new BeeWalletConnectionAdapter(f.gateway,f.storage,config,f.sdk);
    const resumed=await restarted.beginConnection({walletName:'alpha',resumeReference:r.reference});
    expect(resumed.deepLink).toBe(r.deepLink); expect(resumed.reference).toBe(r.reference); expect(f.sdk.generate).toHaveBeenCalledOnce();
    await restarted.awaitConnection(r.reference);
    expect((await restarted.prepareMiningCredential(r.reference)).credentialReference).toBe('credential:2');
  });
  it('pauses immediately and rejects a late verification result without losing its key',async()=>{
    const f=fixture(); const late=deferred<void>();f.sdk.verify.mockImplementation(()=>late.promise);
    const r=await f.adapter.beginConnection({walletName:'alpha'});const controller=new AbortController();
    const waiter=f.adapter.awaitConnection(r.reference,controller.signal); const rejection=expect(waiter).rejects.toThrow('paused');
    await vi.waitFor(()=>expect(f.sdk.verify).toHaveBeenCalledOnce());controller.abort();await rejection;
    late.resolve();await Promise.resolve();await Promise.resolve();
    expect((await f.adapter.connectionState(r.reference)).status).toBe('failed');
    expect(JSON.parse(f.values.get(r.reference)!).secretKey).toBe(SECRET);
  });
  it('deduplicates concurrent observation and hung SDK reads rather than making parallel copies',async()=>{
    vi.useFakeTimers(); const f=fixture();f.sdk.verify.mockImplementation(()=>new Promise(()=>undefined));
    const r=await f.adapter.beginConnection({walletName:'alpha'});const waiter=f.adapter.awaitConnection(r.reference);
    expect(f.adapter.awaitConnection(r.reference)).toBe(waiter);
    const rejection=expect(waiter).rejects.toThrow();await vi.advanceTimersByTimeAsync(180_001);await rejection;
    expect(f.sdk.verify).toHaveBeenCalledOnce();
  });
  it('refuses to silently change the account or DApp of a saved request',async()=>{
    const f=fixture();const r=await f.adapter.beginConnection({walletName:'alpha'});const before=f.values.get(r.reference);
    await expect(f.adapter.beginConnection({walletName:'beta',resumeReference:r.reference})).rejects.toThrow('another account');
    const another=new BeeWalletConnectionAdapter(f.gateway,f.storage,{...config,appId:'0x'+'22'.padStart(64,'0')},f.sdk);
    await expect(another.beginConnection({walletName:'alpha',resumeReference:r.reference})).rejects.toThrow('another account');
    expect(f.values.get(r.reference)).toBe(before);expect(f.sdk.generate).toHaveBeenCalledOnce();
  });
  it('rejects resolution to a different existing wallet instead of overwriting identity',async()=>{
    const f=fixture(); const r=await f.adapter.beginConnection({walletName:'alpha',expectedWalletAddress:'0:'+'e'.repeat(64)});
    await expect(f.adapter.awaitConnection(r.reference)).rejects.toThrow('different wallet');expect(f.sdk.verify).not.toHaveBeenCalled();
  });
  it('retains the encrypted legacy connection and key while preparing a replacement',async()=>{
    const f=fixture(); const old=JSON.stringify({version:1,status:'connected',walletName:'alpha',walletAddress,credentialReference:'old-key',failure:null});
    f.values.set('legacy',old);f.values.set('old-key','old-secret-record');
    const r=await f.adapter.beginConnection({walletName:'alpha',resumeReference:'legacy'});
    expect(f.values.get('legacy')).toBe(old);expect(f.values.get('old-key')).toBe('old-secret-record');
    expect(JSON.parse(f.values.get(r.reference)!).previousConnectionReference).toBe('legacy');
  });
  it('verifies a legacy saved key without generating a new pair or needing BeeConnect',async()=>{
    const f=fixture();f.values.set('legacy',JSON.stringify({version:1,status:'connected',walletName:'alpha',walletAddress,credentialReference:'old-key',failure:null}));
    f.values.set('old-key',JSON.stringify({version:1,walletName:'alpha',walletAddress,minerAddress,publicKey:PUB,secretKey:SECRET}));
    await f.adapter.verifyMiningCredentialPropagation('legacy','old-key');
    expect(f.sdk.generate).not.toHaveBeenCalled();expect(f.sdk.verify).toHaveBeenCalledWith(endpoints,CORE_APPLICATION_ID,minerAddress,PUB);
    expect(parseStoredBeeMiningCredential(f.values.get('old-key')!).authorizationContext).toBe(miningAuthorizationContext(config));
  });
  it('does not mutate legacy credentials on failed verification',async()=>{
    const f=fixture();f.values.set('legacy',JSON.stringify({version:1,status:'connected',walletName:'alpha',walletAddress,credentialReference:'old-key',failure:null}));
    const old=JSON.stringify({version:1,walletName:'alpha',walletAddress,minerAddress,publicKey:PUB,secretKey:SECRET});f.values.set('old-key',old);
    f.sdk.verify.mockRejectedValueOnce(new Error('not authorized'));
    await expect(f.adapter.verifyMiningCredentialPropagation('legacy','old-key')).rejects.toThrow('not authorized');expect(f.values.get('old-key')).toBe(old);
  });
  it('rejects a key change during verification instead of overwriting newer credentials',async()=>{
    const f=fixture();f.values.set('legacy',JSON.stringify({version:1,status:'connected',walletName:'alpha',walletAddress,credentialReference:'old-key',failure:null}));
    f.values.set('old-key',JSON.stringify({version:1,walletName:'alpha',walletAddress,minerAddress,publicKey:PUB,secretKey:SECRET}));
    f.sdk.verify.mockImplementationOnce(async()=>{f.values.set('old-key','replacement');});
    await expect(f.adapter.verifyMiningCredentialPropagation('legacy','old-key')).rejects.toThrow('changed during');expect(f.values.get('old-key')).toBe('replacement');
  });
  it('does not emit a usable request after a secure storage failure and frees the key wrapper',async()=>{
    const f=fixture();f.storage.saveSecureValue.mockRejectedValueOnce(new Error('disk failed'));
    await expect(f.adapter.beginConnection({walletName:'alpha'})).rejects.toThrow('disk failed');expect(f.free).toHaveBeenCalledOnce();expect(f.values.size).toBe(0);
  });
  it('refuses an invalid generated link and frees the wrapper',async()=>{
    const f=fixture();f.sdk.generate.mockResolvedValueOnce({public:PUB,secret:SECRET,deep_link:'https://wrong.example/?payload=abc',free:f.free});
    await expect(f.adapter.beginConnection({walletName:'alpha'})).rejects.toThrow('Unexpected');expect(f.free).toHaveBeenCalledOnce();expect(f.values.size).toBe(0);
  });
  it('disposes keys which arrive after the generation deadline',async()=>{
    vi.useFakeTimers();const late=deferred<{free:()=>void}>();const free=vi.fn();
    const read=authorizationRead(late.promise,Date.now()+100,undefined,v=>v.free());const rejection=expect(read).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(101);await rejection;late.resolve({free});await Promise.resolve();expect(free).toHaveBeenCalledOnce();
  });
});
