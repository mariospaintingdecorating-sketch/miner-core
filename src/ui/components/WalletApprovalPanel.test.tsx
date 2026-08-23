import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  openWalletApproval,
  WalletApprovalPanel,
} from './WalletApprovalPanel';

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { readonly value: string }) => (
    <svg data-approval-value={value} />
  ),
}));

describe('WalletApprovalPanel', () => {
  it('renders a local QR code, safe Open Wallet action, and expiration', () => {
    const html = renderToStaticMarkup(
      <WalletApprovalPanel
        approval={{
          deepLink: 'acki://approve/public-request',
          expiresAt: 4_102_444_800,
          waiting: true,
        }}
        walletId="wallet-a"
        walletName="Alpha"
      />,
    );

    expect(html).toContain('Waiting for wallet approval');
    expect(html).toContain('Wallet approval QR code');
    expect(html).toContain('<svg');
    expect(html).toContain(
      'data-approval-value="acki://approve/public-request"',
    );
    expect(html).toMatch(/<button[^>]*>Open Wallet<\/button>/);
    expect(html).toContain('Open Wallet');
    expect(html).toContain('2100-01-01T00:00:00.000Z');
    expect(html).not.toContain('session_state_json');
    expect(html).not.toContain('client_dh_secret');
    expect(html).not.toContain('connectionReference');
  });

  it('renders the exact Bee deep link without applying Open Wallet validation', () => {
    const html = renderToStaticMarkup(
      <WalletApprovalPanel
        approval={{
          deepLink: 'https://unexpected.example/approval',
          expiresAt: 4_102_444_800,
          waiting: true,
        }}
        walletId="wallet-a"
        walletName="Alpha"
      />,
    );

    expect(html).toContain('Waiting for wallet approval');
    expect(html).toContain('<svg');
    expect(html).toContain(
      'data-approval-value="https://unexpected.example/approval"',
    );
    expect(html).toContain('Open Wallet');
  });

  it('passes wallet identity and the same deep link through the desktop bridge', async () => {
    const desktopOpen = vi.fn(async () => 'adb_success' as const);
    const fallbackOpen = vi.fn();
    vi.stubGlobal('window', {
      minerCoreApp: { walletApp: { open: desktopOpen } },
      open: fallbackOpen,
    });

    await openWalletApproval('wallet-a', 'acki://approve/public-request');

    expect(desktopOpen).toHaveBeenCalledWith(
      'wallet-a',
      'acki://approve/public-request',
    );
    expect(fallbackOpen).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('uses the protocol handler fallback when desktop ADB launch is unavailable', async () => {
    const fallbackOpen = vi.fn();
    vi.stubGlobal('window', {
      minerCoreApp: {
        walletApp: {
          open: vi.fn(async () => 'fallback_required' as const),
        },
      },
      open: fallbackOpen,
    });

    await openWalletApproval('wallet-a', 'acki://approve/public-request');

    expect(fallbackOpen).toHaveBeenCalledWith(
      'acki://approve/public-request',
      '_blank',
      'noopener,noreferrer',
    );
    vi.unstubAllGlobals();
  });

  it('delegates link validation to Electron and does not bypass a rejection', async () => {
    const desktopOpen = vi.fn(async () => {
      throw new Error('Electron rejected the approval link.');
    });
    const fallbackOpen = vi.fn();
    vi.stubGlobal('window', {
      minerCoreApp: { walletApp: { open: desktopOpen } },
      open: fallbackOpen,
    });

    await openWalletApproval('wallet-a', 'https://unexpected.example');

    expect(desktopOpen).toHaveBeenCalledWith(
      'wallet-a',
      'https://unexpected.example',
    );
    expect(fallbackOpen).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
