import { fork, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAMA_BOARD_READ_CHANNEL = 'mamaBoard:readOnChain';

const READ_TIMEOUT_MS = 30_000;
const currentDirectory = dirname(fileURLToPath(import.meta.url));
let nodeExecutable: string | null = null;

export function readMamaBoardLevelOnChain(
  endpointValue: unknown,
  minerAddressValue: unknown,
): Promise<number | null> {
  const endpoint = validateEndpoint(endpointValue);
  const minerAddress = validateMinerAddress(minerAddressValue);
  const worker = fork(join(currentDirectory, 'mamaBoardReaderWorker.cjs'), [], {
    execPath: resolveSystemNode(),
    env: withoutElectronRunAsNode(process.env),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;

    const finishWith = (operation: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);

      try {
        worker.disconnect();
      } catch {
        // The one-shot worker may already have disconnected after its response.
      }

      if (worker.exitCode === null && !worker.killed) {
        worker.kill();
      }
      operation();
    };

    const onMessage = (message: unknown): void => {
      if (!isWorkerResult(message)) {
        finishWith(() => reject(new Error('MamaBoard worker returned invalid data.')));
        return;
      }

      if (!message.ok) {
        finishWith(() => reject(new Error('MamaBoard read failed.')));
        return;
      }

      finishWith(() => resolve(normalizeLevel(message.level)));
    };
    const onError = (): void => {
      finishWith(() => reject(new Error('MamaBoard worker failed.')));
    };
    const onExit = (code: number | null): void => {
      if (!settled) {
        finishWith(() =>
          reject(new Error(`MamaBoard worker exited with code ${code ?? -1}.`)),
        );
      }
    };

    timeout = setTimeout(() => {
      finishWith(() => reject(new Error('MamaBoard read timed out.')));
    }, READ_TIMEOUT_MS);
    timeout.unref?.();

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);

    try {
      worker.send({ endpoint, minerAddress }, (error) => {
        if (error) {
          finishWith(() => reject(new Error('MamaBoard worker request failed.')));
        }
      });
    } catch {
      finishWith(() => reject(new Error('MamaBoard worker request failed.')));
    }
  });
}

function validateEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new TypeError('Invalid MamaBoard endpoint.');
  }

  const endpoint = new URL(value.trim());
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new TypeError('Invalid MamaBoard endpoint.');
  }

  return endpoint.toString();
}

function validateMinerAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^0:[0-9a-f]{64}$/i.test(value)) {
    throw new TypeError('Invalid Miner contract address.');
  }

  return value;
}

function resolveSystemNode(): string {
  if (nodeExecutable) {
    return nodeExecutable;
  }

  for (const candidate of [
    process.env.MINER_CORE_NODE_EXECUTABLE,
    process.env.npm_node_execpath,
  ]) {
    if (candidate && existsSync(candidate) && !isElectronExecutable(candidate)) {
      nodeExecutable = candidate;
      return candidate;
    }
  }

  const lookup = spawnSync(
    'node',
    ['-p', "process.versions.electron ? '' : process.execPath"],
    { encoding: 'utf8', timeout: 5_000, windowsHide: true },
  );
  const resolved = lookup.status === 0 ? lookup.stdout.trim() : '';

  if (!resolved || !existsSync(resolved) || isElectronExecutable(resolved)) {
    throw new Error('System Node executable is unavailable.');
  }

  nodeExecutable = resolved;
  return resolved;
}

function isElectronExecutable(value: string): boolean {
  return /(?:^|[\\/])electron(?:\.exe)?$/i.test(value);
}

function withoutElectronRunAsNode(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.ELECTRON_RUN_AS_NODE;
  return result;
}

function isWorkerResult(
  value: unknown,
): value is Readonly<{ ok: boolean; level?: unknown }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
}

function normalizeLevel(value: unknown): number | null {
  if (value === null) {
    return null;
  }

  const level = typeof value === 'string' ? Number(value) : value;
  return typeof level === 'number' &&
    Number.isInteger(level) &&
    level >= 0 &&
    level <= 72
    ? level
    : null;
}
