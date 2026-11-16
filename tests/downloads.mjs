import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFileSync, statSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const mkdirp = promisify(mkdir);

const TEST_URL = process.env.TEST_URL || 'http://127.0.0.1:3210';
const id = 'dlTestVideo'; // 11-char fake id, matches ^[\w-]{11}$

// Tiny fixtures: video-only MP4 + separate AAC audio track.
await mkdirp('test-results', { recursive: true });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'test-results/dl-fixture.mp4'], { windowsHide: true });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050', '-t', '20', '-c:a', 'aac', 'test-results/dl-fixture.m4a'], { windowsHide: true });
const videoBytes = statSync('test-results/dl-fixture.mp4').size;
const audioBytes = statSync('test-results/dl-fixture.m4a').size;
const info = {
  id, title: 'Offline Rabbit', channel: 'Fixture Labs', duration: 20, views: 10, viewsText: '10 views',
  published: '', description: 'download fixture', thumb: '/api/thumb/' + id,
  qualities: [{ label: '360p', height: 360, src: '/fixture.mp4', separateAudio: true, size: videoBytes }],
  audio: '/fixture.m4a', audioFallbacks: [], audioTracks: [], audioSize: audioBytes, captions: [],
};
const fixtureRoutes = page => {
  page.route('**/fixture.mp4', async route => route.fulfill({ status: 200, contentType: 'video/mp4', body: readFileSync('test-results/dl-fixture.mp4') }));
  page.route('**/fixture.m4a', async route => route.fulfill({ status: 200, contentType: 'audio/mp4', body: readFileSync('test-results/dl-fixture.m4a') }));
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
fixtureRoutes(page);
await page.route('**/api/video?*', route => route.fulfill({ json: info }));
await page.route('**/api/video-lite?*', route => route.fulfill({ json: { id, title: info.title, channel: info.channel, views: 10, thumb: info.thumb } }));
await page.route('**/api/search?*', route => route.fulfill({ json: { videos: [], continuation: null } }));

await page.goto(TEST_URL + '/#watch=' + id, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#watch-info h1', { timeout: 30000 });

// 1. download button and dialog open with sizes
await page.locator('#download-toggle').waitFor({ timeout: 15000 });
await page.locator('#download-toggle').click();
await page.waitForSelector('#download-dialog[open]', { timeout: 5000 });
const listText = await page.locator('#download-quality-list').innerText();
assert.ok(/360p/.test(listText), 'quality list shows 360p');
assert.ok(/video/.test(listText), 'quality list shows sizes');
// 2. start download
await page.locator('[data-download-quality="0"]').click();
await page.waitForTimeout(2500);
const afterStart = await page.evaluate(() => JSON.parse(localStorage.getItem('dinosour.library.v1')).downloads.find(d => d.id === 'dlTestVideo'));
assert.ok(afterStart, 'download entry persisted');
// poll until done (fast fixtures)
await page.waitForFunction(() => JSON.parse(localStorage.getItem('dinosour.library.v1')).downloads.find(d => d.id === 'dlTestVideo')?.state === 'done', null, { timeout: 30000 });
const doneEntry = await page.evaluate(() => JSON.parse(localStorage.getItem('dinosour.library.v1')).downloads[0]);
assert.ok(doneEntry.videoBytes > 0 && doneEntry.audioBytes > 0, 'bytes recorded');
assert.equal(await page.locator('#download-toggle').innerText(), 'Downloaded');

// 3. reload the whole page with network streams dead — must still play from local files
await page.unroute('**/api/video?*');
await page.route('**/api/video?*', route => route.abort());
await page.route('**/api/video-lite?*', route => route.abort());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('#video')?.src?.startsWith('blob:'), null, { timeout: 30000 });
await page.waitForFunction(() => document.querySelector('#video')?.currentTime > 1, null, { timeout: 30000 });
const srcCheck = await page.evaluate(() => document.querySelector('#video').src.slice(0, 5));
console.log('offline playback src prefix:', srcCheck);

// 4. library rail shows the download; delete removes it
await page.goto(TEST_URL + '/#library', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#downloads', { timeout: 15000 });
assert.match(await page.locator('#downloads').innerText(), /1/);
await page.locator('[data-delete-download]').first().click();
await page.waitForTimeout(500);
const afterDelete = await page.evaluate(() => JSON.parse(localStorage.getItem('dinosour.library.v1')).downloads);
assert.equal(afterDelete.length, 0, 'download removed from library');
assert.equal(await page.locator('#downloads').count(), 0, 'downloads rail removed when empty');

// 5. corrupt download entry is dropped on load, app still boots
await page.evaluate(() => {
  const key = 'dinosour.library.v1', value = JSON.parse(localStorage.getItem(key));
  value.downloads = [
    null,
    { id: 'bad', title: 'x' },
    { id: 'dlTestVideo', title: 'Valid-ish', channel: 'y', state: 'nonsense', qualityHeight: 'big', videoBytes: -1 },
  ];
  localStorage.setItem(key, JSON.stringify(value));
});
await page.goto(TEST_URL + '/?corrupt=1#library', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.library-page', { timeout: 15000 });
const sanitized = await page.evaluate(() => JSON.parse(localStorage.getItem('dinosour.library.v1')).downloads);
assert.equal(sanitized.length, 1, 'corrupt entries dropped');
assert.equal(sanitized[0].state, 'failed', 'unknown state coerced to failed');
assert.equal(sanitized[0].bytes, 0, 'negative bytes coerced');

assert.equal(errors.length, 0, `page errors: ${errors.join(' | ')}`);
console.log('PASS: download flow (picker, sizes, offline playback via blob URL, library rail, delete, corrupt-sanitize)');
await browser.close();
process.exit(0);
