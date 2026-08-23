import { describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import { BeeMiningUtilitySupervisor } from './beeMiningUtilitySupervisor.js';

class FakeUtilityProcess {
  readonly posted: Record<string, unknown>[] = [];
  readonly messageListeners: ((message: unknown) => void)[] = [];
  readonly exitListeners: ((code: number) => void)[] = [];
  killCalls = 0;

  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(
    event: 'message' | 'exit',
    listener: ((message: unknown) => void) | ((code: number) => void),
  ): this {
    if (event === 'message') {
      this.messageListeners.push(listener as (message: unknown) => void);
    }
    else this.exitListeners.push(listener as (code: number) => void);
    return this;
  }

  respond(index: number, response: Record<string, unknown>): void {
    const request = this.posted[index];
    for (const listener of this.messageListeners) listener({
      type: 'response',
      requestId: request.requestId,
      ...response,
    });
  }

  callback(message: Record<string, unknown>): void {
    for (const listener of this.messageListeners) listener({
      type: 'callback',
      ...message,
    });
  }

  exit(code = 1): void {
    for (const listener of this.exitListeners) listener(code);
  }
}

function senderFixture(): {
  readonly sender: WebContents;
  readonly sent: { channel: string; message: unknown }[];
} {
  const sent: { channel: string; message: unknown }[] = [];
  return {
    sender: {
      isDestroyed: () => false,
      send: (channel: string, message: unknown) => sent.push({ channel, message }),
    } as unknown as WebContents,
    sent,
  };
}

function request(
  operation: string,
  handleId: string,
  requestId: string,
): Record<string, unknown> {
  return {
    type: 'request',
    requestId,
    operation,
    handleId,
    ...(operation === 'create'
      ? {
          creation: {
            endpoints: ['https://synthetic.invalid'],
            appId: 'synthetic-app',
            minerAddress: '0:synthetic',
            publicKey: 'synthetic-public',
            secretKey: 'synthetic-secret',
          },
        }
      : operation === 'start'
        ? {
            durationMs: 135_000,
            callbackSessionId: `callback-${requestId}`,
          }
        : {}),
  };
}

describe('BeeMiningUtilitySupervisor', () => {
  it('shares one process across idle epochs and stops it only on supervisor disposal', async () => {
    const processes: FakeUtilityProcess[] = [];
    const supervisor = new BeeMiningUtilitySupervisor(() => {
      const process = new FakeUtilityProcess();
      processes.push(process);
      return process;
    });
    const { sender } = senderFixture();

    const firstCreate = supervisor.request(sender, request('create', 'handle-1', 'create-1'));
    processes[0].respond(0, { ok: true, value: null });
    await firstCreate;
    const secondCreate = supervisor.request(sender, request('create', 'handle-2', 'create-2'));
    processes[0].respond(1, { ok: true, value: null });
    await secondCreate;

    expect(processes).toHaveLength(1);
    expect(processes[0].killCalls).toBe(0);

    const firstFree = supervisor.request(sender, request('free', 'handle-1', 'free-1'));
    processes[0].respond(2, { ok: true, value: null });
    await firstFree;
    expect(processes[0].killCalls).toBe(0);

    const secondFree = supervisor.request(sender, request('free', 'handle-2', 'free-2'));
    processes[0].respond(3, { ok: true, value: null });
    await secondFree;
    expect(processes[0].killCalls).toBe(0);

    const thirdCreate = supervisor.request(sender, request('create', 'handle-3', 'create-3'));
    processes[0].respond(4, { ok: true, value: null });
    await thirdCreate;

    expect(processes).toHaveLength(1);
    supervisor.dispose();
    expect(processes[0].killCalls).toBe(1);
  });

  it('converts an unexpected process exit into safe request and callback failures', async () => {
    const process = new FakeUtilityProcess();
    const supervisor = new BeeMiningUtilitySupervisor(() => process);
    const { sender, sent } = senderFixture();
    const create = supervisor.request(sender, request('create', 'handle-1', 'create-1'));
    process.respond(0, { ok: true, value: null });
    await create;

    const start = supervisor.request(sender, request('start', 'handle-1', 'start-1'));
    process.respond(1, { ok: true, value: null });
    await start;

    const pending = supervisor.request(
      sender,
      request('getMinerData', 'handle-1', 'data-1'),
    );
    process.exit();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      failure: {
        failureStage: 'PREPARE',
        errorCategory: 'BEE_UTILITY_PROCESS_EXIT',
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatchObject({
      callbackSessionId: 'callback-start-1',
      callback: {
        action: 'native_error',
        errorCategory: 'BEE_UTILITY_PROCESS_EXIT',
      },
    });

    await expect(
      supervisor.request(sender, request('free', 'handle-1', 'free-1')),
    ).resolves.toMatchObject({ ok: true });
  });

  it('preserves the active callback session ID and rejects stale callback ownership', async () => {
    const process = new FakeUtilityProcess();
    const supervisor = new BeeMiningUtilitySupervisor(() => process);
    const { sender, sent } = senderFixture();
    const creation = supervisor.request(sender, request('create', 'handle-1', 'create-1'));
    process.respond(0, { ok: true, value: null });
    await creation;
    const start = supervisor.request(sender, request('start', 'handle-1', 'start-1'));
    process.respond(1, { ok: true, value: null });
    await start;

    process.callback({
      handleId: 'handle-1',
      callbackSessionId: 'stale-session',
      callback: { action: 'tap_computed', sequence: 1 },
    });
    expect(sent).toHaveLength(0);

    process.callback({
      handleId: 'handle-1',
      callbackSessionId: 'callback-start-1',
      callback: {
        action: 'submit_session_proof',
        sequence: 2,
        status: 'failed',
        errorPresent: true,
        failureStage: 'PROOF_SUBMIT',
        serverCode: 621,
        rawPayload: 'must-not-cross',
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatchObject({
      type: 'callback',
      handleId: 'handle-1',
      callbackSessionId: 'callback-start-1',
      callback: {
        action: 'submit_session_proof',
        sequence: 2,
        failureStage: 'PROOF_SUBMIT',
        serverCode: 621,
      },
    });
    expect(JSON.stringify(sent[0].message)).not.toContain('must-not-cross');

    process.callback({
      handleId: 'handle-1',
      callbackSessionId: 'callback-start-1',
      callback: {
        action: 'session_rejected',
        sequence: 3,
        status: 'rejected',
      },
    });
    expect(sent).toHaveLength(2);
    expect(sent[1].message).toMatchObject({
      callbackSessionId: 'callback-start-1',
      callback: { action: 'session_rejected', sequence: 3 },
    });
  });

  it('rejects start without a callback session ID before reaching the utility', async () => {
    const process = new FakeUtilityProcess();
    const supervisor = new BeeMiningUtilitySupervisor(() => process);
    const { sender } = senderFixture();
    const creation = supervisor.request(sender, request('create', 'handle-1', 'create-1'));
    process.respond(0, { ok: true, value: null });
    await creation;

    await expect(supervisor.request(sender, {
      type: 'request',
      requestId: 'start-1',
      operation: 'start',
      handleId: 'handle-1',
      durationMs: 135_000,
    })).resolves.toMatchObject({
      ok: false,
      failure: { errorCategory: 'BEE_UTILITY_INVALID_REQUEST' },
    });
    expect(process.posted).toHaveLength(1);
  });

  it('removes non-allowlisted worker error fields before returning to renderer', async () => {
    const process = new FakeUtilityProcess();
    const supervisor = new BeeMiningUtilitySupervisor(() => process);
    const { sender } = senderFixture();
    const creation = supervisor.request(sender, request('create', 'handle-1', 'create-1'));
    process.respond(0, {
      ok: false,
      failure: {
        failureStage: 'PREPARE',
        errorCategory: 'NETWORK',
        serverCode: 621,
        rawPayload: 'must-not-cross',
        secretKey: 'must-not-cross',
      },
    });

    const response = await creation;
    expect(response).toMatchObject({
      ok: false,
      failure: { failureStage: 'PREPARE', errorCategory: 'NETWORK', serverCode: 621 },
    });
    expect(JSON.stringify(response)).not.toContain('must-not-cross');
    expect(process.killCalls).toBe(0);
    supervisor.dispose();
    expect(process.killCalls).toBe(1);
  });
});
