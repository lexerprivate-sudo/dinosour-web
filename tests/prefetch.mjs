import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(120000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

// Use a tiny fixed feed so the test can identify the idle player and the next
// Short precisely. Metadata and media still come from the real public service.
// Three unique Shorts let the test prove that the two player pairs alternate on
// a second swipe, not just switch once.
await page.route('**/api/thumb/*', route => route.fulfill({
  status: 200,
  contentType: 'image/svg+xml',
  body: '<svg xmlns="http://www.w3.org/2000/svg" width="270" height="480"/>',
}));
await page.route('**/api/shorts?*', route => route.fulfill({
  json: {
    videos: [
      { id: 'H8hVCPzVCIM', title: 'First Short', channel: 'Test', viewsText: '1M views', thumb: '/api/thumb/H8hVCPzVCIM?t=short', type: 'short' },
      { id: 'amjeClv6zyg', title: 'Second Short', channel: 'Test', viewsText: '2M views', thumb: '/api/thumb/amjeClv6zyg?t=short', type: 'short' },
      { id: 'jNQXAC9IVRw', title: 'Third Short', channel: 'Test', viewsText: '3M views', thumb: '/api/thumb/jNQXAC9IVRw?t=short', type: 'short' },
    ],
    continuation: null,
  },
}));

try {
  await page.goto('http://localhost:3210/#short=H8hVCPzVCIM', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const video = document.querySelector('#video'), audio = document.querySelector('#audio');
    return video && video.currentTime > .5 && !video.paused && audio && audio.currentTime > .2 && !audio.paused;
  });

  // A real viewer watches the current Short while this happens. Wait until the
  // idle pair has both streams buffered before testing the swipe.
  const prefetchStarted = Date.now();
  await page.waitForFunction(() => {
    const wrap = document.querySelector('.reel-player:not(.active)');
    const video = wrap?.querySelector('video'), audio = wrap?.querySelector('audio');
    return video?.getAttribute('src')?.includes('/api/stream/') && video.readyState >= 2 && video.buffered.length
      && audio?.getAttribute('src')?.includes('/api/stream/') && audio.readyState >= 2 && audio.buffered.length;
  }, null, { timeout: 60000 });
  const prefetchMs = Date.now() - prefetchStarted;
  const before = await page.evaluate(() => {
    const wrap = document.querySelector('.reel-player:not(.active)');
    const video = wrap.querySelector('video'), audio = wrap.querySelector('audio');
    return {
      videoSrc: video.getAttribute('src'),
      audioSrc: audio.getAttribute('src'),
      activeVideoSrc: document.querySelector('#video').getAttribute('src'),
      activeAudioSrc: document.querySelector('#audio').getAttribute('src'),
      videoReady: video.readyState,
      audioReady: audio.readyState,
      videoBuffered: video.buffered.end(video.buffered.length - 1),
      audioBuffered: audio.buffered.end(audio.buffered.length - 1),
    };
  });
  console.log('idle player buffered in', prefetchMs, 'ms:', {
    videoReady: before.videoReady, videoBuffered: before.videoBuffered,
    audioReady: before.audioReady, audioBuffered: before.audioBuffered,
  });

  await page.evaluate(() => {
    window.__switchStarted = 0;
    document.querySelector('#reel-next').addEventListener('click', () => {
      window.__switchStarted = performance.now();
    }, { capture: true, once: true });
  });
  await page.locator('#reel-next').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('#video');
    return location.hash === '#short=amjeClv6zyg' && video && !video.paused && video.currentTime > 0 && video.readyState >= 2;
  });
  const videoMs = await page.evaluate(() => Math.round(performance.now() - window.__switchStarted));
  await page.waitForFunction(() => {
    const audio = document.querySelector('#audio');
    return audio && !audio.paused && audio.currentTime > 0;
  });
  const audioMs = await page.evaluate(() => Math.round(performance.now() - window.__switchStarted));
  const after = await page.evaluate(() => {
    const active = document.querySelector('.reel-player.active');
    const video = document.querySelector('#video'), audio = document.querySelector('#audio');
    return {
      activeVideo: active.querySelector('video') === video,
      activeAudio: active.querySelector('audio') === audio,
      videoSrc: video.currentSrc,
      audioSrc: audio.currentSrc,
      videoReady: video.readyState,
      spinner: !document.querySelector('#reel-loading').hidden,
    };
  });
  console.log('switch latency:', { videoMs, audioMs, videoReady: after.videoReady, spinner: after.spinner });

  assert.ok(prefetchMs < 60000, `next Short did not finish buffering: ${prefetchMs}ms`);
  assert.equal(after.activeVideo, true, 'active player wrapper does not contain #video');
  assert.equal(after.activeAudio, true, 'active player wrapper does not contain #audio');
  assert.equal(after.videoSrc, before.videoSrc, 'promoted video did not keep the preloaded source');
  assert.equal(after.audioSrc, before.audioSrc, 'promoted audio did not keep the preloaded source');
  assert.ok(after.videoReady >= 2, 'promoted video was not ready after switching');
  assert.ok(videoMs < 600, `video did not start seamlessly: ${videoMs}ms`);
  assert.ok(audioMs < 1000, `audio did not follow seamlessly: ${audioMs}ms`);
  assert.equal(after.spinner, false, 'loading spinner flashed on the preloaded switch');
  await page.waitForFunction(() => document.querySelector('#video').currentTime > .5);

  // The old active pair is now idle. It must preload item three, and the second
  // swipe must promote it in turn.
  await page.waitForFunction(previous => {
    const wrap = document.querySelector('.reel-player:not(.active)');
    const video = wrap?.querySelector('video'), audio = wrap?.querySelector('audio');
    const videoSrc = video?.getAttribute('src'), audioSrc = audio?.getAttribute('src');
    return videoSrc?.includes('/api/stream/') && videoSrc !== previous.activeVideoSrc
      && video.readyState >= 2 && video.buffered.length
      && audioSrc?.includes('/api/stream/') && audioSrc !== previous.activeAudioSrc
      && audio.readyState >= 2 && audio.buffered.length;
  }, before, { timeout: 60000 });
  const thirdBefore = await page.evaluate(() => {
    const wrap = document.querySelector('.reel-player:not(.active)');
    const video = wrap.querySelector('video'), audio = wrap.querySelector('audio');
    return { videoSrc: video.getAttribute('src'), audioSrc: audio.getAttribute('src') };
  });
  await page.evaluate(() => {
    window.__switchStarted = 0;
    document.querySelector('#reel-next').addEventListener('click', () => {
      window.__switchStarted = performance.now();
    }, { capture: true, once: true });
  });
  await page.locator('#reel-next').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('#video');
    return location.hash === '#short=jNQXAC9IVRw' && video && !video.paused && video.currentTime > 0 && video.readyState >= 2;
  });
  const secondVideoMs = await page.evaluate(() => Math.round(performance.now() - window.__switchStarted));
  await page.waitForFunction(() => {
    const audio = document.querySelector('#audio');
    return audio && !audio.paused && audio.currentTime > 0;
  });
  const secondAudioMs = await page.evaluate(() => Math.round(performance.now() - window.__switchStarted));
  const secondAfter = await page.evaluate(() => {
    const active = document.querySelector('.reel-player.active');
    const video = document.querySelector('#video'), audio = document.querySelector('#audio');
    return {
      activeVideo: active.querySelector('video') === video,
      videoSrc: video.currentSrc,
      audioSrc: audio.currentSrc,
      videoReady: video.readyState,
      spinner: !document.querySelector('#reel-loading').hidden,
    };
  });
  console.log('second switch latency:', { videoMs: secondVideoMs, audioMs: secondAudioMs, videoReady: secondAfter.videoReady, spinner: secondAfter.spinner });
  assert.equal(secondAfter.activeVideo, true, 'second promotion did not move the active wrapper');
  assert.equal(secondAfter.videoSrc, thirdBefore.videoSrc, 'second promoted video did not keep the preloaded source');
  assert.equal(secondAfter.audioSrc, thirdBefore.audioSrc, 'second promoted audio did not keep the preloaded source');
  assert.equal(secondAfter.spinner, false, 'loading spinner flashed on the second preloaded switch');
  assert.ok(secondVideoMs < 800, `second video did not start seamlessly: ${secondVideoMs}ms`);
  assert.ok(secondAudioMs < 1200, `second audio did not follow seamlessly: ${secondAudioMs}ms`);
  await page.waitForFunction(() => document.querySelector('#video').currentTime > .5);
  assert.deepEqual(errors, []);
  console.log('PASS: the next Short buffered in the idle player, promoted without reloading, and the two player pairs alternate on repeated swipes.');
} catch (error) {
  console.error('FAILED:', error.message);
  await page.screenshot({ path: 'test-results/prefetch-fail.png' });
  process.exitCode = 1;
} finally {
  await browser.close();
}
