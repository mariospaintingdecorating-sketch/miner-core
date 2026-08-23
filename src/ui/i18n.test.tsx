import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from './pages/SettingsPage';
import {
  resolveUiLanguage,
  translate,
  UiLanguageProvider,
} from './i18n';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('UI language', () => {
  it.each([
    [['pl-PL'], 'pl'],
    [['en-GB'], 'en'],
    [['ru-RU'], 'ru'],
    [['de-DE'], 'en'],
    [[], 'en'],
  ] as const)('resolves %j to %s', (systemLanguages, expected) => {
    expect(resolveUiLanguage(systemLanguages)).toBe(expected);
  });

  it('translates interface text without changing runtime values', () => {
    expect(translate('pl', 'Start mining')).toBe('Uruchom kopanie');
    expect(translate('ru', 'Start mining')).toBe('Запустить майнинг');
    expect(translate('en', 'Start mining')).toBe('Start mining');
    expect(translate('pl', 'unknown-runtime-value')).toBe('unknown-runtime-value');
  });

  it('renders the language setting in each supported language', () => {
    const polish = renderToStaticMarkup(
      <UiLanguageProvider initialLanguage="pl">
        <SettingsPage onExportDiagnostics={unavailableExport} />
      </UiLanguageProvider>,
    );
    const russian = renderToStaticMarkup(
      <UiLanguageProvider initialLanguage="ru">
        <SettingsPage onExportDiagnostics={unavailableExport} />
      </UiLanguageProvider>,
    );

    expect(polish).toContain('Język interfejsu');
    expect(polish).toContain('<option value="en">English</option>');
    expect(polish).toContain('<option value="pl" selected="">Polski</option>');
    expect(polish).toContain('<option value="ru">Русский</option>');
    expect(russian).toContain('Язык интерфейса');
    expect(russian).toContain('<option value="ru" selected="">Русский</option>');
  });

  it('keeps the Polish and Russian dictionaries on the same source-key set', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./i18n.tsx', import.meta.url)),
      'utf8',
    );
    const polish = dictionaryKeys(source, '  pl: {', '\n  },\n  ru: {');
    const russian = dictionaryKeys(source, '  ru: {', '\n  },\n};');

    expect(polish).toEqual(russian);
  });
});

function dictionaryKeys(
  source: string,
  startMarker: string,
  endMarker: string,
): string[] {
  const normalizedSource = source.replace(/\r\n/g, '\n');
  const block = normalizedSource.split(startMarker)[1]?.split(endMarker)[0] ?? '';
  return [...block.matchAll(/^    '((?:[^'\\]|\\.)+)':/gmu)]
    .map((match) => match[1] ?? '')
    .sort();
}

const unavailableExport = async () => ({
  status: 'unavailable' as const,
  fileName: null,
  message: null,
});
