import { describe,it,expect } from 'vitest';
import { safeAuthorizationFailure } from './WalletAuthorizationRead';
import { miningVerificationEndpointGroups } from './DirectWalletAuthorizationSdk';
describe('safe authorization diagnostics and same-chain fallback',()=>{
  it.each([
    ['Encode message Invalid address secret=never-log-this','bee-wallet-sdk-address-invalid'],
    ['502 Bad Gateway token=never-log-this','bee-wallet-network-read-failed'],
    ['Failed to fetch never-log-this','bee-wallet-network-read-failed'],
    ['Timed out secret=never-log-this','bee-wallet-read-timeout'],
    ['not authorized never-log-this','bee-wallet-authorization-pending'],
  ])('classifies without leaking raw SDK data: %s',(message,code)=>{
    const failure=safeAuthorizationFailure(new Error(message));
    expect(failure.code).toBe(code);expect(failure.message).not.toContain('never-log-this');
  });
  it('never uses shellnet or a production fallback for custom endpoints',()=>{
    expect(miningVerificationEndpointGroups(['https://my.test'])).toEqual([['https://my.test']]);
    expect(miningVerificationEndpointGroups(['https://mainnet.ackinacki.org'])).toEqual([['https://mainnet.ackinacki.org'],['https://mainnet-cf.ackinacki.org']]);
    expect(miningVerificationEndpointGroups(['https://mainnet-cf.ackinacki.org'])).toEqual([['https://mainnet-cf.ackinacki.org'],['https://mainnet.ackinacki.org']]);
  });
});
