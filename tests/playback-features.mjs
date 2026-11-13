import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';

await mkdir('test-results', { recursive: true });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'test-results/features.mp4']);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050', '-t', '40', '-c:a', 'aac', '-movflags', '+faststart', 'test-results/features.m4a']);
const videoBytes = await readFile('test-results/features.mp4'), audioBytes = await readFile('test-results/features.m4a');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
page.setDefaultTimeout(30000);
const errors = [];
const qualityRequests = [];
page.on('request', r => { if (r.url().includes('/feature-video?')) qualityRequests.push(new URL(r.url()).searchParams.get('height')); });
page.on('pageerror', e => errors.push(e.message));
const items = ['aqz-KE-bpKQ', 'jNQXAC9IVRw', 'H8hVCPzVCIM'].map((id, i) => ({ id, title: `Test video ${i + 1}`, channel: 'Test channel', type: 'video', thumb: `/api/thumb/${id}` }));
let refreshes = 0;
const infoFor = id => ({
  ...items.find(v => v.id === id), duration: 40,
  qualities: [1080, 720, 480, 360].map(height => ({ height, label: `${height}p`, separateAudio: true, src: `/feature-video?height=${height}&rev=${refreshes}` })),
  audio: `/feature-audio?language=en&rev=${refreshes}`, audioFallbacks: [],
  audioTracks: [
    { id: 'en-original', language: 'en', original: true, label: 'English (Original)', src: `/feature-audio?language=en&rev=${refreshes}`, fallbacks: [] },
    { id: 'es', language: 'es', original: false, label: 'Spanish', src: `/feature-audio?language=es&rev=${refreshes}`, fallbacks: [] },
  ],
  captions: [{ language: 'en', label: 'English', src: '/feature-captions' }],
});
function serveMedia(route, body, contentType) {
  const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!range) return route.fulfill({ contentType, headers: { 'accept-ranges': 'bytes' }, body });
  const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  return route.fulfill({ status: 206, contentType, headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) });
}
await page.route('**/feature-video?*', route => serveMedia(route, videoBytes, 'video/mp4'));
await page.route('**/feature-audio?*', route => serveMedia(route, audioBytes, 'audio/mp4'));
await page.route('**/feature-captions', route => route.fulfill({ contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:00.000 --> 00:00:39.000\nTest English captions\n' }));
await page.route('**/api/video?*', route => {
  const url = new URL(route.request().url());
  if (url.searchParams.has('refresh')) refreshes++;
  return route.fulfill({ json: infoFor(url.searchParams.get('id')) });
});
await page.route('**/api/search?*', route => route.fulfill({ json: { videos: items, continuation: null } }));
await page.route('**/api/thumb/*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="teal"/></svg>' }));
// Exercise the WebView-style fallback as well as the explicit mini-player.
await page.addInitScript(() => Object.defineProperty(document, 'pictureInPictureEnabled', { value: false }));
const playing = () => page.waitForFunction(() => {
  const v = document.querySelector('#video'), a = document.querySelector('#audio');
  return v && !v.paused && v.currentTime > .2 && a && !a.paused && Math.abs(v.currentTime - a.currentTime) < .6;
});
try {
  await page.goto(`http://127.0.0.1:3210/#watch=${items[0].id}`);
  await playing();
  assert.equal(await page.locator('#quality').inputValue(), 'auto');
  assert.equal(qualityRequests[0], '480');
  // Simulate elapsed healthy playback without a 25-second wall-clock wait.
  await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 30000; });
  await page.waitForFunction(() => document.querySelector('#video').src.includes('height=720'));
  await playing();
  await page.locator('#quality').selectOption({ label: '360p' });
  await playing();
  assert.match(await page.locator('#video').getAttribute('src'), /height=360/);
  await page.locator('#audio-language').selectOption('es');
  await playing();
  assert.match(await page.locator('#audio').getAttribute('src'), /language=es/);
  await page.locator('#captions').selectOption('en');
  await page.waitForFunction(() => {
    const t = document.querySelector('#video').textTracks[0];
    return t?.mode === 'showing' && t.cues?.length > 0;
  });
  await page.locator('#volume').fill('0.4');
  await page.locator('#speed').selectOption('1.5');
  await page.evaluate(() => { document.querySelector('#video').currentTime = 8; });
  await playing();
  // Trigger the recovery handler with the media element and position intact.
  await page.evaluate(() => {
    window.beforeRecovery = document.querySelector('#video');
    window.beforePosition = window.beforeRecovery.currentTime;
    window.beforeRecovery.dispatchEvent(new Event('error'));
  });
  await page.waitForFunction(() => document.querySelector('#audio').src.includes('rev=1'));
  await playing();
  assert.equal(refreshes, 1);
  assert.equal(await page.evaluate(() => window.beforeRecovery === document.querySelector('#video')), true);
  assert.equal(await page.evaluate(() => document.querySelector('#video').currentTime >= window.beforePosition - .1), true,
    JSON.stringify(await page.evaluate(() => ({ before: window.beforePosition, now: document.querySelector('#video').currentTime }))));
  assert.equal(await page.locator('#speed').inputValue(), '1.5');
  assert.equal(await page.locator('#audio-language').inputValue(), 'es');
  assert.equal(await page.locator('#captions').inputValue(), 'en');
  assert.match(await page.locator('#audio').getAttribute('src'), /language=es/);
  assert.equal(await page.locator('.watch-loading').isHidden(), true);

  await page.locator('#pip-toggle').click();
  await page.locator('#mini-player:not([hidden])').waitFor();
  await page.locator('#results .card').first().waitFor();
  await playing();
  assert.equal(await page.evaluate(() => window.beforeRecovery === document.querySelector('#video')), true);
  await page.locator(`[data-queue-add="${items[1].id}"]`).first().click();
  await page.locator(`[data-queue-next="${items[2].id}"]`).first().click();
  await page.locator('#mini-player .mini-toolbar a').click();
  await page.locator('#mini-player').waitFor({ state: 'hidden' });
  await playing();
  assert.equal(await page.locator('#watch-queue li').count(), 2);
  assert.match(await page.locator('#watch-queue li').first().innerText(), /Test video 3/);
  await page.locator('[data-queue-up="1"]').click();
  assert.match(await page.locator('#watch-queue li').first().innerText(), /Test video 2/);
  await page.locator('#queue-autoplay').check();
  await page.locator('#speed').selectOption('1');
  await page.evaluate(() => {
    const v = document.querySelector('#video'); window.endLog = [];
    for (const e of ['seeking', 'seeked', 'ended', 'loadedmetadata', 'emptied', 'pause', 'play', 'error']) v.addEventListener(e, () => window.endLog.push([e, v.currentTime, v.getAttribute('src')]));
    v.currentTime = 39.8;
  });
  await page.waitForURL(`**/#watch=${items[1].id}`);
  await playing();
  assert.equal(await page.locator('#audio-language').inputValue(), 'es');
  assert.match(await page.locator('#video').getAttribute('src'), /height=360/);
  assert.equal(await page.locator('#watch-queue li').count(), 1);
  await page.locator('#queue-autoplay').uncheck();
  await page.locator('[data-queue-remove="0"]').click();
  assert.equal(await page.locator('#watch-queue li').count(), 0);
  await page.locator('#audio-language').selectOption('original');
  await playing();
  assert.match(await page.locator('#audio').getAttribute('src'), /language=en/);
  await page.locator('#captions').selectOption('');
  assert.equal(await page.locator('#video track').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/playback-features-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: auto upgrade, manual quality, persisted audio language, captions, in-place recovery, PiP fallback, mini-player continuity, queue ordering/removal/autoplay, and mobile layout.');
} catch (error) {
  console.error('Page errors:', errors);
  console.error(await page.evaluate(() => window.endLog));
  console.error(await page.evaluate(() => ({ url: location.href, time: document.querySelector('#video')?.currentTime, paused: document.querySelector('#video')?.paused, ended: document.querySelector('#video')?.ended, duration: document.querySelector('#video')?.duration, preferences: localStorage.getItem('dinosour.ui.v1') })));
  console.error(await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, tracks: [...document.querySelectorAll('track')].map(t => ({ src: t.src, state: t.readyState, mode: t.track.mode, cues: t.track.cues?.length })) })));
  await page.screenshot({ path: 'test-results/playback-features-failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); }
