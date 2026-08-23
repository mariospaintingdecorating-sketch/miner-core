import { describe, expect, it, vi } from 'vitest';
import {
  ACKI_WALLET_ACTIVITY,
  ACKI_WALLET_PACKAGE,
  createWalletAppLauncher,
  WALLET_ADB_TIMEOUT_MS,
  type WalletAppCommandRunner,
} from '../../electron/walletAppLauncher';

describe('Acki wallet desktop launcher', () => {
  it('finds LDPlayer ADB, selects its device, and passes the exact deep link', async () => {
    const deepLink =
      'bee-connect://approve/request?payload=public&client_dh_public=value';
    const runCommand: WalletAppCommandRunner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'List of devices attached\nemulator-5554\tdevice\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'Status: ok', stderr: '' });
    const openWallet = createWalletAppLauncher({
      platform: 'win32',
      environment: {
        SystemDrive: 'C:',
        ProgramFiles: 'C:\\Program Files',
      },
      fileExists: (path) =>
        path.endsWith('LDPlayer\\LDPlayer9\\adb.exe'),
      runCommand,
    });

    await expect(openWallet(deepLink)).resolves.toBe('adb_success');
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('LDPlayer\\LDPlayer9\\adb.exe'),
      ['devices'],
      WALLET_ADB_TIMEOUT_MS,
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('LDPlayer\\LDPlayer9\\adb.exe'),
      [
        '-s',
        'emulator-5554',
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        `'${deepLink}'`,
        ACKI_WALLET_PACKAGE,
      ],
      WALLET_ADB_TIMEOUT_MS,
    );
  });

  it('uses the explicit Acki activity only when the package intent fails', async () => {
    const runCommand: WalletAppCommandRunner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'emulator-5554 device',
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: 'Error: unable to resolve Intent',
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'Status: ok', stderr: '' });
    const openWallet = createWalletAppLauncher({
      platform: 'win32',
      environment: { PATH: 'C:\\Android\\platform-tools' },
      fileExists: (path) => path.endsWith('platform-tools\\adb.exe'),
      runCommand,
    });

    await expect(openWallet('acki://approve/request')).resolves.toBe(
      'adb_success',
    );
    expect(vi.mocked(runCommand).mock.calls[2]?.[1]).toEqual(
      expect.arrayContaining(['-n', ACKI_WALLET_ACTIVITY]),
    );
  });

  it('returns a safe fallback without executing unsupported links or missing devices', async () => {
    const runCommand = vi.fn<WalletAppCommandRunner>();
    const openWallet = createWalletAppLauncher({
      platform: 'win32',
      environment: { PATH: 'C:\\Android\\platform-tools' },
      fileExists: () => true,
      runCommand,
    });

    await expect(openWallet('javascript:alert(1)')).resolves.toBe(
      'fallback_required',
    );
    expect(runCommand).not.toHaveBeenCalled();

    runCommand.mockResolvedValueOnce({
      stdout: 'List of devices attached\nemulator-5554 offline',
      stderr: '',
    });
    await expect(openWallet('acki://approve/request')).resolves.toBe(
      'fallback_required',
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('searches PATH, Android SDK, LDPlayer, and dnplayerext2 locations', async () => {
    const checkedPaths: string[] = [];
    const runCommand = vi.fn<WalletAppCommandRunner>();
    const openWallet = createWalletAppLauncher({
      platform: 'win32',
      environment: {
        SystemDrive: 'C:',
        PATH: 'C:\\tools',
        ANDROID_SDK_ROOT: 'C:\\AndroidSdk',
        LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      },
      fileExists: (path) => {
        checkedPaths.push(path);
        return false;
      },
      runCommand,
    });

    await expect(openWallet('acki://approve/request')).resolves.toBe(
      'fallback_required',
    );
    expect(checkedPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining('tools\\adb.exe'),
        expect.stringContaining('AndroidSdk\\platform-tools\\adb.exe'),
        expect.stringContaining('LDPlayer\\LDPlayer9\\adb.exe'),
        expect.stringContaining('dnplayerext2\\adb.exe'),
      ]),
    );
    expect(runCommand).not.toHaveBeenCalled();
  });
});
