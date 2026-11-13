import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
await mkdir('test-results', { recursive: true });

try {
  // Deterministic UI coverage: Shorts bar, topics, search context and removal.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(30000);
  const requests = [];
  await page.route('**/api/thumb/*', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="270" height="480"/>' }));
  await page.route('**/api/shorts?*', async route => {
    const url = new URL(route.request().url());
    const number = Number(url.searchParams.get('continuation') || '1');
    requests.push({ query: '', shorts: '1', page: number, home: true });
    const videos = Array.from({ length: 12 }, (_, i) => ({
      id: `s${String((number - 1) * 12 + i).padStart(10, '0')}`,
      title: `Short ${number}-${i}`, channel: 'Test creator', duration: 0,
      viewsText: '1M views', thumb: '/api/thumb/test?t=short', type: 'short',
    }));
    await route.fulfill({ json: { videos, continuation: number < 2 ? String(number + 1) : null } });
  });
  await page.route('**/api/search?*', async route => {
    const url = new URL(route.request().url());
    const number = Number(url.searchParams.get('continuation') || '1');
    requests.push({ query: url.searchParams.get('q'), shorts: url.searchParams.get('shorts'), page: number });
    const videos = Array.from({ length: 12 }, (_, i) => ({
      id: `s${String((number - 1) * 12 + i).padStart(10, '0')}`,
      title: `Short ${number}-${i}`, channel: 'Test creator', duration: 0,
      viewsText: '1M views', thumb: '/api/thumb/test?t=short', type: 'short',
    }));
    await route.fulfill({ json: { videos, continuation: number < 2 ? String(number + 1) : null } });
  });

  await page.goto('http://127.0.0.1:3210/#shorts', { waitUntil: 'domcontentloaded' });
  await page.locator('.short-card').first().waitFor();
  assert.ok(await page.locator('.short-card').count() >= 12);
  assert.equal(await page.locator('.chips a').count(), 1);
  assert.equal(await page.locator('.chips a').getAttribute('href'), '#shorts');
  assert.equal(await page.locator('[data-nav="shorts"]').getAttribute('aria-current'), 'page');
  assert.match(await page.locator('.short-card a').first().getAttribute('href'), /^#short=/);
  assert.ok(requests.every(request => request.shorts === '1'), JSON.stringify(requests));

  await page.locator('.add-topic').click();
  await page.locator('#topic-name').fill('funny animals');
  await page.locator('#topic-form button[type=submit]').click();
  await page.waitForURL('**/#shorts=funny%20animals');
  await page.locator('.topic-chip.active').waitFor();
  assert.ok(requests.some(request => request.query === 'funny animals' && request.shorts === '1'), JSON.stringify(requests));
  assert.equal(await page.locator('.chips a').first().getAttribute('href'), '#shorts');

  await page.reload();
  await page.locator('.topic-chip.active').waitFor();
  assert.equal(await page.locator('.topic-chip').count(), 1);
  await page.locator('[data-remove-topic]').click();
  await page.waitForURL('**/#shorts');
  assert.equal(await page.locator('.topic-chip').count(), 0);
  await page.locator('.add-topic').click();
  await page.locator('#topic-name').fill('funny animals');
  await page.locator('#topic-form button[type=submit]').click();
  await page.waitForURL('**/#shorts=funny%20animals');
  await page.locator('#search').fill('cat shorts');
  await page.locator('.search-submit').click();
  await page.waitForURL('**/#shorts=cat%20shorts');
  await page.locator('h1').filter({ hasText: 'Shorts for cat shorts' }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.add-topic').click();
  assert.equal(await page.locator('#topic-dialog').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/shorts-mobile.png', fullPage: true });
  await page.close();

  // Live coverage: real Shorts search, parsing, navigation and direct playback.
  const live = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  live.on('pageerror', error => errors.push(error.message));
  live.setDefaultTimeout(120000);
  const response = await live.request.get('http://127.0.0.1:3210/api/search?q=funny%20shorts&shorts=1');
  assert.equal(response.status(), 200);
  const data = await response.json();
  assert.ok(data.videos.length > 0, 'live Shorts search returned no results');
  assert.ok(data.videos.every(video => video.type === 'short' && /^[\w-]{11}$/.test(video.id) && video.thumb.includes('t=short')));
  assert.ok(data.continuation);
  const nextResponse = await live.request.get(`http://127.0.0.1:3210/api/search?q=funny%20shorts&shorts=1&continuation=${encodeURIComponent(data.continuation)}`);
  const nextData = await nextResponse.json();
  assert.ok(nextData.videos.length > 0 && nextData.videos.every(video => video.type === 'short'), 'continuation returned a non-Short');
  const againData = await (await live.request.get('http://127.0.0.1:3210/api/search?q=funny%20shorts&shorts=1')).json();
  assert.notDeepEqual(data.videos.slice(0, 6).map(video => video.id), againData.videos.slice(0, 6).map(video => video.id), 'topic Shorts feed did not change between visits');

  const allOne = await (await live.request.get('http://127.0.0.1:3210/api/shorts')).json();
  const allTwo = await (await live.request.get('http://127.0.0.1:3210/api/shorts')).json();
  assert.ok(allOne.videos.length > 0 && allTwo.videos.length > 0, 'live Shorts feed returned no results');
  assert.ok(allOne.videos.every(video => video.type === 'short' && /^[\w-]{11}$/.test(video.id) && video.thumb.includes('t=short')));
  assert.ok(allOne.continuation && allTwo.continuation, 'live Shorts feed did not return a continuation');
  assert.notDeepEqual(allOne.videos.slice(0, 6).map(video => video.id), allTwo.videos.slice(0, 6).map(video => video.id), 'All Shorts feed did not change between requests');

  await live.goto('http://127.0.0.1:3210/#shorts', { waitUntil: 'domcontentloaded' });
  await live.locator('.short-card').first().waitFor();
  assert.ok(await live.locator('.short-card').count() > 0);
  assert.equal(await live.locator('.short-tag').count(), 0, 'Shorts grid still shows redundant red Shorts tags');
  await live.locator('.short-card a').first().click();
  await live.locator('.reel').waitFor();
  const stage = await live.locator('.reel-stage').boundingBox();
  const screen = await live.locator('.reel-screen').boundingBox();
  const controls = await live.locator('.reel-top').boundingBox();
  const progress = await live.locator('#reel-progress').boundingBox();
  const rail = await live.locator('#reel-actions').boundingBox();
  const nav = await live.locator('.reel-nav').boundingBox();
  const pictureWidth = screen.height * 9 / 16;
  const centred = box => Math.abs(box.x + box.width / 2 - (screen.x + screen.width / 2)) < 2;
  assert.ok(stage && stage.height > 800 && stage.height > stage.width, `reel is not full-height: ${JSON.stringify(stage)}`);
  assert.ok(screen && controls && controls.y + controls.height <= screen.y + 1, `reel controls cover the top of the video: ${JSON.stringify({ controls, screen })}`);
  assert.ok(Math.abs(controls.width - pictureWidth) < 2 && centred(controls), `top controls are not aligned to the video: ${JSON.stringify({ controls, pictureWidth })}`);
  assert.ok(progress && Math.abs(progress.width - pictureWidth) < 2 && centred(progress), `progress bar is not aligned to the video: ${JSON.stringify({ progress, pictureWidth })}`);
  assert.ok(rail && rail.x >= stage.x + stage.width, `action rail is inside the video: ${JSON.stringify({ stage, rail })}`);
  assert.ok(nav && nav.x - (rail.x + rail.width) <= 80, `reel arrows are detached from the action rail: ${JSON.stringify({ rail, nav })}`);
  assert.equal(await live.locator('#reel-count').count(), 0, 'reel still shows a position counter');
  assert.equal(await live.locator('.reel-tag').count(), 0, 'reel still shows the red Shorts tag');
  assert.equal(await live.locator('#video').getAttribute('controls'), null, 'reel still shows the native control bar');
  assert.equal(await live.locator('#player-status').isHidden(), true, 'a second loading overlay is visible');
  assert.equal(await live.locator('#reel-loading').count(), 1, 'reel loading indicator is missing');

  // The live grid's first card can occasionally point at a stalled upload, so
  // the layout checks above use it, then playback switches to a known-good
  // public Short inside the same session (the Shorts feed and cursor stay loaded).
  await live.evaluate(() => { location.hash = '#short=H8hVCPzVCIM'; });
  await live.waitForFunction(() => {
    const video = document.querySelector('#video'), audio = document.querySelector('#audio');
    return location.hash === '#short=H8hVCPzVCIM' && video && audio && video.currentTime > 2 && !video.paused && audio.currentTime > 1 && !audio.paused;
  }, null, { timeout: 120000 });
  assert.equal(await live.locator('#reel-loading').isHidden(), true, 'reel loading spinner is still visible after playback starts');
  assert.ok((await live.locator('.watch-title').textContent()).trim().length > 0);
  assert.equal(await live.locator('.reel-channel').innerText().then(text => /shorts/i.test(text)), false, 'channel row still says Shorts');
  assert.equal(await live.locator('[data-nav="shorts"]').getAttribute('aria-current'), 'page');
  assert.notEqual(await live.locator('#reel-progress-fill').evaluate(el => el.style.width), '0%', 'reel progress bar did not advance');
  await live.evaluate(() => { document.querySelector('#video').volume = 0.25; });
  await live.waitForTimeout(800);
  assert.ok(await live.evaluate(() => Math.abs(document.querySelector('#audio').volume - 0.25) < 0.01), 'volume did not reach the audio track');
  await live.locator('#reel-play').click();
  await live.waitForFunction(() => document.querySelector('#video').paused);
  await live.locator('#reel-play').click();
  await live.waitForFunction(() => !document.querySelector('#video').paused);
  await live.screenshot({ path: 'test-results/shorts-watch.png' });

  // Doom scrolling: wheel down moves to the next Short and it starts playing.
  // Retry a couple of times because a live continuation page can include one
  // upload whose CDN stream never becomes ready.
  let scrolledToNext = false;
  for (let attempt = 0; attempt < 3 && !scrolledToNext; attempt++) {
    const firstHash = await live.evaluate(() => location.hash);
    const firstTitle = await live.locator('.reel-title').textContent();
    await live.mouse.move(700, 500);
    await live.mouse.wheel(0, 600);
    const moved = await live.waitForFunction(hash => location.hash !== hash, firstHash, { timeout: 30000 }).then(() => true).catch(() => false);
    if (!moved) { await live.waitForTimeout(700); continue; }
    scrolledToNext = await live.waitForFunction(() => {
      const video = document.querySelector('#video'), audio = document.querySelector('#audio');
      return video && video.currentTime > 1 && !video.paused && audio && audio.currentTime > .5 && !audio.paused;
    }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    if (scrolledToNext) assert.notEqual(await live.locator('.reel-title').textContent(), firstTitle);
  }
  assert.ok(scrolledToNext, 'doom scroll did not reach a playing Short');
  await live.setViewportSize({ width: 390, height: 844 });
  assert.equal(await live.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await live.screenshot({ path: 'test-results/shorts-watch-mobile.png' });
  console.log('PASS: Shorts bar/topics, no redundant Shorts badges, external action rail, custom reel controls, responsive layout, live parsing, full-height doom scrolling, volume sync and direct playback with audio.');
  assert.deepEqual(errors, []);
} catch (error) {
  console.error('FAILED:', error.message);
  throw error;
} finally {
  await browser.close();
}
