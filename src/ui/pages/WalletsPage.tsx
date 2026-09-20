import { type FormEvent, useMemo, useState } from 'react';
import type {
  ProductionConfigurationSnapshot,
  WalletConnectionCommandResult,
  WalletPresentation,
  WalletRegistration,
  WalletRuntimePresentationStates,
} from '../../application';
import { formatRawAmount } from '../../application/runtimeAnalytics';
import { type Translate, type UiLanguage, useUiLanguage } from '../i18n';
import { EmptyState } from '../components/EmptyState';
import { SectionHeading } from '../components/SectionHeading';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { TokenIcon } from '../components/TokenIdentity';
import { WalletApprovalPanel } from '../components/WalletApprovalPanel';
import { compareWalletsByMamaBoardLevel } from '../walletSorting';

const WALLET_REWARD_HISTORY_LIMIT = 6;

export interface WalletsPageProps {
  readonly configuration: Readonly<ProductionConfigurationSnapshot>;
  readonly wallets: readonly WalletPresentation[];
  readonly selectedWalletId: string | null;
  readonly runtimeStates?: WalletRuntimePresentationStates;
  readonly commandsDisabled: boolean;
  readonly onSelectWallet: (walletId: string | null) => void;
  readonly onBeginWalletConnection: WalletConnectionCommand;
  readonly onPrepareWalletMiningCredential: WalletConnectionCommand;
  readonly onVerifyWalletMiningCredential: WalletConnectionCommand;
  readonly onDisconnectWallet: WalletConnectionCommand;
  readonly onRefreshWalletConnection: WalletConnectionCommand;
  readonly onStartWalletMining?: MiningCommand;
  readonly onStopWalletMining?: MiningCommand;
  readonly onRegisterWallet: (wallet: WalletRegistration) => Promise<boolean>;
  readonly onRemoveWallet: (walletId: string) => Promise<boolean>;
}

type WalletConnectionCommand = (
  walletId: string,
  accountName?: string,
) => Promise<Readonly<WalletConnectionCommandResult> | null>;

type MiningCommand = (walletId: string) => Promise<boolean>;

type WalletFilter = 'all' | 'running' | 'idle';
type WalletSort = 'mamaBoard' | 'name' | 'status';

export function WalletsPage({
  configuration,
  wallets,
  selectedWalletId,
  runtimeStates = EMPTY_RUNTIME_STATES,
  commandsDisabled,
  onSelectWallet,
  onBeginWalletConnection,
  onVerifyWalletMiningCredential,
  onDisconnectWallet,
  onStartWalletMining = async () => false,
  onStopWalletMining = async () => false,
  onRegisterWallet,
  onRemoveWallet,
}: WalletsPageProps) {
  const { language, t } = useUiLanguage();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<WalletFilter>('all');
  const [sort, setSort] = useState<WalletSort>('mamaBoard');
  const [showRegistration, setShowRegistration] = useState(false);
  const [walletName, setWalletName] = useState('');
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registrationPending, setRegistrationPending] = useState(false);
  const [accountNames, setAccountNames] = useState<Record<string, string>>({});
  const [walletPendingRemovalId, setWalletPendingRemovalId] = useState<
    string | null
  >(null);
  const [removalPending, setRemovalPending] = useState(false);
  const selectedWallet =
    wallets.find((wallet) => wallet.id === selectedWalletId) ?? null;
  const walletPendingRemoval =
    wallets.find((wallet) => wallet.id === walletPendingRemovalId) ?? null;
  const connectionCommandsDisabled =
    commandsDisabled ||
    Boolean(selectedWallet?.connection.operationPending) ||
    selectedWallet?.connection.availability !== 'available';
  const mamaBoardOrderedWallets = useMemo(
    () => [...wallets].sort(compareWalletsByMamaBoardLevel),
    [wallets],
  );
  const visibleWallets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();

    return [...wallets]
      .filter((wallet) => filter === 'all' || wallet.status === filter)
      .filter((wallet) => wallet.name.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => {
        if (sort === 'mamaBoard') {
          return compareWalletsByMamaBoardLevel(left, right);
        }

        return left[sort].localeCompare(right[sort]);
      });
  }, [filter, query, sort, wallets]);
  const submitWallet = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (registrationPending) return;
    const normalizedName = walletName.trim().toLowerCase();

    if (normalizedName.length < 2 || normalizedName.length > 80) {
      setRegistrationError(t('Wallet name must contain between 2 and 80 characters.'));
      return;
    }

    if (
      wallets.some(
        (wallet) =>
          wallet.name.trim().toLowerCase() === normalizedName.toLowerCase(),
      )
    ) {
      setRegistrationError(t('A wallet with this name already exists.'));
      return;
    }

    setRegistrationError(null);
    setRegistrationPending(true);
    let registered = false;
    try { registered = await onRegisterWallet({ name: normalizedName }); }
    finally { setRegistrationPending(false); }

    if (!registered) {
      return;
    }

    setWalletName('');
    setRegistrationError(null);
    setShowRegistration(false);
  };
  const runConnectionCommand = async (command: WalletConnectionCommand) => {
    if (!selectedWallet) {
      return;
    }

    await command(selectedWallet.id);
  };
  const confirmWalletRemoval = async () => {
    if (!walletPendingRemoval) {
      return;
    }

    setRemovalPending(true);
    try {
      if (await onRemoveWallet(walletPendingRemoval.id)) {
        setWalletPendingRemovalId(null);
      }
    } finally {
      setRemovalPending(false);
    }
  };

  return (
    <div className="page-stack">
      <SectionHeading
        action={
          <button
            className="button button-primary"
            onClick={() => {
              setShowRegistration((visible) => !visible);
              setRegistrationError(null);
            }}
            type="button"
          >
            {t(showRegistration ? 'Cancel' : 'Add wallet')}
          </button>
        }
        description={t('Account name → QR → approve in AN Wallet. Mining keys are handled automatically.')}
        eyebrow={t('Wallet management')}
        title={t('Wallets')}
      />

      {showRegistration ? (
        <form className="wallet-registration-panel" onSubmit={(event) => void submitWallet(event)}>
          <label>
            <span>{t('AN Wallet account name')}</span>
            <input
              onChange={(event) => {
                setWalletName(event.target.value);
                setRegistrationError(null);
              }}
              maxLength={80}
              minLength={2}
              placeholder={t('Exact account name in AN Wallet')}
              required
              value={walletName}
            />
          </label>
          <button className="button button-primary" disabled={registrationPending || commandsDisabled} type="submit">
            {t(registrationPending ? 'Preparing QR…' : 'Show authorization QR')}
          </button>
          {registrationError ? (
            <p className="wallet-failure-message" role="alert">
              {registrationError}
            </p>
          ) : null}
        </form>
      ) : null}

      <section
        aria-label={t('Bee configuration readiness')}
        className={`wallet-readiness-banner wallet-readiness-${configuration.status}`}
      >
        <span className="readiness-icon" aria-hidden="true">
          {configuration.status === 'ready' ? '✓' : '!'}
        </span>
        <div>
          <span className="eyebrow">{t('Wallet service')}</span>
          <h3>{t(configuration.status === 'ready' ? 'Connection service ready' : 'Configuration required')}</h3>
          <p>
            {configuration.status === 'ready'
              ? t('One QR authorizes the mining key for your application. No seed or private key is requested.')
              : t('Wallet approval remains blocked until valid local Bee configuration is supplied.')}
          </p>
        </div>
        <StatusBadge label={configuration.status} />
      </section>

      <div className="wallet-toolbar" aria-label={t('Wallet filters')}>
        <label>
          <span>{t('Active wallet')}</span>
          <select
            onChange={(event) => {
              onSelectWallet(event.target.value || null);
            }}
            value={selectedWalletId ?? ''}
          >
            <option value="">{t('Select wallet')}</option>
            {mamaBoardOrderedWallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('Search')}</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search wallet name')}
            type="search"
            value={query}
          />
        </label>
        <label>
          <span>{t('Status')}</span>
          <select onChange={(event) => setFilter(event.target.value as WalletFilter)} value={filter}>
            <option value="all">{t('All statuses')}</option>
            <option value="running">{t('Running')}</option>
            <option value="idle">{t('Idle')}</option>
          </select>
        </label>
        <label>
          <span>{t('Sort')}</span>
          <select onChange={(event) => setSort(event.target.value as WalletSort)} value={sort}>
            <option value="mamaBoard">{t('MamaBoard Level')}</option>
            <option value="name">{t('Name')}</option>
            <option value="status">{t('Status')}</option>
          </select>
        </label>
      </div>

      {selectedWallet ? (
        <section className="wallet-setup-panel wallet-setup-simple" aria-label={t('Wallet connection setup')}
          data-onboarding-status={selectedWallet.connection.onboardingStatus}>
          <div className="panel-title-row">
            <div><span className="eyebrow">{t('Selected wallet')}</span><h3>{selectedWallet.name}</h3></div>
            <StatusBadge label={selectedWallet.connection.miningReady ? 'ready' : selectedWallet.connection.operationPending ? 'Waiting for approval' : 'Setup required'} />
          </div>
          <p className="wallet-summary" role="status">{authorizationMessage(selectedWallet, t)}</p>
          {!selectedWallet.connection.miningReady ? (
            <label className="wallet-account-name">
              <span>{t('AN Wallet account name')}</span>
              <input autoComplete="off" spellCheck={false} maxLength={128}
                disabled={selectedWallet.connection.operationPending || Boolean(selectedWallet.connection.approval)}
                value={selectedWallet.connection.approval?.accountName ?? accountNames[selectedWallet.id] ?? selectedWallet.name}
                onChange={event => setAccountNames(current => ({ ...current, [selectedWallet.id]: event.target.value }))} />
              <small>{t('Use the existing account name, not a new nickname. Select this same account before scanning.')}</small>
            </label>
          ) : null}
          {selectedWallet.connection.approval ? (
            <WalletApprovalPanel approval={selectedWallet.connection.approval} walletId={selectedWallet.id}
              walletName={selectedWallet.connection.approval.accountName ?? (accountNames[selectedWallet.id]?.trim().toLowerCase() || selectedWallet.name)} />
          ) : null}
          <div className="wallet-actions" aria-label={t('{wallet} connection actions', { wallet: selectedWallet.name })}>
            {!selectedWallet.connection.miningReady && !selectedWallet.connection.operationPending ? (
              <button className="button button-primary" disabled={connectionCommandsDisabled || walletRuntimeActive(selectedWallet.runtimeStatus)}
                onClick={() => void onBeginWalletConnection(selectedWallet.id, accountNames[selectedWallet.id]?.trim() || undefined)} type="button">
                {t(selectedWallet.connection.connectionStateStored ? 'Resume authorization' : 'Show authorization QR')}
              </button>
            ) : null}
            {selectedWallet.connection.operationStep === 'authorize-mining-key' ? (
              <button className="button button-secondary" onClick={() => void runConnectionCommand(onDisconnectWallet)} type="button">
                {t('Pause verification')}
              </button>
            ) : null}
            {selectedWallet.connection.miningCredentialStored && !selectedWallet.connection.operationPending ? (
              <button className="button button-quiet" disabled={connectionCommandsDisabled || walletRuntimeActive(selectedWallet.runtimeStatus)}
                onClick={() => void runConnectionCommand(onVerifyWalletMiningCredential)} type="button">
                {t('Check saved key')}
              </button>
            ) : null}
          </div>
          <small className="wallet-summary">{t('Retry keeps the same key. Mining starts only when you press Start.')}</small>
        </section>
      ) : null}

      {visibleWallets.length > 0 ? (
        <section className="surface-panel wallet-table-panel">
          <div className="panel-title-row wallet-table-heading">
            <div>
              <p className="eyebrow">{t('Wallet management')}</p>
              <h3>{t('Wallets')}</h3>
            </div>
            <strong>{visibleWallets.length}</strong>
          </div>
          <div className="wallet-table-scroll">
            <table aria-label={t('Wallets')} className="wallet-table">
              <thead>
                <tr>
                  <th scope="col">{t('Name')}</th>
                  <th scope="col">{t('MamaBoard Level')}</th>
                  <th scope="col">{t('Connection')}</th>
                  <th scope="col">{t('NACKL locked')}</th>
                  <th scope="col">{t('NACKL available')}</th>
                  <th scope="col">{t('Recent rewards')}</th>
                  <th scope="col">{t('Recovery')}</th>
                  <th scope="col">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleWallets.map((wallet) => {
                  const rewards = [...wallet.miningRewards]
                    .slice(-WALLET_REWARD_HISTORY_LIMIT)
                    .reverse();
                  const runtimeStatus =
                    runtimeStates.get(wallet.id)?.runtimeStatus ??
                    wallet.runtimeStatus;
                  const runtimeActive = walletRuntimeActive(runtimeStatus);
                  const runtimeStartable =
                    wallet.connection.miningReady && runtimeStatus === 'idle';

                  return (
                    <tr
                      className={wallet.id === selectedWalletId ? 'wallet-table-row-selected' : undefined}
                      key={wallet.id}
                    >
                      <th scope="row">
                        <button
                          className="wallet-table-identity"
                          onClick={() => onSelectWallet(wallet.id)}
                          type="button"
                        >
                          <span className="wallet-avatar" aria-hidden="true">
                            {wallet.name.slice(0, 1).toLocaleUpperCase() || 'W'}
                          </span>
                          <strong>{wallet.name}</strong>
                        </button>
                      </th>
                      <td>
                        {wallet.mamaBoardLevel === null
                          ? t('Unavailable')
                          : wallet.mamaBoardLevel}
                      </td>
                      <td>{connectionSetupLabel(wallet, t)}</td>
                      <td className="wallet-table-balance">
                        <span className="wallet-table-token-value"><TokenIcon size="small" token="nackl" /><span>{walletBalanceValue(wallet, 'nacklLockedRaw', language, t)}</span></span>
                      </td>
                      <td className="wallet-table-balance">
                        <span className="wallet-table-token-value"><TokenIcon size="small" token="nackl" /><span>{walletBalanceValue(wallet, 'nacklAvailableRaw', language, t)}</span></span>
                      </td>
                      <td>
                        {rewards.length > 0 ? (
                          <ol className="wallet-table-rewards">
                            {rewards.map((reward) => (
                              <li key={reward.id}>
                                <time dateTime={reward.detectedAt}>
                                  {formatRewardTime(reward.detectedAt, language)}
                                </time>
                                <strong>
                                  +{formatRawAmount(
                                    reward.amountRaw,
                                    9,
                                    2,
                                    language === 'en' ? '.' : ',',
                                  )} NACKL
                                </strong>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <span className="wallet-table-empty">
                            {t('No mining rewards recorded')}
                          </span>
                        )}
                      </td>
                      <td>
                        <StatusBadge
                          label={t(wallet.recovery.state)}
                          tone={recoveryTone(wallet)}
                        />
                      </td>
                      <td>
                        <div className="wallet-table-actions">
                          <button
                            className="button button-quiet"
                            onClick={() => onSelectWallet(wallet.id)}
                            type="button"
                          >
                            {t(wallet.connection.miningReady
                              ? 'View wallet readiness'
                              : 'Continue setup')}
                          </button>
                          {runtimeActive ? (
                            <button
                              className="button button-secondary"
                              disabled={commandsDisabled}
                              onClick={() => void onStopWalletMining(wallet.id)}
                              type="button"
                            >
                              {t('Stop')}
                            </button>
                          ) : runtimeStartable ? (
                            <button
                              className="button button-primary"
                              disabled={commandsDisabled}
                              onClick={() => void onStartWalletMining(wallet.id)}
                              type="button"
                            >
                              {t('Start')}
                            </button>
                          ) : null}
                          <button
                            className="button button-danger"
                            disabled={commandsDisabled || wallet.connection.operationPending}
                            onClick={() => setWalletPendingRemovalId(wallet.id)}
                            type="button"
                          >
                            {t('Remove')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <EmptyState
          description={t('Register wallet metadata to begin an isolated wallet context. No private keys or secrets are stored.')}
          title={t(wallets.length === 0 ? 'No wallets configured' : 'No wallets match this view')}
        />
      )}

      {walletPendingRemoval ? (
        <WalletRemovalDialog
          busy={removalPending}
          onCancel={() => setWalletPendingRemovalId(null)}
          onConfirm={() => void confirmWalletRemoval()}
          walletName={walletPendingRemoval.name}
        />
      ) : null}
    </div>
  );
}

export function WalletRemovalDialog({
  walletName,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly walletName: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useUiLanguage();

  return (
    <div className="wallet-removal-backdrop" role="presentation">
      <section
        aria-labelledby="wallet-removal-title"
        aria-modal="true"
        className="wallet-removal-dialog"
        role="dialog"
      >
        <span className="eyebrow">{t('Permanent local removal')}</span>
        <h2 id="wallet-removal-title">
          {t('Remove wallet {wallet}?', { wallet: walletName })}
        </h2>
        <p>{t('The wallet and all of its local Core Miner data will be deleted.')}</p>
        <ul>
          <li>{t('The local wallet configuration will be removed.')}</li>
          <li>{t('Mining credentials and secure references will be removed.')}</li>
          <li>{t('Reward, session, tap, and balance history will be removed.')}</li>
        </ul>
        <p className="wallet-removal-warning">
          {t('This operation cannot be undone.')}
        </p>
        <div className="wallet-removal-actions">
          <button
            className="button button-secondary"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            {t('Cancel')}
          </button>
          <button
            className="button button-danger"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {t(busy ? 'Removing wallet…' : 'Delete wallet')}
          </button>
        </div>
      </section>
    </div>
  );
}

const EMPTY_RUNTIME_STATES: WalletRuntimePresentationStates = new Map();

function walletRuntimeActive(
  runtimeStatus: WalletPresentation['runtimeStatus'],
): boolean {
  return runtimeStatus !== 'idle' && runtimeStatus !== 'disposed';
}

function recoveryTone(wallet: WalletPresentation): StatusTone {
  switch (wallet.recovery.state) {
    case 'healthy':
    case 'recovered':
      return 'success';
    case 'detecting-issue':
    case 'recovery-pending':
    case 'recovering':
      return 'warning';
    case 'recovery-failed':
      return 'error';
    case 'manual-stop':
      return 'neutral';
  }
}

function walletBalanceValue(
  wallet: WalletPresentation,
  field: 'nacklLockedRaw' | 'nacklAvailableRaw',
  language: UiLanguage,
  t: Translate,
): string {
  return wallet.balance?.values
    ? `${formatRawAmount(
        wallet.balance.values[field],
        9,
        2,
        language === 'en' ? '.' : ',',
      )} NACKL`
    : t('Not synchronized');
}

function formatRewardTime(value: string, language: UiLanguage): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(
        language === 'pl' ? 'pl-PL' : language === 'ru' ? 'ru-RU' : 'en-GB',
        { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
      ).format(date);
}

function authorizationMessage(wallet: WalletPresentation, t: Translate): string {
  if (wallet.connection.miningReady) return t('The mining key is confirmed on-chain. Ready for mining.');
  if (wallet.connection.operationPending) return t('Approve the QR in the named AN Wallet account. Confirmation is checked automatically.');
  const code = wallet.connection.lastFailureCode ?? '';
  if (code.includes('address-mismatch') || code.includes('already-registered')) return t('The account does not match this profile, or it is already registered. No existing key was replaced.');
  if (code.includes('context-mismatch')) return t('The saved request belongs to another account or application. Its key was not replaced.');
  if (code.includes('account-name-invalid')) return t('Enter the exact existing account name from AN Wallet.');
  if (code.includes('cancelled')) return t('Verification paused. Resume to display the same QR and check again.');
  if (code.includes('read') || code.includes('timeout') || code.includes('wallet-hello')) return t('The network read did not complete. This is not a wallet rejection. Resume authorization; no reset is needed.');
  if (code) return t('Approval is not confirmed yet. Approve the QR, then resume verification with the same key.');
  return t('Account name → QR → approve in AN Wallet. Mining keys are handled automatically.');
}
