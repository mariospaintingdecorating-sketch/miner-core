// Launch the real packaged x64 EXE with a throwaway profile. No wallet/mining actions.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const profile = await mkdtemp(join(tmpdir(), 'core-miner-021-smoke-'));
await mkdir(join(profile, 'Roaming'), { recursive: true });
await mkdir(join(profile, 'Local'), { recursive: true });
await mkdir('verification', { recursive: true });
const exe = resolve('release/win-unpacked/Core Miner.exe');
const child = spawn(exe, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=19221',
  '--proxy-server=http://127.0.0.1:9', '--disable-gpu'], {
  env: { ...process.env, APPDATA: join(profile, 'Roaming'), LOCALAPPDATA: join(profile, 'Local') },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
});
let logs = ''; child.stdout.on('data', b => { logs += b.toString(); });
child.stderr.on('data', b => { logs += b.toString(); });
const pause = ms => new Promise(r => setTimeout(r, ms));
let ws; let nextId = 0; const requests = new Map(); const exceptions = [];
try {
  let page;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null) throw new Error(`App exited during startup: ${child.exitCode}`);
    try {
      const pages = await (await fetch('http://127.0.0.1:19221/json', { signal: AbortSignal.timeout(1000) })).json();
      page = pages.find(p => p.type === 'page' && p.url.startsWith('file:'));
      if (page) break;
    } catch {}
    await pause(500);
  }
  assert.ok(page, 'No packaged renderer appeared');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const pending = requests.get(message.id);
    if (pending) { requests.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result); }
  });
  function cdp(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
      requests.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  let state;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await cdp('Runtime.evaluate', { expression: `JSON.stringify({ text: document.body.innerText,
      appBridge: !!window.minerCoreApp, storageBridge: !!window.minerCoreStorage,
      ready: document.readyState })`, returnByValue: true });
    state = JSON.parse(result.result.value);
    if (state.text.includes('0.2.1 beta') && state.appBridge && state.storageBridge) break;
    await pause(500);
  }
  assert.ok(state.text.includes('Core Miner') && state.text.includes('0.2.1 beta'), 'Versioned app UI did not render');
  assert.ok(state.text.includes('Bee SDK 5.1.1'), 'SDK build identity missing');
  assert.ok(state.appBridge && state.storageBridge, 'Electron preload bridge missing');
  const wallets = await cdp('Runtime.evaluate', { expression: 'window.minerCoreStorage.listWallets().then(x => x.length)', awaitPromise: true, returnByValue: true });
  assert.equal(wallets.result.value, 0, 'Smoke profile must contain no wallets');
  await pause(1500);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile('verification/windows-app-smoke.png', Buffer.from(shot.data, 'base64'));
  await writeFile('verification/windows-smoke.json', JSON.stringify({
    success: true, platform: process.platform, packagedExe: exe, emptyProfile: true,
    appBridge: state.appBridge, storageBridge: state.storageBridge,
    realMiningStarted: false, onChainAuthorizationTested: false,
    browserHttpBlocked: true, uncaughtRendererExceptions: exceptions,
    text: state.text,
  }, null, 2));
  assert.equal(exceptions.length, 0, 'Uncaught renderer errors');
  console.log('Packaged Windows EXE rendered with a fresh empty profile and working preload. No mining started.');
} finally {
  ws?.close();
  if (child.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  await writeFile('verification/windows-smoke-process.log', logs);
}
