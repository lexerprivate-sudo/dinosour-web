// Exercise startup at the Android origin with a stalled native network, and
// failures that previously could leave the native loading overlay up forever.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const origin = 'https://appassets.androidplatform.net';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const scenario of ['stalled-network', 'syntax-error', 'missing-module', 'late-init-error']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.startupEvents = [];
      window.DinosourAndroid = {
        nativeRequest: () => {}, cancelRequest: () => {},
        readStorage: () => '{}', saveStorage: () => {},
        openSettings: () => {},
        appReady: () => window.startupEvents.push({
          ready: true,
          feed: !!document.querySelector('#feed'),
          settings: !document.querySelector('#android-settings').hidden,
        }),
        startupFailed: message => window.startupEvents.push({ error: message }),
      };
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (scenario === 'missing-module' && relative === 'app.js') {
        return route.fulfill({ status: 404, body: '' });
      }
      try {
        let body = await readFile(relative.startsWith('native/') ? relative.slice(7) : 'public/' + relative);
        if (relative === 'app.js' && scenario === 'syntax-error') body = 'const invalid = ;';
        if (relative === 'app.js' && scenario === 'late-init-error') {
          body = body.toString().replace("window.addEventListener('hashchange', route);",
            'throw new Error("late initialization failed");');
        }
        await route.fulfill({
          body, contentType: relative.endsWith('.js') ? 'text/javascript' :
            relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html',
        });
      } catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto(origin + '/#home');
    await page.waitForFunction(() => window.startupEvents.length > 0, null, { timeout: 5000 });
    const events = await page.evaluate(() => window.startupEvents);
    if (scenario === 'stalled-network') {
      assert.deepEqual(events, [{ ready: true, feed: true, settings: true }]);
      await page.locator('#android-settings').click();
      // Later playback/network errors must not replace an initialized interface.
      await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'later error' })));
      assert.equal(await page.evaluate(() => window.startupEvents.length), 1);
    } else {
      assert.ok(events.some(event => event.error), `${scenario}: missing failure notification`);
      assert.equal(events.some(event => event.ready), false, `${scenario}: falsely reported readiness`);
    }
    await context.close();
  }
  console.log('PASS: ready with stalled network; syntax, missing-module and late-initialization failures reported; later errors leave the interface visible.');
} finally {
  await browser.close();
}
