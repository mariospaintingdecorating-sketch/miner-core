import { describe, expect, it } from 'vitest';
import { isAllowedWalletApprovalUrl } from '../../electron/externalNavigation';

describe('wallet approval navigation', () => {
  it('allows credential-free wallet approval links with valid protocols', () => {
    expect(isAllowedWalletApprovalUrl('acki://approve/request-1')).toBe(true);
    expect(
      isAllowedWalletApprovalUrl(
        'bee-connect://approve/request-1?payload=public',
      ),
    ).toBe(true);
    expect(isAllowedWalletApprovalUrl('https://wallet.example/approve')).toBe(
      true,
    );
    expect(isAllowedWalletApprovalUrl('acki://user:secret@approve/request-1')).toBe(
      false,
    );
  });

  it('blocks dangerous protocols and malformed or oversized links', () => {
    expect(isAllowedWalletApprovalUrl('data:text/html,unsafe')).toBe(false);
    expect(isAllowedWalletApprovalUrl('file:///C:/Windows/System32')).toBe(false);
    expect(isAllowedWalletApprovalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedWalletApprovalUrl('not a URL')).toBe(false);
    expect(
      isAllowedWalletApprovalUrl(`acki://approve/${'a'.repeat(16_384)}`),
    ).toBe(false);
  });
});
