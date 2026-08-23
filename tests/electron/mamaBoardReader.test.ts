import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const forkMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );
  return { ...actual, fork: forkMock };
});

import { readMamaBoardLevelOnChain } from '../../electron/mamaBoardReader';

interface ControlledWorker extends EventEmitter {
  exitCode: number | null;
  killed: boolean;
  disconnect: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function createWorker(
  send: ReturnType<typeof vi.fn> = vi.fn(),
): ControlledWorker {
  const worker = new EventEmitter() as ControlledWorker;
  worker.exitCode = null;
  worker.killed = false;
  worker.disconnect = vi.fn();
  worker.kill = vi.fn(() => {
    worker.killed = true;
    return true;
  });
  worker.send = send;
  return worker;
}

describe('MamaBoard reader process ownership', () => {
  beforeEach(() => {
    process.env.MINER_CORE_NODE_EXECUTABLE = process.execPath;
    forkMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cleans the one-shot child and all listeners after a successful read', async () => {
    const worker = createWorker();
    forkMock.mockReturnValue(worker);

    const operation = readMamaBoardLevelOnChain(
      'https://example.test/graphql',
      `0:${'a'.repeat(64)}`,
    );
    worker.emit('message', { ok: true, level: 23 });

    await expect(operation).resolves.toBe(23);
    expect(worker.disconnect).toHaveBeenCalledOnce();
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    expect(worker.listenerCount('exit')).toBe(0);
  });

  it('settles once and cleans the child when sending the request fails', async () => {
    const send = vi.fn((_message: unknown, callback: (error: Error) => void) =>
      callback(new Error('IPC closed')),
    );
    const worker = createWorker(send);
    forkMock.mockReturnValue(worker);

    await expect(
      readMamaBoardLevelOnChain(
        'https://example.test/graphql',
        `0:${'b'.repeat(64)}`,
      ),
    ).rejects.toThrow('MamaBoard worker request failed.');
    expect(worker.disconnect).toHaveBeenCalledOnce();
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(worker.listenerCount('exit')).toBe(0);
  });

  it('cleans a silent child on timeout and ignores a later callback', async () => {
    vi.useFakeTimers();
    const worker = createWorker();
    forkMock.mockReturnValue(worker);
    const operation = readMamaBoardLevelOnChain(
      'https://example.test/graphql',
      `0:${'c'.repeat(64)}`,
    );
    const rejection = expect(operation).rejects.toThrow(
      'MamaBoard read timed out.',
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    worker.emit('message', { ok: true, level: 42 });

    expect(worker.disconnect).toHaveBeenCalledOnce();
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(worker.listenerCount('message')).toBe(0);
  });
});
