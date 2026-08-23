import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WALLET_APP_OPEN_CHANNEL } from '../../electron/walletAppLauncher';

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    'utf8',
  );
}

describe('wallet application Electron boundary', () => {
  it('exposes a narrow walletApp.open bridge without exposing ipcRenderer', () => {
    const preload = source('electron/preload.cts');
    const main = source('electron/main.ts');

    expect(preload).toContain(`'${WALLET_APP_OPEN_CHANNEL}'`);
    expect(preload).toContain(
      'ipcRenderer.invoke(walletAppOpenChannel, walletId, deepLink)',
    );
    expect(preload).not.toContain("exposeInMainWorld('ipcRenderer'");
    expect(main).toContain('WALLET_APP_OPEN_CHANNEL');
    expect(main).toContain('return openAckiWalletApp(deepLink)');
  });

  it('keeps ADB, process access, secure storage, and Bee internals out of React', () => {
    const ui = [
      source('src/ui/App.tsx'),
      source('src/ui/pages/WalletsPage.tsx'),
      source('src/ui/components/WalletApprovalPanel.tsx'),
    ].join('\n');

    expect(ui).not.toContain('node:child_process');
    expect(ui).not.toContain('adb.exe');
    expect(ui).not.toContain('safeStorage');
    expect(ui).not.toContain('@teamgosh/bee-sdk');
    expect(source('electron/walletAppLauncher.ts')).toContain(
      "from 'node:child_process'",
    );
    expect(source('electron/walletAppLauncher.ts')).not.toContain('console.');
  });
});
