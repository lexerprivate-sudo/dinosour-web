import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let failSecondPage = true;
const requests = [];
await page.route('**/api/thumb/*', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"/>' }));
await page.route('**/api/search?*', async route => {
  const url = new URL(route.request().url());
  const cursor = url.searchParams.get('continuation') || '1';
  const number = Number(cursor);
  requests.push({ query: url.searchParams.get('q'), page: number });
  if (number === 2 && failSecondPage) {
    failSecondPage = false;
    return route.fulfill({ status: 502, json: { error: 'Temporary test failure' } });
  }
  const videos = Array.from({ length: 12 }, (_, i) => ({
    id: `v${String((number - 1) * 12 + i).padStart(10, '0')}`,
    title: `Video ${number}-${i}`, channel: 'Test channel', thumb: '/api/thumb/test', duration: 100,
  }));
  if (number > 1) videos.push({ ...videos[0], id: 'v0000000000' });
  await route.fulfill({ json: { videos, continuation: number < 7 ? String(number + 1) : null } });
});
try {
  await page.goto('http://127.0.0.1:3210');
  await page.locator('#results .card').first().waitFor();
  assert.equal(await page.locator('.chips a').count(), 1);
  assert.equal(await page.locator('#more').count(), 0);
  await page.locator('.add-topic').click();
  await page.locator('#topic-name').fill('  Space telescopes  ');
  await page.locator('#topic-form button[type=submit]').click();
  await page.waitForURL('**/#search=Space%20telescopes');
  await page.locator('.topic-chip.active').waitFor();
  await page.reload();
  await page.locator('.topic-chip.active').waitFor();
  assert.equal(await page.locator('.topic-chip').count(), 1);
  await page.locator('.add-topic').click();
  await page.locator('#topic-name').fill('space TELESCOPES');
  await page.locator('#topic-form button[type=submit]').click();
  assert.equal(await page.locator('.topic-chip').count(), 1);
  await page.waitForFunction(() => document.querySelectorAll('#results .card').length === 12);
  failSecondPage = true;
  requests.length = 0;
  await page.locator('#feed-status').scrollIntoViewIfNeeded();
  await page.locator('#retry-feed').waitFor();
  assert.equal(await page.locator('#results .card').count(), 12);
  await page.locator('#retry-feed').click();
  await page.waitForFunction(() => document.querySelectorAll('#results .card').length === 24);
  for (let number = 3; number <= 7; number++) {
    await page.locator('#feed-status').scrollIntoViewIfNeeded();
    await page.waitForFunction(count => document.querySelectorAll('#results .card').length === count, number * 12);
  }
  assert.match(await page.locator('#feed-status').textContent(), /caught up/);
  assert.ok(requests.some(r => r.page === 7));
  assert.equal(requests.filter(r => r.page === 2).length, 2);
  const cards = await page.locator('#results [data-save]').evaluateAll(elements => elements.map(e => e.dataset.save));
  assert.equal(new Set(cards).size, cards.length);
  await page.locator('[data-remove-topic]').click();
  await page.waitForURL('**/#home');
  assert.equal(await page.locator('.topic-chip').count(), 0);
  await page.reload();
  assert.equal(await page.locator('.topic-chip').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.add-topic').click();
  assert.equal(await page.locator('#topic-dialog').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#topic-dialog').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: custom topics, persistence, case-insensitive duplicates, removal, mobile dialog, automatic 7-page scroll, deduplication, retry, and end of results.');
} finally { await browser.close(); }
