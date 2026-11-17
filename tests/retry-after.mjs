// Live-dev-server contract test. This file is intentionally NOT named *.test.js
// so `npm test` (tests/*.test.js) does not pick it up: it needs a server on
// 127.0.0.1:3210 and an upstream yt-dlp failure, neither of which is
// guaranteed offline. Run explicitly with:
//   node --test tests/retry-after.mjs
// If the dev server is not reachable the test is reported as skipped with an
// explicit reason instead of failing hard.
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:3210';
// A well-formed but unresolvable video id (valid 11-char shape) designed to
// make yt-dlp fail fast, without depending on any particular YouTube outage.
const VIDEO_URL = `${BASE}/api/video?id=ZZZZDiL4FuY`;

async function devServerUp() {
  try {
    const res = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const serverUp = await devServerUp();
const skipReason = 'dev server not reachable at http://127.0.0.1:3210 — start it (e.g. `node server.js`) and re-run `node --test tests/retry-after.mjs`';

test('GET /api/video with an unresolvable id returns 502, a Retry-After header, and a JSON error body', { skip: serverUp ? false : skipReason }, async () => {
  const res = await fetch(VIDEO_URL, { signal: AbortSignal.timeout(90000) });

  // a) HTTP 502
  assert.equal(res.status, 502, `expected 502, got ${res.status}`);

  // b) A retry-after header present, compared case-insensitively.
  const retryAfterEntry = [...res.headers.entries()].find(([name]) => name.toLowerCase() === 'retry-after');
  assert.ok(retryAfterEntry, 'expected a retry-after header on the 502 response');
  assert.ok(String(retryAfterEntry[1]).trim().length > 0, 'retry-after header was present but empty');

  // c) Body still JSON with an 'error' string.
  const body = await res.json();
  assert.equal(typeof body.error, 'string', `expected body.error to be a string, got: ${JSON.stringify(body)}`);
  assert.ok(body.error.length > 0, 'expected body.error to be a non-empty string');
});
