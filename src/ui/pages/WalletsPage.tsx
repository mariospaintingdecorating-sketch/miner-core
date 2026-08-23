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
  onPrepareWalletMiningCredential,
  onVerifyWalletMiningCredential,
  onDisconnectWallet,
  onRefreshWalletConnection,
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
  const [walletPendingRemovalId, setWalletPendingRemovalId] = useState<
    string | null
  >(null);
  const [removalPending, setRemovalPending] = useState(false);
  const selectedWallet =
    wallets.find((wallet) => wallet.id === selectedWalletId) ?? null;
  const walletPendingRemoval =
    wallets.find((wallet) => wallet.id === walletPendingRemovalId) ?? null;
  const onboarding = selectedWallet
    ? onboardingPresentation(selectedWallet, t)
    : null;
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
    const normalizedName = walletName.trim();

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
    const registered = await onRegisterWallet({ name: normalizedName });

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
        description={t('Add wallets, complete approval, and prepare each wallet for mining.')}
        eyebrow={t('Wallet management')}
        title={t('Wallets')}
      />

      {showRegistration ? (
        <form className="wallet-registration-panel" onSubmit={(event) => void submitWallet(event)}>
          <label>
            <span>{t('Wallet name')}</span>
            <input
              onChange={(event) => {
                setWalletName(event.target.value);
                setRegistrationError(null);
              }}
              maxLength={80}
              minLength={2}
              placeholder={t('Wallet name')}
              required
              value={walletName}
            />
          </label>
          <button className="button button-primary" type="submit">
            {t('Save wallet')}
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
              ? t('Wallet approval and mining credential setup are available.')
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
        <section
          className="wallet-setup-panel"
          aria-label={t('Wallet connection setup')}
          data-onboarding-status={selectedWallet.connection.onboardingStatus}
        >
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">{t('Selected wallet')}</span>
              <h3>{selectedWallet.name}</h3>
            </div>
            <StatusBadge label={selectedWallet.connection.onboardingStatus} />
          </div>
          <h4 className="wallet-onboarding-title">{onboarding?.title}</h4>
          <p className="wallet-summary wallet-onboarding-intro">
            {onboarding?.description}
          </p>
          <ol
            aria-label={t('Wallet onboarding progress')}
            className="wallet-onboarding-steps"
          >
            {ONBOARDING_STAGES.map((stage, index) => {
              const state = onboardingStepState(selectedWallet, index);

              return (
                <li
                  aria-current={state === 'current' ? 'step' : undefined}
                  data-state={state}
                  key={stage}
                >
                  <span aria-hidden="true">{index + 1}</span>
                  <strong>{t(stage)}</strong>
                </li>
              );
            })}
          </ol>
          <div className="wallet-setup-summary">
            <SetupFact
              label={t('Wallet connection')}
              value={connectionSetupLabel(selectedWallet, t)}
              ready={selectedWallet.connection.phase === 'connected'}
            />
            <SetupFact
              label={t('Mining credential')}
              value={storedStateLabel(selectedWallet.connection.miningCredentialStored, t)}
              ready={selectedWallet.connection.miningCredentialStored === true}
            />
            <SetupFact
              label={t('Ready for mining')}
              value={t(selectedWallet.connection.miningReady ? 'Ready' : 'Not ready')}
              ready={selectedWallet.connection.miningReady}
            />
          </div>
          {selectedWallet.connection.lastFailureCode ? (
            <p className="wallet-failure-message" role="alert">
              <strong>{t('Wallet setup needs attention.')}</strong>
              <span>{walletFailureMessage(selectedWallet, t)}</span>
            </p>
          ) : null}
          {selectedWallet.connection.approval ? (
            <WalletApprovalPanel
              approval={selectedWallet.connection.approval}
              walletId={selectedWallet.id}
              walletName={selectedWallet.name}
            />
          ) : selectedWallet.connection.onboardingStatus ===
            'awaiting-connection' ? (
            <p className="wallet-summary" role="status">
              {t('The approval request is no longer available in this application session. If it expired before scanning, disconnect and reconnect the wallet to create a new request.')}
            </p>
          ) : null}
          {selectedWallet.connection.operationPending ? (
            <p className="wallet-summary" role="status">
              {operationMessage(
                selectedWallet.connection.operationStep,
                selectedWallet.connection.onboardingStatus,
                t,
              )}
            </p>
          ) : null}
          <div
            className="wallet-actions"
            aria-label={t('{wallet} connection actions', { wallet: selectedWallet.name })}
          >
            {selectedWallet.connection.onboardingStatus === 'disconnected' ? (
              <button
                className="button button-primary"
                disabled={connectionCommandsDisabled}
                onClick={() => void runConnectionCommand(onBeginWalletConnection)}
                type="button"
              >
                {t('Connect wallet')}
              </button>
            ) : null}
            {selectedWallet.connection.onboardingStatus === 'connected' ||
            (selectedWallet.connection.onboardingStatus === 'failed' &&
              failedDuringMiningCredentialPreparation(selectedWallet)) ? (
              <button
                className="button button-primary"
                disabled={connectionCommandsDisabled}
                onClick={() => void runConnectionCommand(onPrepareWalletMiningCredential)}
                type="button"
              >
                {selectedWallet.connection.onboardingStatus === 'failed'
                  ? t('Retry mining credential')
                  : t('Prepare mining credential')}
              </button>
            ) : null}
            {(selectedWallet.connection.onboardingStatus ===
              'awaiting-mining-key-approval' &&
              selectedWallet.connection.miningCredentialStored === true) ||
            (selectedWallet.connection.onboardingStatus === 'failed' &&
              failedDuringMiningCredentialPropagation(selectedWallet)) ? (
              <button
                className="button button-primary"
                disabled={connectionCommandsDisabled}
                onClick={() =>
                  void runConnectionCommand(onVerifyWalletMiningCredential)
                }
                type="button"
              >
                {t(selectedWallet.connection.onboardingStatus === 'failed'
                  ? 'Retry propagation verification'
                  : 'Verify propagation')}
              </button>
            ) : null}
            <button
              className="button button-quiet"
              disabled={connectionCommandsDisabled}
              onClick={() => void runConnectionCommand(onRefreshWalletConnection)}
              type="button"
            >
              {t('Refresh state')}
            </button>
            {selectedWallet.connection.phase !== 'disconnected' ? (
              <button
                className="button button-danger"
                disabled={connectionCommandsDisabled}
                onClick={() => void runConnectionCommand(onDisconnectWallet)}
                type="button"
              >
                {selectedWallet.connection.onboardingStatus === 'failed' &&
                !failedDuringMiningCredentialSetup(selectedWallet)
                  ? t('Reset wallet connection')
                  : t('Disconnect')}
              </button>
            ) : null}
          </div>
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

function storedStateLabel(value: boolean | null, t: Translate): string {
  return t(value === null ? 'Unknown' : value ? 'Stored securely' : 'Not stored');
}

function connectionSetupLabel(wallet: WalletPresentation, t: Translate): string {
  if (wallet.connection.phase === 'connected') {
    return t('Approved');
  }

  if (wallet.connection.phase === 'awaiting-approval') {
    return wallet.connection.onboardingStatus === 'awaiting-mining-key-approval'
      ? t('Mining key pending')
      : t('Wallet pending');
  }

  return t(wallet.connection.phase === 'failed' ? 'Needs attention' : 'Not connected');
}

function SetupFact({
  label,
  value,
  ready,
}: {
  readonly label: string;
  readonly value: string;
  readonly ready: boolean;
}) {
  return (
    <div className={ready ? 'setup-fact setup-fact-ready' : 'setup-fact'}>
      <span aria-hidden="true">{ready ? '✓' : '•'}</span>
      <div><small>{label}</small><strong>{value}</strong></div>
    </div>
  );
}

const ONBOARDING_STAGES = Object.freeze([
  'Local wallet created',
  'Connection pending',
  'Wallet approved',
  'Mining credential ready',
  'Ready for mining',
]);

type OnboardingStepState = 'upcoming' | 'current' | 'completed' | 'failed';

function onboardingPresentation(wallet: WalletPresentation, t: Translate): {
  readonly title: string;
  readonly description: string;
} {
  switch (wallet.connection.onboardingStatus) {
    case 'disconnected':
      return {
        title: t('Local wallet created'),
        description: t('The wallet record is ready. Connect it to begin the explicit Bee wallet approval flow.'),
      };
    case 'awaiting-connection':
      return {
        title: t('Connection pending'),
        description: t('Approve the request in the wallet application. Core Miner is already waiting for wallet_hello and will continue automatically.'),
      };
    case 'connected':
      return {
        title: t('Wallet approved'),
        description: t('The wallet connection is approved. A separate mining credential must still be prepared.'),
      };
    case 'awaiting-mining-key-approval':
      return {
        title: t(wallet.connection.miningCredentialStored
          ? 'Mining credential awaiting verification'
          : 'Mining credential approval pending'),
        description: t(wallet.connection.miningCredentialStored
          ? 'The mining credential request completed. Verify network propagation before mining.'
          : 'Approve the mining credential request in the wallet application. Mining remains stopped.'),
      };
    case 'propagating-mining-key':
      return {
        title: t('Waiting for mining-key propagation'),
        description: t('The credential is stored securely. Bee propagation verification must finish before mining is ready.'),
      };
    case 'ready':
      return {
        title: t('Ready for mining'),
        description: t('Wallet onboarding is complete. Mining is still started only by an explicit operator command.'),
      };
    case 'failed':
      return {
        title: t('Wallet setup needs attention'),
        description: failedDuringMiningCredentialSetup(wallet)
          ? t('The mining credential did not complete. Review the safe failure code and retry this step.')
          : t('The approval request was cleared safely. Reset the connection, then create a new approval request.'),
      };
  }
}

function onboardingStepState(
  wallet: WalletPresentation,
  stepIndex: number,
): OnboardingStepState {
  const currentStep = onboardingStepIndex(wallet);

  if (stepIndex < currentStep) {
    return 'completed';
  }

  if (stepIndex > currentStep) {
    return 'upcoming';
  }

  return wallet.connection.onboardingStatus === 'failed' ? 'failed' : 'current';
}

function onboardingStepIndex(wallet: WalletPresentation): number {
  switch (wallet.connection.onboardingStatus) {
    case 'disconnected':
      return 0;
    case 'awaiting-connection':
      return 1;
    case 'connected':
      return 2;
    case 'awaiting-mining-key-approval':
    case 'propagating-mining-key':
      return 3;
    case 'ready':
      return 4;
    case 'failed':
      if (wallet.connection.miningCredentialStored) {
        return 3;
      }

      return failedDuringMiningCredentialSetup(wallet) ? 2 : 1;
  }
}

function failedDuringMiningCredentialSetup(
  wallet: WalletPresentation,
): boolean {
  const failureCode = wallet.connection.lastFailureCode;

  if (failureCode?.includes('mining-credential')) {
    return true;
  }

  if (failureCode?.includes('wallet-hello-read')) {
    return false;
  }

  if (failureCode?.includes('wallet-approval')) {
    return false;
  }

  return wallet.walletAddress !== null;
}

function failedDuringMiningCredentialPreparation(
  wallet: WalletPresentation,
): boolean {
  return (
    failedDuringMiningCredentialSetup(wallet) &&
    !failedDuringMiningCredentialPropagation(wallet)
  );
}

function failedDuringMiningCredentialPropagation(
  wallet: WalletPresentation,
): boolean {
  return wallet.connection.lastFailureCode?.includes('propagation') === true;
}

function walletFailureMessage(
  wallet: WalletPresentation,
  t: Translate,
): string {
  const code = wallet.connection.lastFailureCode ?? '';

  if (code.includes('approval-timeout')) {
    return t('Wallet approval timed out. Reset the connection and create a new request.');
  }

  if (code.includes('wallet-hello-read')) {
    return t('Core Miner could not read wallet_hello from the network. The wallet did not report a rejection. Reset the connection and try again.');
  }

  if (code.includes('wallet-approval')) {
    return t('Wallet approval failed. Reset the connection and try again.');
  }

  if (code.includes('propagation')) {
    return t('Mining-key propagation was not confirmed. Retry verification.');
  }

  if (code.includes('mining-credential')) {
    return t('Mining-key preparation failed. Retry this onboarding step.');
  }

  if (code.includes('secure-storage')) {
    return t('Secure storage is unavailable. Review diagnostics.');
  }

  return t('Wallet setup failed. Review diagnostics and retry.');
}

function operationMessage(
  operation: WalletPresentation['connection']['operationStep'],
  onboardingStatus: WalletPresentation['connection']['onboardingStatus'],
  t: Translate,
): string {
  switch (operation) {
    case 'begin-connection':
      return onboardingStatus === 'awaiting-connection'
        ? t('Waiting for wallet approval. Connection completes automatically after wallet_hello.')
        : t('Preparing the wallet connection request.');
    case 'prepare-mining-credential':
      return t('Generating mining keys and waiting for wallet authorization.');
    case 'verify-mining-credential':
      return t('Waiting for mining-key propagation confirmation.');
    case 'disconnect':
      return t('Disconnecting the wallet safely.');
    case 'refresh-state':
      return t('Refreshing the public wallet state.');
    case null:
      return t('A wallet operation is in progress.');
  }
}
