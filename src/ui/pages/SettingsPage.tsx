import { useState } from 'react';
import type { DiagnosticsExportResult } from '../../application';
import { SectionHeading } from '../components/SectionHeading';
import { StatusBadge } from '../components/StatusBadge';
import { type UiLanguage, useUiLanguage } from '../i18n';
import { useRewardEffects } from '../rewardEffects';

export interface SettingsPageProps {
  readonly onExportDiagnostics: () => Promise<Readonly<DiagnosticsExportResult>>;
}

export function SettingsPage({ onExportDiagnostics }: SettingsPageProps) {
  const { language, setLanguage, t } = useUiLanguage();
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const {
    animationEnabled,
    soundEnabled,
    setAnimationEnabled,
    setSoundEnabled,
  } = useRewardEffects();
  const exportDiagnostics = async () => {
    setExporting(true);
    setExportMessage(null);
    const result = await requestDiagnosticsExport(onExportDiagnostics);
    setExporting(false);
    setExportMessage(
      result.status === 'saved'
        ? t('Diagnostics saved as {file}', { file: result.fileName ?? '' })
        : result.status === 'cancelled'
          ? t('Diagnostics export cancelled')
          : result.message ?? t('Diagnostics export unavailable'),
    );
  };

  return (
    <div className="page-stack settings-page">
      <SectionHeading
        description={t('Manage operator language, reward feedback, and diagnostic export.')}
        eyebrow={t('Application configuration')}
        title={t('Settings')}
      />

      <section className="settings-intro surface-panel">
        <div>
          <p className="eyebrow">{t('Safe configuration')}</p>
          <h3>{t('Operator settings only')}</h3>
          <p>{t('No wallet secrets, mining credentials, or lifecycle controls are exposed on this screen.')}</p>
        </div>
        <StatusBadge label="healthy" />
      </section>

      <section className="settings-grid">
        <article className="surface-panel setting-card language-setting-card">
          <span className="setting-icon" aria-hidden="true">文</span>
          <div><p className="eyebrow">{t('Language')}</p><h3>{t('Interface language')}</h3></div>
          <p>{t('Choose the language used by the operator interface.')}</p>
          <label className="language-selector">
            <span>{t('Interface language selection')}</span>
            <select
              onChange={(event) => setLanguage(event.target.value as UiLanguage)}
              value={language}
            >
              <option value="en">English</option>
              <option value="pl">Polski</option>
              <option value="ru">Русский</option>
            </select>
          </label>
          <small>{t('The system language is used on first launch. Unsupported system languages use English.')}</small>
        </article>
        <article className="surface-panel setting-card reward-effects-setting-card">
          <span className="setting-icon" aria-hidden="true">◇</span>
          <div><p className="eyebrow">{t('Dashboard rewards')}</p><h3>{t('Reward effects')}</h3></div>
          <p>{t('Control the wallet-scoped reward feedback shown only on the main Dashboard.')}</p>
          <RewardEffectToggle
            checked={animationEnabled}
            description={t('Show a short NACKL reward animation on the earning wallet card.')}
            label={t('Reward animation')}
            onChange={setAnimationEnabled}
          />
          <RewardEffectToggle
            checked={soundEnabled}
            description={t('Play one rate-limited reward sound while the application is visible.')}
            label={t('Reward sound')}
            onChange={setSoundEnabled}
          />
        </article>
        <article className="surface-panel setting-card diagnostics-setting-card">
          <span className="setting-icon" aria-hidden="true">≡</span>
          <div><p className="eyebrow">{t('Diagnostics')}</p><h3>{t('Export diagnostics')}</h3></div>
          <p>{t('Create a safe ZIP archive of retained operator diagnostics.')}</p>
          <button
            className="button button-secondary"
            disabled={exporting}
            onClick={() => void exportDiagnostics()}
            type="button"
          >
            {t(exporting ? 'Exporting…' : 'Export diagnostics')}
          </button>
          {exportMessage ? <p className="export-result" role="status">{exportMessage}</p> : null}
        </article>
      </section>
    </div>
  );
}

function RewardEffectToggle({
  checked,
  description,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly description: string;
  readonly label: string;
  readonly onChange: (enabled: boolean) => void;
}) {
  const { t } = useUiLanguage();

  return (
    <label className="reward-effect-toggle">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="reward-toggle-control">
        <input
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <i aria-hidden="true" />
        <b>{t(checked ? 'On' : 'Off')}</b>
      </span>
    </label>
  );
}

export function requestDiagnosticsExport(
  action: () => Promise<Readonly<DiagnosticsExportResult>>,
): Promise<Readonly<DiagnosticsExportResult>> {
  return action();
}
