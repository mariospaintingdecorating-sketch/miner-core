import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { isAllowedWalletApprovalUrl } from './externalNavigation.js';

export const WALLET_APP_OPEN_CHANNEL = 'walletApp:open';
export const ACKI_WALLET_PACKAGE = 'com.ackinacki.wallet';
export const ACKI_WALLET_ACTIVITY =
  'com.ackinacki.wallet/.MainActivity';
export const WALLET_ADB_TIMEOUT_MS = 8_000;

export type WalletAppOpenResult = 'adb_success' | 'fallback_required';

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type WalletAppCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
) => Promise<Readonly<CommandResult>>;

export interface WalletAppLauncherDependencies {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly fileExists: (path: string) => boolean;
  readonly runCommand: WalletAppCommandRunner;
}

const DEFAULT_DEPENDENCIES: WalletAppLauncherDependencies = Object.freeze({
  platform: process.platform,
  environment: process.env,
  fileExists: existsSync,
  runCommand,
});

export function createWalletAppLauncher(
  overrides: Partial<WalletAppLauncherDependencies> = {},
): (deepLink: string) => Promise<WalletAppOpenResult> {
  const dependencies = Object.freeze({
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  });

  return async (deepLink: string): Promise<WalletAppOpenResult> => {
    if (
      dependencies.platform !== 'win32' ||
      !isAllowedWalletApprovalUrl(deepLink)
    ) {
      return 'fallback_required';
    }

    const adbExecutable = findAdbExecutable(dependencies);

    if (!adbExecutable) {
      return 'fallback_required';
    }

    let devices: Readonly<CommandResult>;

    try {
      devices = await dependencies.runCommand(
        adbExecutable,
        ['devices'],
        WALLET_ADB_TIMEOUT_MS,
      );
    } catch {
      return 'fallback_required';
    }

    const device = selectAdbDevice(devices.stdout);

    if (!device) {
      return 'fallback_required';
    }

    const commonArguments = [
      '-s',
      device,
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      quoteAdbShellArgument(deepLink),
    ] as const;

    if (
      await tryWalletIntent(dependencies, adbExecutable, [
        ...commonArguments,
        ACKI_WALLET_PACKAGE,
      ])
    ) {
      return 'adb_success';
    }

    return (await tryWalletIntent(dependencies, adbExecutable, [
      ...commonArguments,
      '-n',
      ACKI_WALLET_ACTIVITY,
    ]))
      ? 'adb_success'
      : 'fallback_required';
  };
}

export const openAckiWalletApp = createWalletAppLauncher();

function findAdbExecutable(
  dependencies: WalletAppLauncherDependencies,
): string | null {
  const environment = dependencies.environment;
  const candidates = new Set<string>();
  const add = (candidate: string | undefined): void => {
    if (candidate?.trim()) {
      candidates.add(resolve(candidate.trim()));
    }
  };
  const systemDrive = environment.SystemDrive || 'C:';

  add(join(systemDrive, 'platform-tools', 'adb.exe'));

  for (const pathEntry of String(environment.PATH || '').split(delimiter)) {
    if (pathEntry.trim()) {
      add(join(pathEntry.trim(), 'adb.exe'));
    }
  }

  for (const sdkRoot of [environment.ANDROID_SDK_ROOT, environment.ANDROID_HOME]) {
    if (sdkRoot) {
      add(join(sdkRoot, 'platform-tools', 'adb.exe'));
    }
  }

  if (environment.LOCALAPPDATA) {
    add(
      join(
        environment.LOCALAPPDATA,
        'Android',
        'Sdk',
        'platform-tools',
        'adb.exe',
      ),
    );
  }

  add(join(systemDrive, 'LDPlayer', 'LDPlayer9', 'adb.exe'));

  for (const programFilesRoot of [
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
  ]) {
    if (programFilesRoot) {
      add(join(programFilesRoot, 'LDPlayer', 'LDPlayer9', 'adb.exe'));
      add(join(programFilesRoot, 'dnplayerext2', 'adb.exe'));
    }
  }

  return [...candidates].find(dependencies.fileExists) ?? null;
}

function selectAdbDevice(devicesOutput: string): string | null {
  for (const line of devicesOutput.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+device$/);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

async function tryWalletIntent(
  dependencies: WalletAppLauncherDependencies,
  adbExecutable: string,
  arguments_: readonly string[],
): Promise<boolean> {
  try {
    const result = await dependencies.runCommand(
      adbExecutable,
      arguments_,
      WALLET_ADB_TIMEOUT_MS,
    );
    const output = `${result.stdout}\n${result.stderr}`;

    return (
      /\bStatus:\s*ok\b/i.test(output) &&
      !/(?:error type|does not exist|unable to resolve|activity class .* not found|exception)/i.test(
        output,
      )
    );
  } catch {
    return false;
  }
}

function quoteAdbShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runCommand(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
): Promise<Readonly<CommandResult>> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      executable,
      [...arguments_],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectCommand(error);
          return;
        }

        resolveCommand({
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      },
    );
  });
}
