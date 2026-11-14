import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = await mkdtemp(path.join(os.tmpdir(), 'dinosour-desktop-test-'));
const executablePath = path.resolve(process.env.DESKTOP_EXE || 'dist/win-unpacked/Dinosour Web.exe');
let app;
const launch = () => electron.launch({
  executablePath, env: { ...process.env, DINOSOUR_TEST_PROFILE: profile }, timeout: 30000,
});
try {
  app = await launch();
  const page = await app.firstWindow();
  page.setDefaultTimeout(120000);
  await page.waitForFunction(() => window.__dinosourReady);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined', 'renderer must not expose Node');
  await page.locator('#feed .card').first().waitFor();
  await page.goto('http://127.0.0.1:43219/#watch=aqz-KE-bpKQ');
  await page.waitForFunction(() => {
    const video = document.querySelector('#video'), audio = document.querySelector('#audio');
    return video?.currentTime > 2 && !video.paused && audio?.currentTime > 1 && !audio.paused;
  }, null, { timeout: 150000 });
  await page.locator('#save').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('dinosour.library.v1')).saved.some(v => v.id === 'aqz-KE-bpKQ'), null, { timeout: 5000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dinosour.library.v1')));
  assert.ok(saved.saved.some(v => v.id === 'aqz-KE-bpKQ'));
  await app.close(); app = null;
  await assert.rejects(fetch('http://127.0.0.1:43219/api/health', { signal: AbortSignal.timeout(3000) }));
  app = await launch();
  const reopened = await app.firstWindow();
  await reopened.waitForFunction(() => window.__dinosourReady);
  const restored = await reopened.evaluate(() => JSON.parse(localStorage.getItem('dinosour.library.v1')));
  assert.ok(restored.saved.some(v => v.id === 'aqz-KE-bpKQ'), 'saved videos must survive restart');
  assert.ok(restored.history.some(v => v.id === 'aqz-KE-bpKQ'), 'history must survive restart');
  console.log('PASS: packaged Windows app starts, loads live feed, plays video/audio with bundled tools, persists library/history and stops its backend on exit.');
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
