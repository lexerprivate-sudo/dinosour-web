import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_URL || 'http://127.0.0.1:3210';
const pngSize = buffer => [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];

test('serves an installable manifest with correctly sized icons', async () => {
  const response = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/manifest\+json/);
  const manifest = await response.json();
  assert.equal(manifest.name, 'Dinosour');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const image = await fetch(base + icon.src);
    assert.equal(image.status, 200, `${icon.src} is missing`);
    assert.equal(image.headers.get('content-type'), icon.type);
    const [width, height] = pngSize(Buffer.from(await image.arrayBuffer()));
    assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} has the wrong dimensions`);
  }
});

test('serves an uncached service worker that leaves API and cross-origin traffic alone', async () => {
  const response = await fetch(`${base}/sw.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.match(response.headers.get('cache-control'), /no-cache/);
  const script = await response.text();
  assert.match(script, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(script, /url\.origin !== self\.location\.origin/);
  assert.match(script, /request\.headers\.has\('range'\)/);
});

test('page declares mobile install metadata and safe-area layout', async () => {
  const html = await (await fetch(base)).text();
  assert.match(html, /name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  const css = await (await fetch(`${base}/style.css`)).text();
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.equal((await fetch(`${base}/.well-known/assetlinks.json`)).status, 404);
});

test('serves Android update metadata for in-app upgrade checks', async () => {
  const response = await fetch(`${base}/app-update.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const update = await response.json();
  assert.equal(typeof update.versionCode, 'number');
  assert.equal(typeof update.versionName, 'string');
  assert.equal(typeof update.apkUrl, 'string');
  assert.ok(update.versionCode >= 1);
  assert.ok(update.apkUrl.startsWith('/download/') || update.apkUrl.startsWith('https://'));
});
