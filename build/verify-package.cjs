'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve('release/win-unpacked/resources');
const archive = path.join(root, 'app.asar');
const out = path.resolve('release');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (name) => asar.extractFile(archive, name.split('/').join(path.sep));
const entries = asar.listPackage(archive).map((s) => s.replaceAll('\\', '/').replace(/^\//, ''));
const report = { checks: [], productionAudit: null, realWalletsTested: false, mainnetMiningTested: false };
function check(name, fn) { fn(); report.checks.push({ name, passed: true }); }
try {
  check('packaged application version and identity', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.version, '0.2.1-beta');
    assert.equal(pkg.productName, 'Core Miner');
    assert.equal(pkg.dependencies['@teamgosh/bee-sdk'], '5.1.1');
  });
  for (const [relative, expected] of [
    ['node_modules/@teamgosh/bee-sdk/bee_sdk_bg.wasm', 'deb6f6ea9278f82fab58ed9167adb3cbf3644ecb73a5f7b71acac227a6797e95'],
    ['node_modules/@msii/bee-miner/bee_miner_bg.wasm', '9b89b542ea0506ac89bc00bf007fee3f1e71a5238a65bf6408c20ae59795ce30'],
  ]) check('packaged hash: ' + relative, () => assert.equal(sha(read(relative)), expected));
  for (const prefix of ['bee_sdk_bg-', 'bee_miner_bg-']) {
    const assets = entries.filter((name) => name.startsWith('dist/assets/' + prefix) && name.endsWith('.wasm'));
    check('one renderer asset: ' + prefix, () => assert.equal(assets.length, 1));
    const expected = prefix === 'bee_sdk_bg-' ? 'deb6f6ea9278f82fab58ed9167adb3cbf3644ecb73a5f7b71acac227a6797e95' : '9b89b542ea0506ac89bc00bf007fee3f1e71a5238a65bf6408c20ae59795ce30';
    check('renderer WASM hash: ' + prefix, () => assert.equal(sha(read(assets[0])), expected));
  }
  check('utility worker selects queue-aware SDK', () => {
    assert.match(read('dist-electron/beeMiningUtilityWorker.js').toString(), /@msii\/bee-miner/);
  });
  check('CommonJS MamaBoard helper is packaged', () => {
    assert.match(read('dist-electron/chainAddress.cjs').toString(), /parseMinerContractAddress/);
    assert.match(read('dist-electron/mamaBoardReaderWorker.cjs').toString(), /chainAddress\.cjs/);
  });
  check('renderer contains intended authorization ID', () => {
    const text = entries.filter((n) => n.startsWith('dist/assets/') && n.endsWith('.js')).map((n) => read(n).toString()).join('\n');
    assert.ok(text.includes('0x' + '0'.repeat(62) + '30'));
  });
  check('native MamaBoard dependency is present and unpacked', () => {
    const native = entries.filter((n) => n.startsWith('node_modules/@eversdk/lib-node/') && n.endsWith('.node'));
    assert.ok(native.length > 0, 'Missing @eversdk/lib-node native binary; review its postinstall approval.');
    report.nativeLibraries = native.map((n) => {
      const p = path.join(root, 'app.asar.unpacked', n);
      const b = fs.readFileSync(p);
      assert.equal(b.subarray(0, 2).toString(), 'MZ');
      return { path: n, bytes: b.length, sha256: sha(b) };
    });
  });
  const audit = cp.spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000 });
  fs.writeFileSync(path.join(out, 'Core-Miner-0.2.1-production-audit.json'), audit.stdout || JSON.stringify({ error: audit.error?.message || audit.stderr }));
  try { report.productionAudit = JSON.parse(audit.stdout).metadata?.vulnerabilities ?? { unavailable: true }; }
  catch { report.productionAudit = { unavailable: true }; }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'Core-Miner-0.2.1-package-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
