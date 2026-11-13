import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.TEST_URL || 'http://127.0.0.1:3210';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === 'activated', null, { timeout: 15000 });
  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, active: ready.active?.state, caches: await caches.keys() };
  });
  assert.equal(registration.active, 'activated', `service worker did not activate: ${JSON.stringify(registration)}`);
  assert.ok(registration.scope.startsWith(base + '/'), `unexpected service worker scope: ${registration.scope}`);
  assert.ok(registration.caches.includes('dinosour-shell-v1'), `shell cache missing: ${JSON.stringify(registration.caches)}`);

  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'page is not controlled by the service worker');

  const client = await page.context().newCDPSession(page);
  await client.send('Page.enable');
  const manifest = await client.send('Page.getAppManifest');
  assert.deepEqual(manifest.errors, [], `manifest errors: ${JSON.stringify(manifest.errors)}`);
  const installability = await client.send('Page.getInstallabilityErrors');
  const unexpected = installability.installabilityErrors.filter(error => error.errorId !== 'in-incognito');
  assert.deepEqual(unexpected, [], `app is not installable: ${JSON.stringify(unexpected)}`);

  assert.equal(await page.evaluate(() => document.querySelector('#android-settings').hidden), true, 'Android settings should stay hidden in a browser');
  const native = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await native.addInitScript(() => {
    window.DinosourAndroid = { openSettings: () => { window.__settingsOpened = true; } };
  });
  await native.goto(base + '/', { waitUntil: 'load' });
  await native.locator('#android-settings:not([hidden])').waitFor();
  await native.click('#android-settings');
  assert.equal(await native.evaluate(() => window.__settingsOpened), true, 'Android settings bridge was not called');
  assert.equal(await native.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Android header overflows the mobile viewport');
  await native.screenshot({ path: 'test-results/android-header.png' });
  await native.close();

  await page.context().setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const shell = await page.evaluate(() => ({ brand: document.querySelector('.brand span')?.textContent, main: !!document.querySelector('#main') }));
  assert.deepEqual(shell, { brand: 'Dinosour', main: true }, `offline shell did not load: ${JSON.stringify(shell)}`);
  console.log('PASS: PWA manifest, service worker activation, installability and offline shell.');
} finally {
  await browser.close();
}
