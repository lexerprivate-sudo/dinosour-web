import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const shortInfo =');
const end = source.indexOf('\n};', start) + 3;

const infoTtlMs = 120000, infoStaleMaxMs = 6 * 60 * 60 * 1000, infoCap = 20;

const makeContext = () => {
  const pending = [], inflight = new Map(), resolved = new Map(), resolvedTimes = new Map();
  const context = vm.createContext({
    inflight, resolved, resolvedTimes,
    infoTtlMs, infoStaleMaxMs, infoCap,
    api: path => new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
  });
  const shortInfo = vm.runInContext(source.slice(start, end) + '\nshortInfo;', context);
  return { pending, inflight, resolved, resolvedTimes, shortInfo };
};

test('shortInfo serves fresh hits from cache, revalidates stale hits in the background, and blocks on expired entries', async () => {
  const { pending, inflight, resolved, resolvedTimes, shortInfo } = makeContext();
  const id = 'x';

  // Seed the cache with a first fetch.
  const seed = shortInfo(id);
  assert.equal(pending.length, 1);
  pending[0].resolve({ ticket: 'v1' });
  assert.equal((await seed).ticket, 'v1');
  assert.equal(pending.length, 1);

  // 1. Fresh hit (age < TTL): cached value, zero network calls.
  const fresh = shortInfo(id);
  assert.equal(pending.length, 1, 'fresh hit must be served from cache with no network call');
  assert.equal((await fresh).ticket, 'v1');

  // 2. Stale hit (age in [TTL, staleMax)): resolves immediately with the stale
  // ticket and issues exactly one background refresh in `pending`.
  resolvedTimes.set(id, Date.now() - infoTtlMs - 1000);
  const stale = shortInfo(id);
  assert.equal(pending.length, 2, 'stale hit issues a background refresh');
  assert.equal(pending[1].path, '/api/video?id=x&refresh=1', 'stale hit issues exactly one background refresh request');
  assert.equal((await stale).ticket, 'v1', 'stale hit resolves immediately with the stale ticket');
  const background = inflight.get(id);
  assert.ok(background, 'the background refresh is tracked as inflight');
  const staleAgain = shortInfo(id);
  assert.equal(pending.length, 2, 'a second stale call while the refresh is in flight issues no second background request');
  assert.equal((await staleAgain).ticket, 'v1', 'a second stale call is still served the stale ticket');

  // 3. Once the background refresh resolves, the next call returns the refreshed
  // value with a re-stamped age and no additional request.
  pending[1].resolve({ ticket: 'v2' });
  await background;
  const afterRefresh = shortInfo(id);
  assert.equal(pending.length, 2, 'after the background refresh resolves, no additional request is made');
  assert.equal((await afterRefresh).ticket, 'v2', 'after the background refresh resolves, the next call returns the refreshed value');
  assert.ok(Date.now() - resolvedTimes.get(id) < infoTtlMs, 'resolution re-stamps the freshness timestamp');

  // 4. Expired entry (age >= staleMax): falls through to a blocking fresh fetch
  // and does NOT serve the stale value.
  resolvedTimes.set(id, Date.now() - infoStaleMaxMs - 1000);
  let settledValue = null;
  const expired = shortInfo(id).then(info => { settledValue = info; return info; });
  assert.equal(resolved.has(id), false, 'expired entry is dropped instead of served');
  assert.equal(pending.length, 3, 'expired entry falls through to a blocking fresh fetch');
  assert.equal(pending[2].path, '/api/video?id=x', 'expired fetch is a plain fetch, not a refresh');
  await Promise.resolve();
  assert.equal(settledValue, null, 'expired entry does not serve the stale value before the fetch returns');
  pending[2].resolve({ ticket: 'v3' });
  assert.equal((await expired).ticket, 'v3');

  // 5. LRU touch: a stale serve moves the entry to the end of `resolved`.
  const other = shortInfo('y');
  assert.equal(pending.length, 4);
  pending[3].resolve({ ticket: 'y1' });
  await other;
  assert.deepEqual([...resolved.keys()], ['x', 'y'], 'entries are queued in insertion order before the stale serve');
  resolvedTimes.set('x', Date.now() - infoTtlMs - 1000);
  const staleTouch = await shortInfo('x');
  assert.equal(staleTouch.ticket, 'v3', 'stale serve returns the cached ticket');
  assert.deepEqual([...resolved.keys()], ['y', 'x'], 'a stale serve moves the entry to the end of resolved');
  pending[4].resolve({ ticket: 'x2' }); // tidy up the trailing background refresh
  await new Promise(resolve => setImmediate(resolve));
});
