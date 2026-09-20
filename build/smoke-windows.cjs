'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { platform: process.platform, packagedAppLaunched: false, networkBlockedBeforeReload: false, realWalletsTested: false, mainnetMiningTested: false, errors: [] };
let child, socket;
(async () => {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Smoke test is restricted to a clean CI runner.');
  const profileDb = path.join(process.env.APPDATA, 'Miner Core', 'miner-core.sqlite');
  assert.ok(!fs.existsSync(profileDb), 'Refusing to touch an existing profile.');
  child = cp.spawn(path.resolve('release/win-unpacked/Core Miner.exe'), ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9237'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (b) => logs.push(b.toString()));
  child.stderr.on('data', (b) => logs.push(b.toString()));
  let target;
  for (let n = 0; n < 60; n++) {
    if (child.exitCode !== null) throw new Error('Packaged app exited before UI loaded: ' + logs.join('').slice(-3000));
    try {
      const response = await fetch('http://127.0.0.1:9237/json/list', { signal: AbortSignal.timeout(1000) });
      target = (await response.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await sleep(500);
  }
  assert.ok(target, 'Packaged UI did not expose a page within 30 seconds.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') report.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  await command('Network.enable');
  await command('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
  await command('Runtime.enable');
  report.errors = [];
  await command('Page.reload', { ignoreCache: true });
  report.networkBlockedBeforeReload = true;
  await sleep(4500);
  const result = await command('Runtime.evaluate', { expression: `(async () => ({ text: document.body.innerText, rootChildren: document.querySelector('#root')?.childElementCount || 0, bridge: typeof window.minerCoreApp, storage: typeof window.minerCoreStorage, wallets: await window.minerCoreStorage.listWallets(), versions: window.minerCoreApp.versions }))()`, awaitPromise: true, returnByValue: true });
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  const value = result.result.value;
  assert.ok(value.rootChildren > 0, 'Empty application root');
  assert.match(value.text, /Core Miner/i);
  assert.equal(value.bridge, 'object'); assert.equal(value.storage, 'object');
  assert.ok(Array.isArray(value.wallets)); assert.equal(value.wallets.length, 0);
  report.packagedAppLaunched = true;
  report.renderedText = value.text;
  report.versions = value.versions;
  report.emptyWalletStorageConfirmed = true;
  async function evaluate(expression) {
    const value = await command('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true});
    assert.ok(!value.exceptionDetails, JSON.stringify(value.exceptionDetails));return value.result.value;
  }
  async function waitFor(expression, label, limit=20000) {
    for(let elapsed=0;elapsed<limit;elapsed+=200){if(await evaluate(expression))return;await sleep(200);}throw new Error('UI timeout: '+label);
  }
  async function clickText(label) {
    return evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true;})()`);
  }
  await evaluate(`localStorage.setItem('miner-core.ui-language','en')`);
  await command('Page.reload',{ignoreCache:true});await sleep(2500);
  await evaluate(`document.querySelectorAll('.sidebar-navigation button')[1].click()`);
  await waitFor(`Boolean([...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Add wallet'))`,'wallet view');
  assert.ok(await clickText('Add wallet'));
  await waitFor(`Boolean(document.querySelector('.wallet-registration-panel input'))`,'account form');
  await evaluate(`(() => {const input=document.querySelector('.wallet-registration-panel input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'offline_ci_wallet');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(200);await evaluate(`document.querySelector('.wallet-registration-panel').requestSubmit()`);
  await waitFor(`Boolean(document.querySelector('.wallet-approval-qr svg'))`,'real SDK key generation and QR');
  const svgBefore=await evaluate(`document.querySelector('.wallet-approval-qr svg').outerHTML`);
  const publicRecords=await evaluate(`window.minerCoreStorage.listWallets()`);
  assert.equal(publicRecords.length,1);assert.equal(publicRecords[0].onboardingStatus,'awaiting-connection');
  assert.equal(publicRecords[0].miningCredentialReference,null);
  const connectedReference=publicRecords[0].connectionReference;
  assert.ok(connectedReference);
  assert.ok(await clickText('Pause verification'),'Pause must remain clickable during authorization');
  await waitFor(`Boolean([...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Resume authorization'&&!b.disabled))`,'paused authorization');
  assert.equal((await evaluate(`window.minerCoreStorage.listWallets()`))[0].connectionReference,connectedReference);
  assert.ok(await clickText('Resume authorization'));
  await waitFor(`Boolean(document.querySelector('.wallet-approval-qr svg'))`,'same request resumed');
  assert.equal(await evaluate(`document.querySelector('.wallet-approval-qr svg').outerHTML`),svgBefore,'Resume must not regenerate the key or QR');
  const picture=await command('Page.captureScreenshot',{format:'png'});report.screenshotPngBase64=picture.data;
  report.directQrGeneratedWithRealSdk=true;report.localKeyStoredBeforeApproval=true;
  report.pauseWorksDuringPendingApproval=true;report.sameQrAfterResume=true;report.notReadyWithoutChainApproval=true;
  assert.ok(await clickText('Pause verification'));await sleep(500);
  await command('Page.reload',{ignoreCache:true});await sleep(3000);
  await evaluate(`document.querySelectorAll('.sidebar-navigation button')[1].click()`);
  await waitFor(`Boolean(document.querySelector('.wallet-toolbar select'))`,'restored wallet view');
  await evaluate(`(() => {const input=document.querySelector('.wallet-toolbar select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,${JSON.stringify(publicRecords[0].id)});input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`Boolean([...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Resume authorization'&&!b.disabled))`,'restored request');
  assert.ok(await clickText('Resume authorization'));await waitFor(`Boolean(document.querySelector('.wallet-approval-qr svg'))`,'QR after renderer restart');
  assert.equal(await evaluate(`document.querySelector('.wallet-approval-qr svg').outerHTML`),svgBefore);
  report.sameQrAfterRendererReload=true;
  assert.ok(await clickText('Pause verification'));await sleep(400);
  assert.equal(report.errors.length,0,'Unhandled JavaScript exceptions: '+report.errors.join('\n'));
  report.passed=true;
  await command('Runtime.evaluate', { expression: 'window.minerCoreApp.windowControls.close()' });
  await sleep(1500);
  report.processExitedAfterClose = child.exitCode !== null;
})().catch((error) => { report.passed = false; report.error = String(error.stack || error); process.exitCode = 1; }).finally(() => {
  socket?.close();
  if (child && child.exitCode === null) cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  fs.writeFileSync('release/Core-Miner-0.2.2-windows-smoke-verification.json', JSON.stringify(report, null, 2));
  const { screenshotPngBase64, ...printable } = report;
  console.log(JSON.stringify(printable, null, 2));
});
