import { describe, expect, it, vi } from 'vitest';
import type { GlobalMiningUptimeStorageContract } from '../storage/contracts';
import { GlobalMiningUptime } from './GlobalMiningUptime';

const minute = 60_000;

function localTime(day: number, hour: number, minutes = 0): number {
  return new Date(2026, 7, day, hour, minutes, 0, 0).getTime();
}

function storage(
  completedTodayMs = 0,
  activeStartedAt: number | null = null,
  history: readonly Readonly<{ date: string; durationMs: number }>[] = [],
): GlobalMiningUptimeStorageContract & {
  startGlobalMiningUptime: ReturnType<typeof vi.fn>;
  heartbeatGlobalMiningUptime: ReturnType<typeof vi.fn>;
  stopGlobalMiningUptime: ReturnType<typeof vi.fn>;
} {
  return {
    globalMiningUptimeSnapshot: vi.fn(async () => ({
      completedTodayMs,
      activeStartedAt,
      history,
    })),
    startGlobalMiningUptime: vi.fn(async () => undefined),
    heartbeatGlobalMiningUptime: vi.fn(async () => undefined),
    stopGlobalMiningUptime: vi.fn(async () => undefined),
  };
}

describe('GlobalMiningUptime', () => {
  it('adds separate global intervals without multiplying time by wallet count', async () => {
    let now = localTime(8, 1);
    const persistence = storage();
    const uptime = await GlobalMiningUptime.hydrate(persistence, () => now);
    expect(uptime.start()).toBe(true);
    expect(uptime.start()).toBe(false);
    now = localTime(8, 1, 30);
    expect(uptime.stop()).toBe(true);
    now = localTime(8, 6, 30);
    uptime.start();
    now = localTime(8, 7, 30);
    uptime.stop();
    await uptime.settled();
    expect(uptime.snapshot().todayMs).toBe(90 * minute);
    expect(persistence.startGlobalMiningUptime).toHaveBeenCalledTimes(2);
    expect(persistence.stopGlobalMiningUptime).toHaveBeenCalledTimes(2);
  });

  it('adds the current active interval to persisted completed time', async () => {
    let now = localTime(8, 10);
    const uptime = await GlobalMiningUptime.hydrate(storage(30 * minute), () => now);
    uptime.start();
    now = localTime(8, 10, 20);
    expect(uptime.snapshot()).toMatchObject({ active: true, todayMs: 50 * minute });
  });

  it('keeps one interval for thirteen concurrent wallet requests', async () => {
    const persistence = storage();
    let now = localTime(8, 12);
    const uptime = await GlobalMiningUptime.hydrate(persistence, () => now);
    for (let wallet = 0; wallet < 13; wallet += 1) uptime.start();
    now += 60 * minute;
    uptime.stop();
    await uptime.settled();
    expect(uptime.snapshot().todayMs).toBe(60 * minute);
    expect(persistence.startGlobalMiningUptime).toHaveBeenCalledOnce();
    expect(persistence.stopGlobalMiningUptime).toHaveBeenCalledOnce();
  });

  it('persists a bounded activity heartbeat only while mining intent is active', async () => {
    let now = localTime(8, 12);
    const persistence = storage();
    const uptime = await GlobalMiningUptime.hydrate(persistence, () => now);

    expect(uptime.heartbeat()).toBe(false);
    uptime.start();
    now += minute - 1;
    expect(uptime.heartbeat()).toBe(false);
    now += 1;
    expect(uptime.heartbeat()).toBe(true);
    expect(uptime.heartbeat()).toBe(false);
    await uptime.settled();
    expect(persistence.heartbeatGlobalMiningUptime).toHaveBeenCalledOnce();
    expect(persistence.startGlobalMiningUptime).toHaveBeenCalledOnce();

    uptime.stop();
    now += minute;
    expect(uptime.heartbeat()).toBe(false);
  });

  it('splits an active interval at local midnight', async () => {
    let now = localTime(8, 23, 30);
    const uptime = await GlobalMiningUptime.hydrate(storage(), () => now);
    uptime.start();
    now = localTime(9, 0, 30);
    expect(uptime.snapshot()).toMatchObject({
      todayMs: 30 * minute,
      history: [
        { date: '2026-08-08', durationMs: 30 * minute },
        { date: '2026-08-07', durationMs: 0 },
        { date: '2026-08-06', durationMs: 0 },
      ],
    });
    uptime.stop();
    expect(uptime.snapshot().todayMs).toBe(30 * minute);
  });

  it('projects exactly the three previous local days including a zero day', async () => {
    const now = localTime(9, 9);
    const uptime = await GlobalMiningUptime.hydrate(
      storage(45 * minute, null, [
        { date: '2026-08-08', durationMs: 7 * 60 * minute + 18 * minute },
        { date: '2026-08-07', durationMs: 0 },
        { date: '2026-08-06', durationMs: 5 * 60 * minute + 37 * minute },
        { date: '2026-08-05', durationMs: 99 * minute },
      ]),
      () => now,
    );

    expect(uptime.snapshot()).toMatchObject({
      todayMs: 45 * minute,
      history: [
        { date: '2026-08-08', durationMs: 7 * 60 * minute + 18 * minute },
        { date: '2026-08-07', durationMs: 0 },
        { date: '2026-08-06', durationMs: 5 * 60 * minute + 37 * minute },
      ],
    });
    expect(uptime.snapshot().history).toHaveLength(3);
  });

  it('hydrates completed uptime after an application restart', async () => {
    const now = localTime(8, 9);
    const uptime = await GlobalMiningUptime.hydrate(
      storage(75 * minute, null, [
        { date: '2026-08-07', durationMs: 3 * 60 * minute },
        { date: '2026-08-06', durationMs: 2 * 60 * minute },
        { date: '2026-08-05', durationMs: 60 * minute },
      ]),
      () => now,
    );
    expect(uptime.snapshot()).toMatchObject({
      todayMs: 75 * minute,
      history: [
        { date: '2026-08-07', durationMs: 3 * 60 * minute },
        { date: '2026-08-06', durationMs: 2 * 60 * minute },
        { date: '2026-08-05', durationMs: 60 * minute },
      ],
    });
  });

  it('closes an active interval exactly once during clean disposal', async () => {
    let now = localTime(8, 14);
    const persistence = storage();
    const uptime = await GlobalMiningUptime.hydrate(persistence, () => now);
    uptime.start();
    now += 24 * minute;
    await uptime.dispose();
    await uptime.dispose();
    expect(persistence.stopGlobalMiningUptime).toHaveBeenCalledOnce();
    expect(uptime.snapshot()).toMatchObject({ active: false, todayMs: 24 * minute });
  });
});
