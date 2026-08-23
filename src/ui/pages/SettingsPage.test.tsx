import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UiLanguageProvider } from '../i18n';
import { requestDiagnosticsExport, SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  it('keeps diagnostics export and removes obsolete appearance and maintenance cards', () => {
    const html = renderToStaticMarkup(
      <UiLanguageProvider initialLanguage="en">
        <SettingsPage onExportDiagnostics={async () => ({
          status: 'unavailable',
          fileName: null,
          message: null,
        })} />
      </UiLanguageProvider>,
    );

    expect(html).toContain('Diagnostics');
    expect(html).toContain('Export diagnostics');
    expect(html).not.toContain('Log options');
    expect(html).not.toContain('Appearance');
    expect(html).not.toContain('Dark operator theme');
    expect(html).not.toContain('Maintenance');
    expect(html).not.toContain('Backup and updates');
  });

  it('forwards the export request to the existing diagnostics action', async () => {
    const result = Object.freeze({
      status: 'saved' as const,
      fileName: 'core-miner-diagnostics.zip',
      message: null,
    });
    const onExportDiagnostics = vi.fn(async () => result);

    await expect(requestDiagnosticsExport(onExportDiagnostics)).resolves.toBe(result);
    expect(onExportDiagnostics).toHaveBeenCalledOnce();
  });
});
