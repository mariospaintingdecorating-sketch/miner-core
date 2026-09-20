import { describe, it, expect, vi } from 'vitest';
import { approvalReadBefore } from './ApprovalDeadline';
describe('wallet approval controller deadline', () => {
  it('returns a timely SDK resource without freeing ownership prematurely', async () => {
    const free = vi.fn(); const value={free};
    expect(await approvalReadBefore(Promise.resolve(value), Date.now()+1000)).toBe(value);
    expect(free).not.toHaveBeenCalled();
  });
  it('times out a hung read and frees a late result exactly once', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (x:{free:()=>void})=>void;
      const operation=new Promise<{free:()=>void}>(r=>{resolve=r;});
      const result=approvalReadBefore(operation,Date.now()+100);
      const rejection=expect(result).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(100); await rejection;
      const free=vi.fn(); resolve({free}); await Promise.resolve();
      expect(free).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('retains a genuine read error instead of inventing an approval rejection', async () => {
    const error=new Error('network read failed');
    await expect(approvalReadBefore(Promise.reject(error),Date.now()+1000)).rejects.toBe(error);
  });
});
