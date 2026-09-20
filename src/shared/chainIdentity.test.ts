import { describe, it, expect } from 'vitest';
import { contractIdentity, mobileContractAddress, sameWalletAddress, miningAuthorizationContext, CORE_APPLICATION_ID, MOBILE_VERIFIERS_DAPP_ID } from './chainIdentity';
const account = 'ab'.repeat(32);
const mobile = `${MOBILE_VERIFIERS_DAPP_ID}::${account}`;
describe('chain identity and app authorization are separate', () => {
  it('uses the requested hexadecimal 0030 suffix, not decimal 30 converted to 1e', () => {
    expect(CORE_APPLICATION_ID).toBe('0x' + '0'.repeat(62) + '30');
    expect(CORE_APPLICATION_ID).toHaveLength(66);
  });
  it('converts only the known legacy workchain into MobileVerifiers', () => {
    expect(mobileContractAddress(`0:${account}`)).toBe(mobile);
    expect(contractIdentity(`0:${account}`)).toEqual({ dappId: MOBILE_VERIFIERS_DAPP_ID, accountId: account });
  });
  it('preserves a canonical address and normalizes hex case', () => {
    expect(mobileContractAddress(mobile.toUpperCase())).toBe(mobile);
    expect(sameWalletAddress(`0:${account}`, mobile)).toBe(true);
  });
  it.each(['', '0:abc', `-1:${account}`, `0:${account} `, 'https://example.invalid'])('rejects an invalid contract %s', (input) => {
    expect(() => mobileContractAddress(input)).toThrow();
  });
  it('does not substitute the app id into a system contract partition', () => {
    expect(() => mobileContractAddress(`${CORE_APPLICATION_ID.slice(2)}::${account}`)).toThrow();
    expect(sameWalletAddress(mobile, `${'2'.padStart(64,'0')}::${account}`)).toBe(false);
  });
  it('binds verification to app plus endpoint set, but not list order', () => {
    const a = { appId: CORE_APPLICATION_ID, endpoints: ['https://a.invalid','https://b.invalid'] };
    expect(miningAuthorizationContext(a)).toBe(miningAuthorizationContext({ ...a, endpoints: [...a.endpoints].reverse() }));
    expect(miningAuthorizationContext(a)).not.toBe(miningAuthorizationContext({ ...a, appId: '0x'+'22'.padStart(64,'0') }));
    expect(miningAuthorizationContext(a)).not.toBe(miningAuthorizationContext({ ...a, endpoints: ['https://other.invalid'] }));
  });
});
