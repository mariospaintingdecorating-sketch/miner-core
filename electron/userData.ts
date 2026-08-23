import { join } from 'node:path';

// Keep these legacy directory names stable so renamed builds reuse existing wallets,
// encrypted mining credentials, settings, diagnostics, and history.
export const INSTALLED_MINER_CORE_USER_DATA_DIRECTORY = 'Miner Core';
export const DEVELOPMENT_MINER_CORE_USER_DATA_DIRECTORY = 'miner-core';

export type MinerCoreStorageProfile = 'development' | 'installed';

export interface MinerCoreUserDataConfiguration {
  readonly profile: MinerCoreStorageProfile;
  readonly userDataPath: string;
  readonly databasePath: string;
  readonly diagnosticsPath: string;
}

export function minerCoreStorageProfile(
  isPackaged: boolean,
): MinerCoreStorageProfile {
  return isPackaged ? 'installed' : 'development';
}

export function minerCoreUserDataConfiguration(
  appDataPath: string,
  isPackaged: boolean,
): MinerCoreUserDataConfiguration {
  const profile = minerCoreStorageProfile(isPackaged);
  const userDataPath = join(
    appDataPath,
    isPackaged
      ? INSTALLED_MINER_CORE_USER_DATA_DIRECTORY
      : DEVELOPMENT_MINER_CORE_USER_DATA_DIRECTORY,
  );

  return Object.freeze({
    profile,
    userDataPath,
    databasePath: join(userDataPath, 'miner-core.sqlite'),
    diagnosticsPath: join(
      userDataPath,
      'diagnostics',
      'runtime-diagnostics.jsonl',
    ),
  });
}
