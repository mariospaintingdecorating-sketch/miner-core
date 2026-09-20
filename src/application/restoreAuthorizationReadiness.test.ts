import { describe, it, expect, vi } from 'vitest';
import { restoreAuthorizationReadiness } from './restoreAuthorizationReadiness';
import { WalletRegistry } from './WalletRegistry';
import { miningAuthorizationContext, CORE_APPLICATION_ID } from '../shared/chainIdentity';
const config = {appId: CORE_APPLICATION_ID, endpoints: ['https://a.invalid']};
function registry() { return new WalletRegistry([{id:'w', name:'A', walletAddress:'0:wallet', onboardingStatus:'ready', connectionReference:'c', miningCredentialReference:'k'}]); }
describe('non-destructive upgrade readiness', () => {
  it.each([null, '{bad json', JSON.stringify({version:1, secretKey:'do-not-overwrite'}), JSON.stringify({authorizationContext:'another context'})])('requires verification for missing, unreadable or unscoped evidence', async (raw) => {
    const reg = registry(); const read = vi.fn(async () => raw);
    await restoreAuthorizationReadiness(reg, {loadSecureValue:read}, config);
    expect(reg.wallet('w')).toMatchObject({name:'A', onboardingStatus:'awaiting-mining-key-approval', connectionReference:'c', miningCredentialReference:'k'});
    expect(read).toHaveBeenCalledExactlyOnceWith('k');
  });
  it('retains ready for an exactly verified context', async () => {
    const reg = registry(); await restoreAuthorizationReadiness(reg,{loadSecureValue:async()=>JSON.stringify({authorizationContext:miningAuthorizationContext(config)})},config);
    expect(reg.wallet('w')?.onboardingStatus).toBe('ready');
  });
  it('does not rewrite or delete a record on secure read failure', async () => {
    const reg=registry(); await restoreAuthorizationReadiness(reg,{loadSecureValue:async()=>{throw new Error('denied');}},config);
    expect(reg.wallets()).toHaveLength(1); expect(reg.wallet('w')?.miningCredentialReference).toBe('k');
  });
});
