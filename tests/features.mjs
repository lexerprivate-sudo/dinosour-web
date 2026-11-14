import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';

const base = process.env.TEST_URL || 'http://127.0.0.1:3210';
await mkdir('test-results', { recursive: true });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '45', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'test-results/features.mp4']);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050', '-t', '45', '-c:a', 'aac', '-movflags', '+faststart', 'test-results/features.m4a']);
const videoBytes = await readFile('test-results/features.mp4'), audioBytes = await readFile('test-results/features.m4a');

const video = (id, title, duration, views, published) => ({
  id, title, channel: 'Test channel', duration, views, published,
  type: 'video', thumb: `/api/thumb/${id}`,
});
const results = [
  video('aqz-KE-bpKQ', 'Sample video', 600, 1000, '2024-01-01'),
  video('jNQXAC9IVRw', 'Longer sample', 500, 5000, '2025-01-01'),
  video('H8hVCPzVCIM', 'Short sample', 80, 100, '2023-01-01'),
];
const watchInfo = {
  ...results[0], duration: 45,
  qualities: [720, 360].map(height => ({ height, label: `${height}p`, separateAudio: true, src: `/feature-video?height=${height}` })),
  audio: '/feature-audio?language=en', audioFallbacks: [],
  audioTracks: [{ id: 'en-original', language: 'en', original: true, label: 'English (Original)', src: '/feature-audio?language=en', fallbacks: [] }],
  captions: [],
};

function serveMedia(route, body, contentType) {
  const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!range) return route.fulfill({ contentType, headers: { 'accept-ranges': 'bytes' }, body });
  const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  return route.fulfill({ status: 206, contentType, headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
page.setDefaultTimeout(45000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));

await page.route('**/api/search?*', route => route.fulfill({ json: { videos: results, continuation: null } }));
await page.route('**/api/suggest?*', route => {
  const query = new URL(route.request().url()).searchParams.get('q');
  return route.fulfill({ json: { suggestions: query ? ['space documentary', 'spacex launch'] : [] } });
});
await page.route('**/api/thumb/*', route => route.fulfill({
  contentType: 'image/svg+xml',
  body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="teal"/></svg>',
}));
await page.route('**/api/video?*', route => route.fulfill({ json: watchInfo }));
await page.route('**/feature-video?*', route => serveMedia(route, videoBytes, 'video/mp4'));
await page.route('**/feature-audio?*', route => serveMedia(route, audioBytes, 'audio/mp4'));
await page.route('**/api/network', route => route.fulfill({
  json: {
    lan: ['http://10.0.0.5:3210'],
    publicUrl: 'https://demo.example.com',
    publicProvider: 'cloudflare-quick', publicStable: false,
    currentOrigin: 'https://demo.example.com', accessRequired: true, accessCode: 'ABCDE12345',
    inviteUrl: 'https://demo.example.com/unlock?code=ABCDE12345&next=/',
  },
}));

const libraryKey = 'dinosour.library.v1';
const seed = {
  saved: [{ id: 'aqz-KE-bpKQ', title: 'Sample video', channel: 'Test channel', duration: 200, thumb: '/api/thumb/aqz-KE-bpKQ' }],
  history: [
    { id: 'jNQXAC9IVRw', title: 'Longer sample', channel: 'Test channel', duration: 500, position: 100, watchedAt: Date.now() - 2000, thumb: '/api/thumb/jNQXAC9IVRw' },
    { id: 'oldvideo001', title: 'Old resume', channel: 'Test channel', position: 30, watchedAt: Date.now() - 1500, thumb: '/api/thumb/oldvideo001' },
    { id: 'zzzzzzzzzzz', title: 'Finished video', channel: 'Test channel', duration: 100, position: 100, watchedAt: Date.now() - 1000, thumb: '/api/thumb/zzzzzzzzzzz' },
  ],
  liked: [], queue: [],
};

try {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [libraryKey, seed]);
  await page.evaluate(() => localStorage.setItem('dinosour.ui.v1', JSON.stringify({ topics: ['Saved topic'] })));
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Continue watching: unfinished items (including pre-upgrade history without
  // a duration), progress bar, remove and clear.
  await page.locator('.continue-section').waitFor();
  assert.equal(await page.locator('.continue-card').count(), 2, 'only unfinished videos belong in Continue watching');
  const longerCard = page.locator('.continue-card').filter({ hasText: 'Longer sample' });
  assert.match(await longerCard.locator('.watched-bar').evaluate(element => element.style.width), /^20(\.0)?%$/);
  assert.match(await page.locator('.continue-card').filter({ hasText: 'Old resume' }).locator('.duration').innerText(), /In progress/);
  await longerCard.locator('[data-continue-remove]').click();
  assert.equal(await page.locator('.continue-card').count(), 1);
  let stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), libraryKey);
  assert.equal(stored.history.find(item => item.id === 'jNQXAC9IVRw').continueHidden, true, 'removing a Continue card was not persisted');
  await page.evaluate(key => {
    const data = JSON.parse(localStorage.getItem(key));
    for (const item of data.history) delete item.continueHidden;
    localStorage.setItem(key, JSON.stringify(data));
  }, libraryKey);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.continue-section').waitFor();
  await page.locator('[data-clear-continue]').click();
  await page.locator('.continue-section').waitFor({ state: 'detached' });
  stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), libraryKey);
  assert.ok(stored.history.every(item => item.continueHidden), 'Clear did not hide every Continue item');

  // Search suggestions, filters, sorting and recent searches.
  await page.locator('#search').click();
  await page.locator('#search').pressSequentially('space', { delay: 25 });
  await page.locator('.search-suggestion').first().waitFor();
  assert.equal(await page.locator('.search-suggestion').count(), 2);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('.search-suggestion').first().getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Enter');
  await page.waitForURL(/#search=space%20documentary/);
  await page.locator('h1').filter({ hasText: 'Results for space documentary' }).waitFor();
  await page.locator('#results .card').first().waitFor();
  assert.equal(await page.locator('#results .card').count(), 3);
  assert.equal(await page.locator('#result-count').innerText(), '3 videos');
  assert.match(await page.locator('.card:has-text("Longer sample") .watched-bar').evaluate(element => element.style.width), /^20(\.0)?%$/);

  await page.locator('#filter-duration').selectOption('short');
  assert.equal(await page.locator('#results .card').count(), 1, 'duration filter did not reduce the result set');
  assert.match(await page.locator('#results .card h3').innerText(), /Short sample/);
  assert.equal(await page.locator('#result-count').innerText(), '1 video');
  await page.locator('#filter-duration').selectOption('any');
  await page.locator('#filter-sort').selectOption('longest');
  const ordered = await page.locator('#results .card h3').allInnerTexts();
  assert.deepEqual(ordered, ['Sample video', 'Longer sample', 'Short sample'], `unexpected sort order: ${JSON.stringify(ordered)}`);
  await page.locator('#filter-sort').selectOption('views');
  assert.deepEqual(await page.locator('#results .card h3').allInnerTexts(), ['Longer sample', 'Sample video', 'Short sample']);
  const savedPreferences = await page.evaluate(() => JSON.parse(localStorage.getItem('dinosour.ui.v1') || '{}'));
  assert.equal(savedPreferences.searchSort, 'views');
  assert.equal(savedPreferences.searchDuration, 'any');

  await page.locator('#search').fill('');
  await page.locator('#search').focus();
  await page.locator('.suggest-clear').waitFor();
  assert.equal(await page.locator('.search-suggestion .suggest-label').first().innerText(), 'space documentary');
  await page.locator('[data-clear-recent]').click();
  await page.locator('#search-suggestions').waitFor({ state: 'hidden' });
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('dinosour.ui.v1') || '{}').recentSearches);
  assert.deepEqual(recent, []);

  // Backup export, merge and replace.
  const clean = {
    saved: [{ id: 'aqz-KE-bpKQ', title: 'Sample video', channel: 'Test channel', duration: 200, thumb: '/api/thumb/aqz-KE-bpKQ' }],
    history: [], liked: [], queue: [],
  };
  await page.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [libraryKey, clean]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-backup]').first().click();
  const dialog = page.locator('#backup-dialog');
  await dialog.waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.locator('[data-export-backup]').click()]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.app, 'dinosour');
  assert.equal(exported.library.saved[0].id, 'aqz-KE-bpKQ');
  assert.deepEqual(exported.preferences.topics, ['Saved topic'], 'topics were missing from the backup');
  assert.match(await dialog.locator('#backup-summary').innerText(), /Backup downloaded/);

  const imported = {
    app: 'dinosour', version: 1, exportedAt: new Date().toISOString(),
    library: {
      saved: [{ id: 'jNQXAC9IVRw', title: 'Imported saved', channel: 'Other', duration: 120, thumb: '/api/thumb/jNQXAC9IVRw' }],
      history: [{ id: 'H8hVCPzVCIM', title: 'Imported history', channel: 'Other', duration: 60, position: 12, watchedAt: Date.now(), thumb: '/api/thumb/H8hVCPzVCIM' }],
      liked: [], queue: [],
    },
    preferences: { topics: ['Imported topic'], theme: 'dark' },
  };
  await dialog.locator('#backup-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await dialog.locator('[data-backup-merge]').waitFor();
  await dialog.locator('[data-backup-merge]').click();
  let merged = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), libraryKey);
  assert.deepEqual(merged.saved.map(item => item.id).sort(), ['aqz-KE-bpKQ', 'jNQXAC9IVRw']);
  let prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('dinosour.ui.v1') || '{}'));
  assert.ok(prefs.topics.includes('Imported topic'));

  const replacement = {
    app: 'dinosour', version: 1,
    library: { saved: [imported.library.saved[0]], history: imported.library.history, liked: [], queue: [] },
    preferences: { topics: ['Only imported topic'] },
  };
  await dialog.locator('#backup-file').setInputFiles({ name: 'replacement.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });
  await dialog.locator('[data-backup-replace]').waitFor();
  await dialog.locator('[data-backup-replace]').click();
  const replaced = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), libraryKey);
  assert.deepEqual(replaced.saved.map(item => item.id), ['jNQXAC9IVRw']);
  assert.deepEqual(replaced.history.map(item => item.id), ['H8hVCPzVCIM']);
  prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('dinosour.ui.v1') || '{}'));
  assert.deepEqual(prefs.topics, ['Only imported topic']);
  await dialog.locator('[data-close-backup]').click();

  // Share dialog displays the invite, public address, code and LAN address.
  await page.locator('#share-app').click();
  const share = page.locator('#share-dialog');
  await share.waitFor();
  await page.waitForFunction(() => document.querySelector('#share-invite')?.value.includes('demo.example.com'));
  assert.equal(await share.locator('#share-invite').inputValue(), 'https://demo.example.com/unlock?code=ABCDE12345&next=/');
  assert.equal(await share.locator('#share-public').inputValue(), 'https://demo.example.com');
  assert.equal(await share.locator('#share-code').inputValue(), 'ABCDE-12345');
  assert.equal(await share.locator('#share-code').getAttribute('data-raw'), 'ABCDE12345');
  assert.match(await share.locator('#share-summary').innerText(), /Public access is on/);
  assert.match(await share.locator('#share-lan').innerText(), /10\.0\.0\.5:3210/);
  assert.equal(await share.locator('#share-open').getAttribute('href'), 'https://demo.example.com');
  await share.locator('[data-close-share]').last().click();

  // Diagnostics and double-tap seeking on the watch page.
  await page.goto(base + '/#watch=aqz-KE-bpKQ');
  await page.waitForFunction(() => {
    const v = document.querySelector('#video'), a = document.querySelector('#audio');
    return v && !v.paused && v.currentTime > .2 && a && !a.paused;
  });
  await page.locator('#stats-toggle').click();
  const stats = page.locator('#stats-dialog');
  await stats.waitFor();
  assert.equal(await stats.getAttribute('open'), '');
  assert.match(await stats.locator('h2').innerText(), /Playback diagnostics/);
  assert.match(await stats.locator('#stats-body').innerText(), /Stream\s+(360|720)p/);
  assert.match(await stats.locator('#stats-body').innerText(), /Startup\s+stream details/);
  const metrics = await page.evaluate(() => window.__dinosourStats);
  assert.ok(Number.isFinite(metrics.metadataMs) && metrics.metadataMs >= 0);
  assert.ok(metrics.firstFrameMs > 0, `first frame was not timed: ${JSON.stringify(metrics)}`);
  await stats.locator('[data-close-stats]').click();
  await stats.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#fullscreen-toggle').count(), 1);

  const doubleTap = direction => page.evaluate(direction => {
    const shell = document.querySelector('.player-shell');
    const box = shell.getBoundingClientRect();
    const x = box.left + box.width * (direction < 0 ? .25 : .75);
    const y = box.top + box.height * .45;
    for (let index = 0; index < 2; index++) {
      shell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
    }
    return document.querySelector('#video').currentTime;
  }, direction);

  await page.evaluate(() => { const v = document.querySelector('#video'); v.pause(); v.currentTime = 20; });
  await doubleTap(-1);
  assert.equal(await page.locator('.gesture-hint').innerText(), '−10 seconds');
  await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 10) < 1.2);
  await page.waitForTimeout(700);
  await page.evaluate(() => { document.querySelector('#video').currentTime = 10; });
  await doubleTap(1);
  assert.equal(await page.locator('.gesture-hint').innerText(), '+10 seconds');
  await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 20) < 1.2);

  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  console.log('PASS: Continue watching, search suggestions/filters, backup merge/replace, share dialog, diagnostics, touch seeking and persistence.');
} finally {
  await browser.close();
}
