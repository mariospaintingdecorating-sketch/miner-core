/** Bounds a read, not a chain write. A late WASM wrapper is disposed, never committed. */
export function approvalReadBefore<T extends { free(): void }>(operation: Promise<T>, deadlineMs: number,
  now: () => number = Date.now): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const remaining = Math.max(0, deadlineMs - now());
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Wallet approval timed out. No mining key was replaced.'));
    }, remaining);
    operation.then((value) => {
      if (settled) { try { value.free(); } catch { /* best-effort disposal of an unused result */ } return; }
      settled = true; clearTimeout(timer); resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    });
  });
}
