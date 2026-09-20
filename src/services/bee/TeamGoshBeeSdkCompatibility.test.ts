import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import initializeBeeSdk, {
  BeeConnect,
  Miner,
  gen_mining_keys,
  ensure_mining_keys_propagated,
} from '@teamgosh/bee-sdk';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('@teamgosh/bee-sdk 5.1.1 compatibility', () => {
  it('loads the pinned WASM module and exposes the Core integration API', async () => {
    const packageJsonPath = require.resolve('@teamgosh/bee-sdk/package.json');
    const wasmPath = require.resolve('@teamgosh/bee-sdk/bee_sdk_bg.wasm');
    const packageJson = JSON.parse(
      await readFile(packageJsonPath, 'utf8'),
    ) as { readonly version?: unknown };
    const wasmBytes = await readFile(wasmPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);

    await initializeBeeSdk({ module_or_path: wasmModule });

    expect(packageJson.version).toBe('5.1.1');
    expect(wasmBytes.byteLength).toBe(8_427_428);
    expect(createHash('sha256').update(wasmBytes).digest('hex')).toBe(
      'deb6f6ea9278f82fab58ed9167adb3cbf3644ecb73a5f7b71acac227a6797e95',
    );
    const appId = '0x' + '30'.padStart(64, '0');
    const keys = await gen_mining_keys(appId);
    try {
      const link = new URL(keys.deep_link);
      expect(link.origin).toBe('https://links.gosh.sh');
      expect(link.pathname).toBe('/deeplinks/wallet/v2/set-mining-keys');
      const payload = JSON.parse(Buffer.from(link.searchParams.get('payload')!, 'base64url').toString());
      expect(payload).toEqual({pubkey: keys.public, app_id: appId});
      expect(keys.public).toMatch(/^[0-9a-f]{64}$/i);
      expect(keys.secret).toMatch(/^[0-9a-f]{64}$/i);
      expect(keys.deep_link).not.toContain(keys.secret);
    } finally { keys.free(); }
    expect(typeof Miner.new).toBe('function');
    expect(typeof BeeConnect).toBe('function');
    expect(typeof ensure_mining_keys_propagated).toBe('function');
  });
});
