import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistentStorage } from '../../electron/PersistentStorage';
import {
  DEVELOPMENT_MINER_CORE_USER_DATA_DIRECTORY,
  INSTALLED_MINER_CORE_USER_DATA_DIRECTORY,
  minerCoreUserDataConfiguration,
} from '../../electron/userData';

const temporaryDirectories: string[] = [];
const openStorage: PersistentStorage[] = [];

afterEach(async () => {
  for (const storage of openStorage.splice(0)) {
    await storage.close();
  }

  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Core Miner user-data isolation', () => {
  it('uses the legacy lowercase directory exclusively for development', () => {
    const configuration = minerCoreUserDataConfiguration(
      'C:\\Users\\operator\\AppData\\Roaming',
      false,
    );

    expect(configuration).toEqual({
      profile: 'development',
      userDataPath:
        'C:\\Users\\operator\\AppData\\Roaming\\miner-core',
      databasePath:
        'C:\\Users\\operator\\AppData\\Roaming\\miner-core\\miner-core.sqlite',
      diagnosticsPath:
        'C:\\Users\\operator\\AppData\\Roaming\\miner-core\\diagnostics\\runtime-diagnostics.jsonl',
    });
    expect(configuration.userDataPath.endsWith(
      DEVELOPMENT_MINER_CORE_USER_DATA_DIRECTORY,
    )).toBe(true);
  });

  it('uses the product directory exclusively for packaged builds', () => {
    const configuration = minerCoreUserDataConfiguration(
      'C:\\Users\\operator\\AppData\\Roaming',
      true,
    );

    expect(configuration).toEqual({
      profile: 'installed',
      userDataPath:
        'C:\\Users\\operator\\AppData\\Roaming\\Miner Core',
      databasePath:
        'C:\\Users\\operator\\AppData\\Roaming\\Miner Core\\miner-core.sqlite',
      diagnosticsPath:
        'C:\\Users\\operator\\AppData\\Roaming\\Miner Core\\diagnostics\\runtime-diagnostics.jsonl',
    });
    expect(configuration.userDataPath.endsWith(
      INSTALLED_MINER_CORE_USER_DATA_DIRECTORY,
    )).toBe(true);
  });

  it('never resolves development and packaged storage to the same paths', () => {
    const appDataPath = 'C:\\Users\\operator\\AppData\\Roaming';
    const development = minerCoreUserDataConfiguration(appDataPath, false);
    const installed = minerCoreUserDataConfiguration(appDataPath, true);

    expect(development.profile).not.toBe(installed.profile);
    expect(development.userDataPath).not.toBe(installed.userDataPath);
    expect(development.databasePath).not.toBe(installed.databasePath);
    expect(development.diagnosticsPath).not.toBe(installed.diagnosticsPath);
  });

  it('keeps secure-value records scoped to their own profile database', async () => {
    const appDataPath = await temporaryAppData();
    const development = await createStorage(appDataPath, false);
    const installed = await createStorage(appDataPath, true);

    development.saveSecureValue('credential-reference', 'dev-ciphertext');
    installed.saveSecureValue('credential-reference', 'installed-ciphertext');

    expect(development.loadSecureValue('credential-reference')).toBe(
      'dev-ciphertext',
    );
    expect(installed.loadSecureValue('credential-reference')).toBe(
      'installed-ciphertext',
    );
  });

  it('does not change packaged wallets when development storage changes', async () => {
    const appDataPath = await temporaryAppData();
    const development = await createStorage(appDataPath, false);
    const installed = await createStorage(appDataPath, true);

    installed.saveWallet({
      id: 'installed-wallet',
      name: 'Installed wallet',
      onboardingStatus: 'ready',
      miningCredentialReference: 'installed-credential',
    });
    await installed.close();
    openStorage.splice(openStorage.indexOf(installed), 1);
    const installedBefore = await readFile(
      minerCoreUserDataConfiguration(appDataPath, true).databasePath,
    );

    development.saveWallet({
      id: 'development-wallet',
      name: 'Development wallet',
      onboardingStatus: 'ready',
      miningCredentialReference: 'development-credential',
    });

    expect(development.listWallets().map((wallet) => wallet.id)).toEqual([
      'development-wallet',
    ]);
    expect(
      await readFile(
        minerCoreUserDataConfiguration(appDataPath, true).databasePath,
      ),
    ).toEqual(installedBefore);
  });

  it('does not create or migrate packaged storage during development startup', async () => {
    const appDataPath = await temporaryAppData();
    const development = await createStorage(appDataPath, false);
    development.saveWallet({ id: 'dev-wallet', name: 'Dev wallet' });

    const installed = minerCoreUserDataConfiguration(appDataPath, true);
    await expect(readFile(installed.databasePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

async function temporaryAppData(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'miner-core-app-data-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createStorage(
  appDataPath: string,
  isPackaged: boolean,
): Promise<PersistentStorage> {
  const configuration = minerCoreUserDataConfiguration(
    appDataPath,
    isPackaged,
  );
  await mkdir(configuration.userDataPath, { recursive: true });
  const storage = new PersistentStorage(
    configuration.databasePath,
    configuration.diagnosticsPath,
  );
  openStorage.push(storage);
  return storage;
}
