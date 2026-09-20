import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import initialize, { Miner, gen_mining_keys } from '@msii/bee-miner';
import { describe, it, expect } from 'vitest';
const require=createRequire(import.meta.url);
describe('pinned queue-aware mining module',()=>{
  it('loads the separately identified mining WASM and exports the production API',async()=>{
    const meta=JSON.parse(await readFile(require.resolve('@msii/bee-miner/package.json'),'utf8'));
    const bytes=await readFile(require.resolve('@msii/bee-miner/bee_miner_bg.wasm'));
    expect(meta.version).toBe('5.1.1-core.1');expect(bytes.byteLength).toBe(7040460);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('9b89b542ea0506ac89bc00bf007fee3f1e71a5238a65bf6408c20ae59795ce30');
    await initialize({module_or_path:await WebAssembly.compile(bytes)});
    expect(typeof Miner.new).toBe('function');expect(typeof Miner.prototype.add_tap).toBe('function');
    expect(typeof Miner.prototype.get_miner_data).toBe('function');
    const key=await gen_mining_keys('0x'+'30'.padStart(64,'0'));
    try { expect(key.public).toMatch(/^[0-9a-f]{64}$/i);expect(key.secret.length).toBeGreaterThan(0); } finally {key.free();}
  });
});
