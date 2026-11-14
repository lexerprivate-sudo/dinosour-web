import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const shortInfo =');
const end = source.indexOf('\n};', start) + 3;

test('late prefetch cannot replace refreshed tickets; failed refresh allows retry', async () => {
  const pending = [], infoCache = new Map(), infoCacheTimes = new Map();
  const context = vm.createContext({
    infoCache, infoCacheTimes,
    api: path => new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
  });
  const shortInfo = vm.runInContext(source.slice(start, end) + '\nshortInfo;', context);
  const id = 'aqz-KE-bpKQ';
  const old = shortInfo(id);
  const fresh = shortInfo(id, undefined, true);
  const concurrent = shortInfo(id);
  assert.equal(pending.length, 2, 'new callers should reuse the refresh');
  pending[1].resolve({ ticket: 'fresh' });
  await fresh;
  assert.equal((await concurrent).ticket, 'fresh', 'new callers should receive fresh tickets');
  pending[0].resolve({ ticket: 'old' });
  await old;
  assert.equal((await shortInfo(id)).ticket, 'fresh');
  assert.equal(pending.length, 2);

  const failed = shortInfo(id, undefined, true);
  pending[2].reject(new Error('Offline'));
  await assert.rejects(failed, /Offline/);
  const retry = shortInfo(id);
  assert.equal(pending.length, 4, 'a failed refresh must not poison subsequent requests');
  pending[3].resolve({ ticket: 'retry' });
  assert.equal((await retry).ticket, 'retry');
});
