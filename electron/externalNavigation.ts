const MAX_WALLET_APPROVAL_URL_LENGTH = 16_384;
const WALLET_APPROVAL_PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]*:$/i;
const BLOCKED_WALLET_APPROVAL_PROTOCOLS = new Set([
  'data:',
  'file:',
  'javascript:',
]);

export function isAllowedWalletApprovalUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_WALLET_APPROVAL_URL_LENGTH) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      WALLET_APPROVAL_PROTOCOL_PATTERN.test(url.protocol) &&
      !BLOCKED_WALLET_APPROVAL_PROTOCOLS.has(url.protocol.toLowerCase()) &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}
