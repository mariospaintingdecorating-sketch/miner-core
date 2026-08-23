import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WalletPresentation } from '../../application';
import { UiLanguageProvider } from '../i18n';
import { WalletRemovalDialog, WalletsPage } from './WalletsPage';

const wallet: WalletPresentation = {
  id: 'wallet-a',
  name: 'Alpha',
  status: 'idle',
  walletAddress: '0:public-wallet',
  mamaBoardLevel: 17,
  connectionStatus: 'connected',
  connection: {
    onboardingStatus: 'connected',
    phase: 'connected',
    availability: 'available',
    approvalPending: false,
    approval: null,
    connectionStateStored: true,
    miningCredentialStored: false,
    miningReady: false,
    operationPending: false,
    operationStep: null,
    lastFailureCode: null,
  },
  sessionId: null,
  generation: null,
  runtimeStatus: 'idle',
  schedulerStatus: 'idle',
  settlementStatus: 'idle',
  progressPercent: null,
  completedTaps: null,
  tapTarget: null,
  latestReward: null,
  balance: null,
  recovery: {
    walletId: 'wallet-a',
    state: 'healthy',
    attempt: 0,
    maximumAttempts: 5,
    issueCode: null,
    issueMessage: null,
    nextAttemptAt: null,
    updatedAt: '2026-08-06T10:00:00.000Z',
  },
  latestMiningReward: null,
  miningRewards: [],
};

const configuration = {
  status: 'ready' as const,
  code: 'production-configuration-ready' as const,
  endpointCount: 2,
  appIdConfigured: true,
  maximumSessionDurationMs: 135_000,
};

describe('WalletsPage', () => {
  it('sorts wallets by MamaBoard level from highest to lowest by default', () => {
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={configuration}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId={null}
        wallets={[
          { ...wallet, id: 'wallet-low', name: 'Low level', mamaBoardLevel: 8 },
          { ...wallet, id: 'wallet-unknown', name: 'Unknown level', mamaBoardLevel: null },
          { ...wallet, id: 'wallet-high', name: 'High level', mamaBoardLevel: 72 },
        ]}
      />,
    );

    expect(html.indexOf('High level')).toBeLessThan(html.indexOf('Low level'));
    expect(html.indexOf('Low level')).toBeLessThan(html.indexOf('Unknown level'));
  });

  it('renders explicit Application-owned wallet selection and safe setup commands', () => {
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={configuration}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId="wallet-a"
        wallets={[wallet]}
      />,
    );

    expect(html).toContain('Active wallet');
    expect(html).toContain('Wallet service');
    expect(html).toContain('Connection service ready');
    expect(html).toContain('Selected wallet');
    expect(html).toContain('Wallet approved');
    expect(html).toContain('Wallet onboarding progress');
    expect(html).toContain('Local wallet created');
    expect(html).toContain('Mining credential ready');
    expect(html).toContain('Ready for mining');
    expect(html).toContain('Wallet connection');
    expect(html).toContain('Approved');
    expect(html).toContain('Not stored');
    expect(html).toContain('Prepare mining credential');
    expect(html).toContain('Disconnect');
    expect(html).toContain('Not ready');
    expect(html).not.toContain('<option value="warning">');
    expect(html).not.toContain('<option value="error">');
    expect(html).not.toContain('<option value="offline">');
    expect(html).not.toContain('connectionReference');
    expect(html).not.toContain('miningCredentialReference');
  });

  it('renders a retryable failure state without exposing internal error data', () => {
    const failedWallet: WalletPresentation = {
      ...wallet,
      connectionStatus: 'failed',
      connection: {
        ...wallet.connection,
        onboardingStatus: 'failed',
        phase: 'failed',
        connectionStateStored: true,
        miningCredentialStored: false,
        miningReady: false,
        lastFailureCode: 'bee-wallet-approval-failed',
      },
    };
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={configuration}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId="wallet-a"
        wallets={[failedWallet]}
      />,
    );

    expect(html).toContain('Reset wallet connection');
    expect(html).toContain('approval request was cleared safely');
    expect(html).not.toContain('Retry wallet approval');
    expect(html).toContain('Wallet approval failed. Reset the connection and try again.');
    expect(html).not.toContain('bee-wallet-approval-failed');
    expect(html).not.toContain('Error:');
  });

  it('distinguishes a wallet_hello network read failure from wallet rejection', () => {
    const failedWallet: WalletPresentation = {
      ...wallet,
      connectionStatus: 'failed',
      connection: {
        ...wallet.connection,
        onboardingStatus: 'failed',
        phase: 'failed',
        connectionStateStored: true,
        miningCredentialStored: false,
        miningReady: false,
        lastFailureCode: 'bee-wallet-hello-read-failed',
      },
    };
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={configuration}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId="wallet-a"
        wallets={[failedWallet]}
      />,
    );

    expect(html).toContain('Reset wallet connection');
    expect(html).toContain('could not read wallet_hello from the network');
    expect(html).toContain('wallet did not report a rejection');
    expect(html).not.toContain('Wallet approval failed');
    expect(html).not.toContain('bee-wallet-hello-read-failed');
  });

  it('shows safe missing configuration blockers without exposing values', () => {
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={{
          ...configuration,
          status: 'missing',
          code: 'production-configuration-missing',
          endpointCount: 0,
          appIdConfigured: false,
        }}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId="wallet-a"
        wallets={[wallet]}
      />,
    );

    expect(html).toContain('Configuration required');
    expect(html).toContain('Wallet approval remains blocked');
    expect(html).not.toContain('production-configuration-missing');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('operator-app-id');
  });

  it('guides a newly created local wallet directly to the connect action', () => {
    const localWallet: WalletPresentation = {
      ...wallet,
      walletAddress: null,
      connectionStatus: 'disconnected',
      connection: {
        ...wallet.connection,
        onboardingStatus: 'disconnected',
        phase: 'disconnected',
        connectionStateStored: false,
      },
    };
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={configuration}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId="wallet-a"
        wallets={[localWallet]}
      />,
    );

    expect(html).toContain('data-onboarding-status="disconnected"');
    expect(html).toContain('Local wallet created');
    expect(html).toContain('Connect it to begin the explicit Bee wallet approval flow');
    expect(html).toMatch(/<button[^>]*>Connect wallet<\/button>/);
    expect(html).toContain('Continue setup');
  });

  it('keeps wallet approval visible and separate from mining-key preparation', () => {
    const awaitingWallet: WalletPresentation = {
      ...wallet,
      walletAddress: null,
      connectionStatus: 'awaiting-approval',
      connection: {
        ...wallet.connection,
        onboardingStatus: 'awaiting-connection',
        phase: 'awaiting-approval',
        approvalPending: true,
        approval: {
          deepLink: 'acki://approve/public-request',
          expiresAt: 4_102_444_800,
          waiting: true,
        },
        miningCredentialStored: false,
      },
    };
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={configuration}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId="wallet-a"
        wallets={[awaitingWallet]}
      />,
    );

    expect(html).toContain('data-onboarding-status="awaiting-connection"');
    expect(html).toContain('Connection pending');
    expect(html).toContain('Wallet pending');
    expect(html).not.toContain('Complete wallet approval');
    expect(html).toContain('will continue automatically');
    expect(html).toContain('Waiting for wallet approval');
    expect(html).toContain('Wallet approval QR code');
    expect(html).toContain('Open Wallet');
    expect(html).toContain('Approval expires');
    expect(html).not.toContain('>Prepare mining credential<');
  });

  it('asks for the wallet name once and keeps the internal ID out of the form', () => {
    const source = readFileSync(new URL('./WalletsPage.tsx', import.meta.url), 'utf8');

    expect(source.match(/<span>\{t\('Wallet name'\)\}<\/span>/g)).toHaveLength(1);
    expect(source).not.toContain('<span>Wallet ID</span>');
    expect(source).not.toContain('<span>Display name</span>');
    expect(source).toContain('onRegisterWallet({ name: normalizedName })');
    expect(source.match(/value=\{walletName\}/g)).toHaveLength(1);
    expect(source).toContain('minLength={2}');
    expect(source).toContain('maxLength={80}');
    expect(source).toContain('A wallet with this name already exists.');
  });

  it('shows mining-key approval, propagation, and verified readiness as distinct states', () => {
    const miningApprovalWallet: WalletPresentation = {
      ...wallet,
      connection: {
        ...wallet.connection,
        onboardingStatus: 'awaiting-mining-key-approval',
        approvalPending: true,
        operationPending: true,
        operationStep: 'prepare-mining-credential',
      },
    };
    const propagatingWallet: WalletPresentation = {
      ...wallet,
      connection: {
        ...wallet.connection,
        onboardingStatus: 'propagating-mining-key',
        miningCredentialStored: true,
        operationPending: true,
        operationStep: 'verify-mining-credential',
      },
    };
    const awaitingPropagationWallet: WalletPresentation = {
      ...wallet,
      connection: {
        ...wallet.connection,
        onboardingStatus: 'awaiting-mining-key-approval',
        approvalPending: true,
        miningCredentialStored: true,
        operationPending: false,
        operationStep: null,
      },
    };
    const readyWallet: WalletPresentation = {
      ...wallet,
      connection: {
        ...wallet.connection,
        onboardingStatus: 'ready',
        miningCredentialStored: true,
        miningReady: true,
      },
    };
    const render = (selected: WalletPresentation) =>
      renderToStaticMarkup(
        <WalletsPage
          commandsDisabled={false}
          configuration={configuration}
          onBeginWalletConnection={async () => null}
          onDisconnectWallet={async () => null}
          onPrepareWalletMiningCredential={async () => null}
          onVerifyWalletMiningCredential={async () => null}
          onRefreshWalletConnection={async () => null}
          onRegisterWallet={async () => true}
          onRemoveWallet={async () => true}
          onSelectWallet={() => undefined}
          selectedWalletId={selected.id}
          wallets={[selected]}
        />,
      );

    const approvalHtml = render(miningApprovalWallet);
    const awaitingPropagationHtml = render(awaitingPropagationWallet);
    const propagationHtml = render(propagatingWallet);
    const readyHtml = render(readyWallet);

    expect(approvalHtml).toContain('Mining credential approval pending');
    expect(approvalHtml).toContain('Generating mining keys and waiting for wallet authorization');
    expect(awaitingPropagationHtml).toContain('Mining credential awaiting verification');
    expect(awaitingPropagationHtml).toContain('Verify propagation');
    expect(propagationHtml).toContain('Waiting for mining-key propagation');
    expect(propagationHtml).toContain('Waiting for mining-key propagation confirmation');
    expect(propagationHtml).toContain('Bee propagation verification must finish');
    expect(readyHtml).toContain('data-onboarding-status="ready"');
    expect(readyHtml).toContain('Mining is still started only by an explicit operator command');
    expect(readyHtml).toContain('View wallet readiness');
  });

  it('renders wallets as a table with six rewards per wallet and no reward chart', () => {
    const rewards = Array.from({ length: 7 }, (_, index) => ({
      id: `reward-${index + 1}`,
      walletId: wallet.id,
      amountRaw: `${index + 1}0000000`,
      detectedAt: `2026-08-07T${String(index + 1).padStart(2, '0')}:00:00.000Z`,
      sessionId: `session-${index + 1}`,
      generation: index + 1,
      lockedNacklBeforeRaw: '0',
      lockedNacklAfterRaw: `${index + 1}0000000`,
      observedInCurrentRun: true,
      source: 'settlement' as const,
    }));
    const walletWithRewards: WalletPresentation = {
      ...wallet,
      balance: {
        walletId: wallet.id,
        values: {
          nacklLockedRaw: '12463000000',
          nacklAvailableRaw: '2500000000',
          usdcRaw: '0',
          shellRaw: '0',
        },
        synchronizedAt: '2026-08-07T12:00:00.000Z',
        status: 'fresh',
        errorCode: null,
      },
      latestMiningReward: rewards.at(-1)!,
      miningRewards: rewards,
    };
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={configuration}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId="wallet-a"
        wallets={[walletWithRewards]}
      />,
    );
    const rewardHistory = html.slice(
      html.indexOf('<ol class="wallet-table-rewards">'),
      html.indexOf('</ol>', html.indexOf('<ol class="wallet-table-rewards">')),
    );

    expect(html).toContain('<table');
    expect(html).toContain('MamaBoard Level');
    expect(html).toContain('>17<');
    expect(html).not.toContain('NACKL reward timeline');
    expect(html).not.toContain('wallet-reward-chart');
    expect(html).toContain('12.46 NACKL');
    expect(html).toContain('2.5 NACKL');
    expect(html.match(/data-token="nackl"/g)).toHaveLength(2);
    expect(html.match(/wallet-table-token-value/g)).toHaveLength(2);
    expect(rewardHistory.match(/<li>/g)).toHaveLength(6);
    expect(rewardHistory).not.toContain('+0.01 NACKL');
    expect(rewardHistory).toContain('+0.07 NACKL');
    expect(html).not.toContain('wallet-card wallet-card-');
  });

  it('shows each wallet MamaBoard level independently and never substitutes zero', () => {
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={configuration}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId="wallet-a"
        wallets={[
          wallet,
          {
            ...wallet,
            id: 'wallet-b',
            name: 'Beta',
            mamaBoardLevel: 42,
          },
          {
            ...wallet,
            id: 'wallet-c',
            name: 'Gamma',
            mamaBoardLevel: null,
          },
        ]}
      />,
    );

    expect(html).toContain('>17<');
    expect(html).toContain('>42<');
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('>0<');
  });

  it('keeps removal available for a connected active wallet', () => {
    const html = renderToStaticMarkup(
      <WalletsPage
        commandsDisabled={false}
        configuration={configuration}
        onBeginWalletConnection={async () => null}
        onDisconnectWallet={async () => null}
        onPrepareWalletMiningCredential={async () => null}
        onVerifyWalletMiningCredential={async () => null}
        onRefreshWalletConnection={async () => null}
        onRegisterWallet={async () => true}
        onRemoveWallet={async () => true}
        onSelectWallet={() => undefined}
        selectedWalletId="wallet-a"
        wallets={[
          {
            ...wallet,
            runtimeStatus: 'running',
            schedulerStatus: 'running',
            sessionId: 'session-a',
            generation: 1,
          },
        ]}
      />,
    );
    const removalButton = html.match(
      /<button class="button button-danger"[^>]*>Remove<\/button>/,
    )?.[0];

    expect(removalButton).toBeDefined();
    expect(removalButton).not.toContain('disabled');
  });

  it('presents an irreversible wallet-scoped confirmation in all UI languages', () => {
    const renderDialog = (language: 'en' | 'pl' | 'ru') =>
      renderToStaticMarkup(
        <UiLanguageProvider initialLanguage={language}>
          <WalletRemovalDialog
            busy={false}
            onCancel={() => undefined}
            onConfirm={() => undefined}
            walletName="Alpha"
          />
        </UiLanguageProvider>,
      );

    const english = renderDialog('en');
    const polish = renderDialog('pl');
    const russian = renderDialog('ru');
    expect(english).toContain('Remove wallet Alpha?');
    expect(english).toContain('This operation cannot be undone.');
    expect(polish).toContain('Usunąć portfel Alpha?');
    expect(polish).toContain('Tej operacji nie można cofnąć.');
    expect(russian).toContain('Удалить кошелёк Alpha?');
    expect(english).not.toContain('wallet-a');
  });
});
