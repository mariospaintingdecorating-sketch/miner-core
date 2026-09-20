/* Offline inspection of the actual packaged application, not just source files. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = process.cwd();
const expectedAppId = '0x0000000000000000000000000000000000000000000000000000000000000030';
const expectedWasm = 'deb6f6ea9278f82fab58ed9167adb3cbf3644ecb73a5f7b71acac227a6797e95';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const archive = path.join(root, 'release/win-unpacked/resources/app.asar');
const read = name => asar.extractFile(archive, path.normalize(name));
const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.version, '0.2.1-beta');
assert.equal(pkg.dependencies['@teamgosh/bee-sdk'], '5.1.1');
const sdk = JSON.parse(read('node_modules/@teamgosh/bee-sdk/package.json'));
assert.equal(sdk.version, '5.1.1');
assert.equal(hash(read('node_modules/@teamgosh/bee-sdk/bee_sdk_bg.wasm')), expectedWasm);
const entries = asar.listPackage(archive).map(p => p.replaceAll('\\', '/').replace(/^\//, ''));
const rendererWasm = entries.find(p => /^dist\/assets\/bee_sdk_bg-.*\.wasm$/.test(p));
assert.ok(rendererWasm, 'renderer WASM missing');
assert.equal(hash(read(rendererWasm)), expectedWasm);
const js = entries.filter(p => /^dist\/assets\/index-.*\.js$/.test(p)).map(p => read(p).toString()).join('\n');
assert.ok(js.includes(expectedAppId), 'DApp identity missing from production renderer');
assert.ok(js.includes('0.2.1 beta'), 'visible release version missing');
assert.match(js, /minimumStartWindowMs\s*:\s*(?:145000|145e3)/);
assert.match(js, /firstTapDelayMs\s*:\s*1720/);
const worker = read('dist-electron/beeMiningUtilityWorker.js').toString();
assert.ok(worker.includes('@teamgosh/bee-sdk'));
assert.ok(worker.includes('bee_sdk_bg.wasm'));
const userData = read('dist-electron/userData.js').toString();
assert.ok(userData.includes("'Miner Core'"), 'installed profile directory changed');
assert.ok(userData.includes('miner-core.sqlite'));
const exePath = path.join(root, 'release/win-unpacked/Core Miner.exe');
const exe = fs.readFileSync(exePath); assert.equal(exe.toString('ascii', 0, 2), 'MZ');
const pe = exe.readUInt32LE(0x3c); assert.equal(exe.readUInt16LE(pe + 4), 0x8664);
const installerName = 'Core Miner 0.2.1 beta setup.exe';
const installer = fs.readFileSync(path.join(root, 'release', installerName));
assert.equal(installer.toString('ascii', 0, 2), 'MZ');
const report = { checkedAt: new Date().toISOString(), platform: process.platform,
  sourceCommit: process.env.SOURCE_COMMIT ?? null, packageVersion: pkg.version,
  sdkVersion: sdk.version, sdkWasmSha256: expectedWasm, dappId: expectedAppId,
  installer: { name: installerName, bytes: installer.length, sha256: hash(installer) },
  application: { architecture: 'x64', sha256: hash(exe) },
  assertions: ['packaged version', 'packaged SDK', 'utility WASM hash', 'renderer WASM hash',
    'production DApp', 'visible version', 'session policy', 'native worker SDK binding',
    'legacy installed data path', 'x64 executable', 'installer name and header'],
  miningOnChainTested: false, walletAuthorizationOnChainTested: false };
fs.mkdirSync('verification', { recursive: true });
fs.writeFileSync('verification/packaged-verification.json', JSON.stringify(report, null, 2));
fs.writeFileSync('verification/SHA256SUMS.txt', `${hash(installer)}  ${installerName}\n`);
console.log(JSON.stringify(report, null, 2));
