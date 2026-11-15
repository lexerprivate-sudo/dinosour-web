// Bounded ranges avoid CDN throttling of open-ended media downloads. Keep a
// small shared read-ahead cache, rather than downloading entire long videos.
export function createMediaChunks({ open, chunkSize = 1024 * 1024, maxBytes = 64 * 1024 * 1024 }) {
  const cache = new Map(), pending = new Map();
  let bytes = 0, warming = 0;
  async function chunk(item, start, end) {
    const key = `${item.url}|${start}-${end}`;
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await open(item, 'GET', `bytes=${start}-${end}`, controller.signal);
          if (response.statusCode === 416) {
            response.destroy();
            return { status: 416, range: response.headers['content-range'] };
          }
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
          if (response.statusCode !== 206 || !range || Number(range[1]) !== start ||
              Number(range[2]) > end) {
            response.destroy();
            throw new Error('Invalid media chunk response');
          }
          const buffers = [];
          let length = 0;
          for await (const buffer of response) {
            length += buffer.length;
            if (length > chunkSize) { response.destroy(); throw new Error('Oversized media chunk'); }
            buffers.push(buffer);
          }
          if (length !== Number(range[2]) - start + 1) throw new Error('Incomplete media chunk');
          const result = { body: Buffer.concat(buffers), start, end: Number(range[2]),
            total: Number(range[3]), type: response.headers['content-type'] || 'application/octet-stream' };
          // Invariant: only fully validated chunks enter the shared LRU cache; failed attempts are never cached.
          cache.set(key, result); bytes += length;
          while (bytes > maxBytes && cache.size) {
            const oldest = cache.keys().next().value;
            bytes -= cache.get(oldest).body.length; cache.delete(oldest);
          }
          return result;
        } catch (error) { lastError = error; }
        finally { clearTimeout(timer); }
      }
      throw lastError;
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  }
  return async function serve(req, res, item) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (req.method !== 'GET' || !match) return false;
    const start = Number(match[1]), requestedEnd = match[2] ? Number(match[2]) : Infinity;
    if (!Number.isSafeInteger(start) || requestedEnd < start) return false;
    const end = Math.min(requestedEnd, start + chunkSize - 1);
    const data = await chunk(item, start, end);
    if (res.destroyed) return true;
    if (data.status === 416) {
      res.writeHead(416, data.range ? { 'content-range': data.range } : {});
      res.end();
      return true;
    }
    res.writeHead(206, {
      'content-type': data.type, 'content-length': data.body.length,
      'content-range': `bytes ${data.start}-${data.end}/${data.total}`,
      'accept-ranges': 'bytes', 'cache-control': 'private, no-store',
    });
    res.end(data.body);
    // One chunk ahead per active track, at most two speculative requests total.
    // Small header probes and explicit short ranges should not start read-ahead.
    if (data.body.length === chunkSize && data.end + 1 < data.total && warming < 2) {
      warming++;
      chunk(item, data.end + 1, Math.min(data.end + chunkSize, data.total - 1))
        .catch(() => {}).finally(() => warming--);
    }
    return true;
  };
}
