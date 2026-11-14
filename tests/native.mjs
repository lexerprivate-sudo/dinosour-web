// Exercise the actual bundled UI and Android JS adapter with a desktop
// implementation of its native boundary. No Dinosour Node server or tunnel is
// used. Android process execution still requires a device smoke test.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const origin = 'https://appassets.androidplatform.net';
const engineBinary = 'android/app/build/playbackEngine/yt-dlp';
await access(engineBinary); // Run the Android build first: test the exact shipped yt-dlp.
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await context.newPage();
page.setDefaultTimeout(120000);
const errors = [], pcRequests = [], nativeCalls = [];
const mediaResponses = [];
page.on('response', response => { if (response.url().includes('.googlevideo.com/')) mediaResponses.push(response.status()); });
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (/localhost|127\.0\.0\.1|trycloudflare\.com/.test(request.url())) pcRequests.push(request.url());
});
const jobs = new Map();
const storage = {};
const userAgent = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
await context.route(origin + '/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/api/thumb/')) return route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="teal"/></svg>',
  });
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = relative.startsWith('native/') ? relative.slice(7) : 'public/' + relative;
  try {
    const body = await readFile(file);
    const contentType = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' :
      relative.endsWith('.png') ? 'image/png' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    await route.fulfill({ contentType, body });
  } catch { await route.fulfill({ status: 404, body: '' }); }
});
await page.exposeFunction('nativeTransport', async (id, kind, raw) => {
  const input = JSON.parse(raw);
  nativeCalls.push({ kind, input });
  try {
    let result;
    if (kind === 'http') {
      const response = await fetch(input.url, {
        method: input.method, headers: input.headers, body: input.body || undefined,
        signal: AbortSignal.timeout(22000),
      });
      result = { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
    } else if (kind === 'extract') {
      result = await new Promise((resolve, reject) => {
        const child = spawn(process.env.PYTHON_PATH || 'python', [engineBinary, '--ignore-config', '--no-warnings', '--no-playlist', '--skip-download',
          '--dump-single-json', '--socket-timeout', '12', '--retries', '1', '--extractor-retries', '1',
          '--js-runtimes', 'node', '--user-agent', userAgent, '--', 'https://www.youtube.com/watch?v=' + input.id], { windowsHide: true });
        jobs.set(id, child);
        let out = '', err = '';
        child.stdout.on('data', chunk => out += chunk);
        child.stderr.on('data', chunk => err += chunk);
        const timer = setTimeout(() => child.kill(), 100000);
        child.on('error', reject);
        child.on('close', code => {
          clearTimeout(timer); jobs.delete(id);
          code === 0 ? resolve(out) : reject(new Error(err.slice(-1000)));
        });
      });
    }
    await page.evaluate(({ id, result }) => window.__dinosourNativeResult(id, { ok: true, result }), { id, result });
  } catch (error) {
    if (!page.isClosed()) await page.evaluate(({ id, error }) => window.__dinosourNativeResult(id, { ok: false, error }), { id, error: error.message });
  }
});
await page.exposeFunction('nativeCancel', id => jobs.get(id)?.kill());
await page.exposeFunction('nativeSave', (key, value) => storage[key] = value);
await page.addInitScript(() => {
  window.DinosourAndroid = {
    nativeRequest: (id, kind, raw) => { window.nativeTransport(id, kind, raw); },
    cancelRequest: id => { window.nativeCancel(id); },
    readStorage: () => JSON.stringify({ 'dinosour.ui.v1': JSON.stringify({ topics: ['Nature'], volume: 0.5, muted: false }) }),
    saveStorage: (key, value) => { window.nativeSave(key, value); },
    openSettings: () => {}, versionName: () => '1.1.0',
  };
});

try {
  await page.goto(origin + '/#home');
  await page.locator('#feed .card').first().waitFor();
  assert.equal(await page.evaluate(() => window.__dinosourStandalone), true);
  assert.ok(nativeCalls.some(call => call.kind === 'http' && call.input.url.includes('youtube.com')));
  assert.equal(await page.locator('#android-settings').isVisible(), true);
  await page.locator('#share-app').click();
  await page.locator('#share-native-dialog').waitFor();
  assert.match(await page.locator('#share-native-dialog').innerText(), /no computer or access code/);
  assert.equal(await page.locator('#share-code').count(), 0);
  await page.locator('#share-native-dialog [data-close]').click();

  // Real direct media, with extraction through the native transport boundary.
  await page.goto(origin + '/#watch=aqz-KE-bpKQ');
  await page.waitForFunction(() => {
    const video = document.querySelector('#video'), audio = document.querySelector('#audio');
    return video?.currentTime > 2 && !video.paused && audio?.currentTime > 1 && !audio.paused;
  });
  const state = await page.evaluate(() => ({
    video: document.querySelector('#video').src,
    audio: document.querySelector('#audio').src,
    delta: Math.abs(document.querySelector('#video').currentTime - document.querySelector('#audio').currentTime),
  }));
  assert.match(state.video, /^https:\/\/[^/]+\.googlevideo\.com\//);
  assert.match(state.audio, /^https:\/\/[^/]+\.googlevideo\.com\//);
  assert.ok(state.delta < 2, JSON.stringify(state));
  await page.locator('#save').click();
  assert.ok(JSON.parse(storage['dinosour.library.v1']).saved.some(v => v.id === 'aqz-KE-bpKQ'));
  assert.deepEqual(pcRequests, []);
  assert.deepEqual(errors, []);
  console.log('PASS: bundled mobile UI, live native search, direct video/audio, no PC/tunnel requests, simple app sharing and native storage backup.');
} catch (error) {
  console.error(await page.evaluate(() => ({
    status: document.querySelector('#player-status')?.textContent,
    video: document.querySelector('#video') && { time: document.querySelector('#video').currentTime, error: document.querySelector('#video').error?.message, src: document.querySelector('#video').src.slice(0, 160) },
    audio: document.querySelector('#audio') && { time: document.querySelector('#audio').currentTime, error: document.querySelector('#audio').error?.message },
  })));
  console.error({ errors, mediaResponses, calls: nativeCalls.map(c => ({ kind: c.kind, id: c.input.id })) });
  throw error;
} finally {
  for (const child of jobs.values()) child.kill();
  await browser.close();
}
