import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_URL || 'http://127.0.0.1:3210';
test('serves application but does not expose source or evidence files', async () => {
  assert.equal((await fetch(base)).status, 200);
  for (const path of ['/server.js', '/rea-youtube-evidence.json', '/package.json']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});
test('rejects invalid IDs, pages, unknown streams and cross-origin requests', async () => {
  for (const path of ['/api/video?id=../../file', '/api/search?q=x&page=-1', '/api/search?q=x&page=1.5', '/api/search?q=', '/api/shorts?continuation=' + 'x'.repeat(12001)]) {
    assert.equal((await fetch(base + path)).status, 400);
  }
  assert.equal((await fetch(base + '/api/stream/invalid')).status, 410);
  assert.equal((await fetch(base + '/api/search?q=x', { headers: { origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});
