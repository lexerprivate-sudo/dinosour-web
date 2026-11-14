import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMediaChunks } from '../media-chunks.js';

function fixture({ failOnce = false, maxBytes } = {}) {
  const source = Buffer.from('abcdefghijklmnopqrstuvwx'), calls = [];
  const serve = createMediaChunks({
    chunkSize: 8, maxBytes,
    open: async (_item, _method, range) => {
      calls.push(range);
      const [, rawStart, rawEnd] = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(rawStart), end = Math.min(Number(rawEnd), source.length - 1);
      const response = Readable.from([source.subarray(start, end + 1)]);
      response.statusCode = start >= source.length ? 416 : 206;
      response.headers = {
        'content-range': start >= source.length ? `bytes */${source.length}` : `bytes ${start}-${end}/${source.length}`,
        'content-type': 'video/mp4',
      };
      if (failOnce) { failOnce = false; response.headers['content-range'] = 'bytes 1-8/24'; }
      return response;
    },
  });
  const request = async range => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    const handled = await serve({ method: 'GET', headers: { range } }, res, { url: 'https://media.googlevideo.com/example' });
    return { ...res, handled };
  };
  return { calls, request };
}

test('caps open ranges, reads ahead, and shares cached/in-flight chunks', async () => {
  const { calls, request } = fixture();
  const first = await request('bytes=0-');
  assert.equal(first.headers['content-range'], 'bytes 0-7/24');
  assert.equal(first.body.toString(), 'abcdefgh');
  const [a, b] = await Promise.all([request('bytes=8-'), request('bytes=8-')]);
  assert.equal(a.body.toString(), 'ijklmnop');
  assert.deepEqual(a.body, b.body);
  assert.equal(calls.filter(range => range === 'bytes=8-15').length, 1);
});

test('respects probes and end-of-file; leaves suffix ranges to the proxy', async () => {
  const { calls, request } = fixture();
  const probe = await request('bytes=0-1');
  assert.equal(probe.body.toString(), 'ab');
  assert.deepEqual(calls, ['bytes=0-1']);
  assert.equal((await request('bytes=22-')).body.toString(), 'wx');
  assert.equal((await request('bytes=30-')).status, 416);
  assert.equal((await request('bytes=-4')).handled, false);
});

test('retries invalid upstream chunks without caching bad responses', async () => {
  const { calls, request } = fixture({ failOnce: true });
  assert.equal((await request('bytes=0-1')).body.toString(), 'ab');
  assert.equal(calls.length, 2);
  await request('bytes=0-1');
  assert.equal(calls.length, 2);
});

test('evicts old bytes within the cache budget', async () => {
  const { calls, request } = fixture({ maxBytes: 2 });
  await request('bytes=0-1');
  await request('bytes=2-3');
  await request('bytes=0-1');
  assert.equal(calls.length, 3);
});
