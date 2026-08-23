import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import initializeBeeSdk, {
  BeeConnect,
  Miner,
  ensure_mining_keys_propagated,
} from '@teamgosh/bee-sdk';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('@teamgosh/bee-sdk 4.0.0 compatibility', () => {
  it('loads the pinned WASM module and exposes the Core integration API', async () => {
    const packageJsonPath = require.resolve('@teamgosh/bee-sdk/package.json');
    const wasmPath = require.resolve('@teamgosh/bee-sdk/bee_sdk_bg.wasm');
    const packageJson = JSON.parse(
      await readFile(packageJsonPath, 'utf8'),
    ) as { readonly version?: unknown };
    const wasmBytes = await readFile(wasmPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);

    await initializeBeeSdk({ module_or_path: wasmModule });

    expect(packageJson.version).toBe('4.0.0');
    expect(wasmBytes.byteLength).toBe(8_445_665);
    expect(createHash('sha256').update(wasmBytes).digest('hex')).toBe(
      '7139200cf57c032e44504e7d172c17f3cd6b9851e26e7d0cbba8381bc54de6f8',
    );
    expect(typeof Miner.new).toBe('function');
    expect(typeof BeeConnect).toBe('function');
    expect(typeof ensure_mining_keys_propagated).toBe('function');
  });
});
