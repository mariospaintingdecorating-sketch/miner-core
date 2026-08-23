import { QRCodeSVG } from 'qrcode.react';
import type { WalletApprovalPresentation } from '../../application';
import { useUiLanguage } from '../i18n';

export interface WalletApprovalPanelProps {
  readonly approval: Readonly<WalletApprovalPresentation>;
  readonly walletId: string;
  readonly walletName: string;
}

export function WalletApprovalPanel({
  approval,
  walletId,
  walletName,
}: WalletApprovalPanelProps) {
  const { t } = useUiLanguage();
  const expiration = approvalExpiration(approval.expiresAt);

  return (
    <section
      aria-label={t('{wallet} wallet approval request', { wallet: walletName })}
      className="wallet-approval-card"
    >
      <div
        aria-label={t('Wallet approval QR code')}
        className="wallet-approval-qr"
        role="img"
      >
        <QRCodeSVG
          bgColor="#ffffff"
          fgColor="#07101b"
          level="M"
          marginSize={3}
          size={210}
          title={t('{wallet} wallet approval QR code', { wallet: walletName })}
          value={approval.deepLink}
        />
      </div>
      <div className="wallet-approval-copy">
        <span className="eyebrow">{t('Wallet approval')}</span>
        <h4>{t('Waiting for wallet approval')}</h4>
        <p>
          {t('Scan the QR code with Acki Nacki Wallet on your phone, or open the registered wallet application on this computer.')}
        </p>
        <p>
          {t('Approval expires:')}{' '}
          {expiration ? (
            <time dateTime={expiration}>{expiration}</time>
          ) : (
            t('Not available')
          )}
        </p>
        <button
          className="button button-primary wallet-open-action"
          onClick={() => void openWalletApproval(walletId, approval.deepLink)}
          type="button"
        >
          {t('Open Wallet')}
        </button>
        <small>
          {t('Core Miner opens only the Acki wallet protocol through the Electron security boundary.')}
        </small>
      </div>
    </section>
  );
}

export async function openWalletApproval(
  walletId: string,
  deepLink: string,
): Promise<void> {
  const walletApp = window.minerCoreApp?.walletApp;

  if (!walletApp) {
    return;
  }

  try {
    const result = await walletApp.open(walletId, deepLink);

    if (result === 'adb_success') {
      return;
    }
  } catch {
    // Electron rejected the request or could not process it. Do not bypass it.
    return;
  }

  window.open(deepLink, '_blank', 'noopener,noreferrer');
}

function approvalExpiration(expiresAt: number): string | null {
  const date = new Date(expiresAt * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
