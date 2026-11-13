import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(120000);
let refreshed = false;
page.on('request', request => {
  if (request.url().includes('/api/video') && request.url().includes('refresh=1')) refreshed = true;
});
try {
  await page.goto('http://127.0.0.1:3210/#watch=aqz-KE-bpKQ', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    const audio = document.querySelector('audio');
    return video?.currentTime > 2 && audio?.currentTime > 1 && !video.paused && !audio.paused;
  });
  const start = await page.evaluate(() => document.querySelector('video').currentTime);

  // Break only the audio element. The player should switch to an alternate
  // AAC track, then refresh metadata automatically if every track fails.
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    audio.src = '/api/stream/deadbeef';
    audio.load();
    audio.play().catch(() => {});
  });
  await page.waitForFunction(() => document.querySelector('#player-status')?.textContent.includes('Reconnecting') || document.querySelector('audio')?.error, null, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(previous => {
    const video = document.querySelector('video');
    const audio = document.querySelector('audio');
    return video.currentTime > previous + 3 && audio.currentTime > previous + 2 && !video.paused && !audio.paused && !audio.error;
  }, start, { timeout: 120000 });

  const state = await page.evaluate(() => ({
    video: document.querySelector('video').currentTime,
    audio: document.querySelector('audio').currentTime,
    audioSrc: document.querySelector('audio').src,
    status: document.querySelector('#player-status').innerText,
  }));
  assert.ok(refreshed || !state.audioSrc.includes('deadbeef'), 'player should recover the audio track automatically');
  assert.equal(state.status, '');
  assert.ok(Math.abs(state.video - state.audio) < 2, JSON.stringify(state));
  console.log('PASS: audio failure auto-reconnects with fresh metadata and resumes playback.');
} finally {
  await browser.close();
}
