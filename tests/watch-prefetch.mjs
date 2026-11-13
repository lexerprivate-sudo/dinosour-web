import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';

await mkdir('test-results', { recursive: true });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'test-results/watch-fixture.mp4']);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050', '-t', '40', '-c:a', 'aac', '-movflags', '+faststart', 'test-results/watch-fixture.m4a']);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const item = { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny', channel: 'Blender', thumb: '/api/thumb/aqz-KE-bpKQ', type: 'video' };
const info = { ...item, duration: 40, qualities: [{ label: '720p', height: 720, src: '/fixture.mp4', separateAudio: true }], audio: '/fixture.m4a' };
for (const [ext, type] of [['mp4', 'video/mp4'], ['m4a', 'audio/mp4']]) {
  const body = await readFile(`test-results/watch-fixture.${ext}`);
  await page.route(`**/fixture.${ext}`, route => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range) return route.fulfill({ contentType: type, headers: { 'accept-ranges': 'bytes' }, body });
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({ status: 206, contentType: type, headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) });
  });
}
await page.route('**/api/thumb/*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="teal"/></svg>' }));
await page.route('**/api/search?*', route => route.fulfill({ json: { videos: [item], continuation: null } }));
// Observe detached media elements too, to verify actual buffered-element reuse.
await page.addInitScript(() => {
  window.testMedia = [];
  const create = document.createElement.bind(document);
  document.createElement = (...args) => {
    const element = create(...args);
    if (['video', 'audio'].includes(args[0])) window.testMedia.push(element);
    return element;
  };
});
try {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/video?*', async route => {
    await gate;
    await route.fulfill({ json: info }).catch(() => {});
  });
  await page.goto(`http://127.0.0.1:3210/#watch=${item.id}`);
  await page.locator('.watch-loading').waitFor({ state: 'visible' });
  assert.match(await page.locator('.watch-loading').innerText(), /Getting your video ready/);
  assert.ok(await page.locator('#video').getAttribute('poster'), 'cold navigation needs a thumbnail');
  await page.screenshot({ path: 'test-results/watch-loading.png' });
  // Leave while metadata is pending: late responses must not recreate the player.
  await page.evaluate(() => { location.hash = '#home'; });
  await page.locator('.card').first().waitFor();
  release();
  await page.unroute('**/api/video?*');
  await page.route('**/api/video?*', route => route.fulfill({ json: info }));
  let metadataRequests = 0;
  page.on('request', request => {
    if (request.url().includes(`/api/video?id=${item.id}`)) metadataRequests++;
  });
  const link = page.locator('.card .thumb a').first();
  await page.waitForResponse(response => response.url().includes(`/api/video?id=${item.id}`) && response.ok());
  assert.equal(metadataRequests, 1, 'visible cards should prepare metadata before hover or click');
  await link.hover();
  await page.waitForFunction(() => window.testMedia.filter(m => m.readyState >= 3 && m.buffered.length).length >= 2);
  const warm = await page.evaluate(() => {
    const video = window.testMedia.find(m => m.tagName === 'VIDEO' && m.buffered.length);
    window.testWarmVideo = video;
    return { seconds: video.buffered.end(0), paused: video.paused };
  });
  assert.ok(warm.seconds > 0);
  assert.equal(warm.paused, true, 'prefetch must remain silent and paused');
  const started = Date.now();
  await link.click();
  await page.waitForFunction(() => {
    const v = document.querySelector('#video'), a = document.querySelector('#audio');
    return v?.currentTime > .5 && a?.currentTime > .2 && !v.paused && !a.paused;
  });
  assert.equal(await page.evaluate(() => document.querySelector('#video') === window.testWarmVideo), true, 'buffered element was replaced');
  assert.equal(metadataRequests, 1, 'navigation fetched the same metadata twice');
  assert.equal(await page.locator('.watch-loading').isHidden(), true);
  assert.equal(await page.locator('#player-status').isHidden(), true);
  const startMs = Date.now() - started;
  await page.evaluate(() => { document.querySelector('#video').currentTime = 30; });
  await page.waitForFunction(() => {
    const v = document.querySelector('#video'), a = document.querySelector('#audio');
    return v.currentTime > 31 && Math.abs(v.currentTime - a.currentTime) < .5;
  });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test-results/watch-prefetch.png' });
  await page.evaluate(() => { location.hash = '#home'; });
  await page.locator('.card').first().waitFor();
  await link.hover();
  await page.waitForFunction(() => window.testMedia.some(m => m.tagName === 'VIDEO' && !m.isConnected && m.readyState >= 3 && m.buffered.length));
  await link.click();
  await page.waitForFunction(() => document.querySelector('#video')?.currentTime > 31);
  assert.ok(await page.locator('#video').evaluate(v => v.currentTime < 38), 'warm playback did not resume saved position');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/watch-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => [e.tagName, e.className, e.getBoundingClientRect().width]).slice(0, 15))));
  assert.deepEqual(errors, []);
  console.log(`PASS: cold thumbnail loading, cancelled navigation, silent advance buffering (${warm.seconds.toFixed(1)}s), element reuse, single metadata request, playback and seek sync. Warm start including 0.5s playback: ${startMs}ms.`);
} finally {
  await browser.close();
}
