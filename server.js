import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { search, shortsFeed, shortsPool } from './youtube-search.js';
import { selectAudioFormats } from './audio-formats.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3210);
// Public HTTPS origin when the app runs behind a reverse proxy. When it is set,
// stream URLs use the app origin, which the proxy also forwards.
const publicOrigin = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
// Optional dedicated media origin, for example https://media.example.com.
const mediaOrigin = (process.env.MEDIA_ORIGIN || '').replace(/\/+$/, '');
// Media gets its own origin so Chrome's six-connections-per-origin limit is not
// consumed by yt-dlp metadata/search requests while a stream is starting.
const mediaPort = Number(process.env.MEDIA_PORT || port + 1);
let mediaBase = '';
const cache = new Map();
const tickets = new Map();
let active = 0;
const validId = (id) => /^[A-Za-z0-9_-]{11}$/.test(id || '');

function extract(args) {
  if (active >= 4) return Promise.reject(new Error('A few videos are loading. Please try again in a moment.'));
  active++;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.YTDLP_PATH || 'yt-dlp', [
      '--ignore-config', '--no-warnings', '--no-playlist', '--socket-timeout', '12', '--retries', '1', '--extractor-retries', '1',
      '--js-runtimes', 'node', '--remote-components', 'ejs:github', ...args,
    ], { windowsHide: true, shell: false });
    let output = '', errors = '', done = false;
    const finish = (error, data) => {
      if (done) return;
      done = true; active--; clearTimeout(timer);
      error ? reject(error) : resolve(data);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('YouTube took too long to respond. Please retry.')); }, 90000);
    child.on('error', () => finish(new Error('yt-dlp could not start. Install it or set YTDLP_PATH; see README.md.')));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) { child.kill(); finish(new Error('YouTube response is too large.')); }
    });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-6000); });
    child.on('close', (code) => {
      if (code !== 0) {
        const reason = /sign in|confirm.*bot/i.test(errors) ? 'YouTube requires sign-in or has temporarily blocked this connection.'
          : /private|unavailable|removed|members|age/i.test(errors) ? 'This video is restricted or unavailable without an account.'
          : 'Could not retrieve this video from YouTube. Retry, or update yt-dlp.';
        return finish(new Error(reason));
      }
      try { finish(null, JSON.parse(output)); } catch { finish(new Error('YouTube returned an unreadable response.')); }
    });
  });
}

async function cached(key, ttl, loader) {
  const found = cache.get(key);
  if (found && found.expires > Date.now()) return found.value;
  const value = loader();
  cache.set(key, { value, expires: Date.now() + ttl });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  try { return await value; } catch (error) { cache.delete(key); throw error; }
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function normalize(v) {
  return {
    id: v.id, title: v.title || 'YouTube video', channel: v.uploader || v.channel || 'YouTube',
    duration: v.duration || 0, views: v.view_count, published: v.upload_date || '',
    thumb: `/api/thumb/${v.id}`,
    description: v.description || '',
  };
}

function ticket(format, headers) {
  const url = new URL(format.url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com')) throw new Error('Unsupported video source.');
  const id = randomBytes(24).toString('hex');
  const signedExpiry = Number(url.searchParams.get('expire')) * 1000;
  tickets.set(id, { url: url.href, headers, expires: signedExpiry > Date.now() ? signedExpiry : Date.now() + 6 * 60 * 60 * 1000 });
  if (tickets.size > 600) tickets.delete(tickets.keys().next().value);
  return id;
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

// Stream tickets are stored once but turned into URLs per request, so the same
// metadata works for localhost, a LAN phone and a public HTTPS deployment.
function mediaBaseFor(req) {
  if (mediaOrigin) return mediaOrigin;
  if (publicOrigin) return publicOrigin;
  const origin = requestOrigin(req);
  if (!origin) return mediaBase;
  if (!mediaBase || mediaPort === port) return origin;
  try {
    const url = new URL(origin);
    url.port = String(mediaPort);
    return url.origin;
  } catch {
    return mediaBase;
  }
}

function withStreamUrls(video, base) {
  const src = id => `${base}/api/stream/${id}`;
  return {
    ...video,
    qualities: video.qualities.map(({ ticket, ...quality }) => ({ ...quality, src: src(ticket) })),
    audio: video.audio ? src(video.audio) : null,
    audioFallbacks: video.audioFallbacks.map(src),
  };
}

async function getVideo(id) {
  return cached(`video:${id}`, 10 * 60 * 1000, async () => {
    const info = await extract(['--skip-download', '--dump-single-json', '--', `https://www.youtube.com/watch?v=${id}`]);
    if (info.is_live) throw new Error('Live broadcasts are not supported yet. Choose a recorded video.');
    const formats = (info.formats || []).filter(f => f.protocol === 'https' && f.url && !f.has_drm);
    // Vertical Shorts report 1080x1920. Use the shorter side for quality labels,
    // so a portrait 720x1280 stream is "720p" rather than "1280p".
    const qualityOf = f => Math.min(f.width || 0, f.height || 0) || f.height || 0;
    const video = formats.filter(f => f.vcodec?.startsWith('avc1') && qualityOf(f) <= 1080).sort((a, b) => qualityOf(b) - qualityOf(a) || (b.tbr || 0) - (a.tbr || 0));
    // Keep alternative AAC tracks as fallbacks. A single signed media URL can
    // occasionally be refused by YouTube mid-play; the browser can switch to a
    // different track without asking the user to reopen the whole video.
    const audioFormats = selectAudioFormats(formats);
    const audio = audioFormats[0];
    const heights = new Set();
    const qualities = video.filter(f => !heights.has(qualityOf(f)) && heights.add(qualityOf(f))).map(f => ({
      label: `${qualityOf(f)}p`, height: qualityOf(f), ticket: ticket(f, f.http_headers || info.http_headers),
      separateAudio: f.acodec === 'none',
    }));
    if (!qualities.length || (qualities.every(f => f.separateAudio) && !audio)) throw new Error('No compatible public stream is available for this video.');
    return {
      ...normalize(info), qualities,
      audio: audio ? ticket(audio, audio.http_headers || info.http_headers) : null,
      audioFallbacks: audioFormats.slice(1, 3).map(f => ticket(f, f.http_headers || info.http_headers)),
    };
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function serveStream(req, res, url) {
  try {
    const item = tickets.get(url.pathname.slice('/api/stream/'.length));
    if (!item || item.expires <= Date.now()) return json(res, 410, { error: 'Playback link expired. Reopen the video.' });
    if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range)) return json(res, 416, { error: 'Invalid range.' });
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const deadline = setTimeout(() => controller.abort(), 45000);
    let upstream, failure;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 500));
        upstream = await openMedia(item, req.method, req.headers.range, controller.signal);
        if ([200, 206, 416].includes(upstream.statusCode)) break;
        failure = upstream.statusCode;
        upstream.resume();
        await new Promise(resolve => upstream.once('end', resolve));
      }
    } finally { clearTimeout(deadline); }
    if (!upstream || ![200, 206, 416].includes(upstream.statusCode)) {
      console.error(`Media upstream failed after retries${failure ? ` (${failure})` : ''}.`);
      return json(res, 502, { error: 'YouTube refused the media stream. Reopen the video to retry.' });
    }
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[key]) res.setHeader(key, upstream.headers[key]);
    }
    res.setHeader('cache-control', 'private, no-store');
    res.writeHead(upstream.statusCode);
    if (req.method === 'HEAD') { upstream.resume(); return res.end(); }
    await pipeline(upstream, res);
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    console.error(`Stream proxy error: ${error.message}${error.code ? ` (${error.code})` : ''}; range=${req.headers.range || 'none'}`);
    json(res, 502, { error: 'The video stream was interrupted. Please retry.' });
  }
}

function openMedia(item, method, range, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(item.url), {
      method, agent: false, signal,
      headers: {
        'user-agent': item.headers?.['User-Agent'] || 'Mozilla/5.0',
        ...(range ? { range } : {}),
      },
    }, response => {
      // googlevideo.com regularly answers a signed request with a 302 to a
      // different edge host. Follow it instead of reporting a failed stream.
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && location && redirects < 4) {
        const next = new URL(location, item.url);
        if (next.protocol !== 'https:' || !next.hostname.endsWith('.googlevideo.com')) {
          response.resume();
          return reject(new Error('Unsupported media redirect.'));
        }
        response.resume();
        resolve(openMedia({ ...item, url: next.href }, method, range, signal, redirects + 1));
        return;
      }
      resolve(response);
    });
    request.on('error', reject);
    request.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const origin = req.headers.origin;
  if (origin && origin !== publicOrigin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin) && origin !== requestOrigin(req)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
  if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname.startsWith('/api/thumb/')) {
      const id = url.pathname.slice('/api/thumb/'.length);
      if (!validId(id)) return json(res, 400, { error: 'Invalid thumbnail ID.' });
      const short = url.searchParams.get('t') === 'short';
      const image = await cached(`thumb:${short ? 'short:' : ''}${id}`, 30 * 60 * 1000, async () => {
        for (const name of short ? ['oar2', 'frame0', 'hqdefault'] : ['hqdefault']) {
          const upstream = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
          if (upstream?.ok) return Buffer.from(await upstream.arrayBuffer());
        }
        throw new Error('Thumbnail unavailable.');
      });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': image.length, 'cache-control': 'public, max-age=1800' });
      return res.end(req.method === 'HEAD' ? undefined : image);
    }
    if (url.pathname === '/api/shorts') {
      const continuation = url.searchParams.get('continuation') || '';
      if (continuation.length > 12000) return json(res, 400, { error: 'Use the returned Shorts continuation for more results.' });
      if (!continuation) {
        try {
          const feed = await shortsFeed();
          if (feed.videos.length || feed.continuation) return json(res, 200, feed);
        } catch {
          // Fall through to the stable search fallback below.
        }
        // Keep the page usable if YouTube's Shorts surface is temporarily
        // unavailable. The fallback is a stable search, so do not return a
        // search continuation to the reel-sequence API.
        const fallback = await cached('shorts:fallback', 60 * 1000, () => search('popular shorts', '', 'shorts'));
        return json(res, 200, { videos: fallback.videos, continuation: null });
      }
      const result = await cached(JSON.stringify(['shorts-sequence', continuation]), 2 * 60 * 1000, () => shortsFeed(continuation));
      return json(res, 200, result);
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
      const page = Number(url.searchParams.get('page') || 1);
      const continuation = url.searchParams.get('continuation') || '';
      const mode = url.searchParams.get('shorts') === '1' ? 'shorts' : 'video';
      if (!q || page !== 1 || continuation.length > 12000) return json(res, 400, { error: 'Enter a search term and use the returned continuation for more results.' });
      if (mode === 'shorts' && !continuation) {
        // Shorts search is deterministic. Build a cached pool from several
        // result pages and reorder each fresh visit, so a topic feed visibly
        // changes without leaving the requested topic.
        const pool = await cached(JSON.stringify(['shorts-pool', q]), 10 * 60 * 1000, () => shortsPool(q));
        return json(res, 200, { videos: shuffle(pool.videos.slice()), continuation: pool.continuation });
      }
      const result = await cached(JSON.stringify(['search', mode, q, continuation]), 5 * 60 * 1000, () => search(q, continuation, mode));
      return json(res, 200, result);
    }
    if (url.pathname === '/api/video') {
      const id = url.searchParams.get('id');
      if (!validId(id)) return json(res, 400, { error: 'Invalid YouTube video ID.' });
      if (url.searchParams.get('refresh') === '1') cache.delete(`video:${id}`);
      return json(res, 200, withStreamUrls(await getVideo(id), mediaBaseFor(req)));
    }
    if (url.pathname.startsWith('/api/stream/')) return serveStream(req, res, url);
    if (url.pathname === '/.well-known/assetlinks.json') {
      const body = await readFile(root + '.well-known/assetlinks.json').catch(() => null);
      if (!body) return json(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'public, max-age=3600' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (url.pathname === '/app-update.json') {
      const body = await readFile(root + 'app-update.json').catch(() => null);
      if (!body) return json(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (url.pathname === '/download/DinosourWeb.apk') {
      const body = await readFile(root + 'download/DinosourWeb.apk').catch(() => null);
      if (!body) return json(res, 404, { error: 'The Android APK has not been built yet.' });
      res.writeHead(200, {
        'content-type': 'application/vnd.android.package-archive',
        'content-length': body.length,
        'content-disposition': 'attachment; filename="DinosourWeb.apk"',
        'cache-control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const files = {
      '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
      '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8', 'no-cache'],
      '/style.css': ['style.css', 'text/css; charset=utf-8', 'no-cache'],
      '/icon.svg': ['icon.svg', 'image/svg+xml', 'public, max-age=86400'],
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8', 'public, max-age=3600'],
      '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
      '/icons/icon-192.png': ['icons/icon-192.png', 'image/png', 'public, max-age=604800'],
      '/icons/icon-512.png': ['icons/icon-512.png', 'image/png', 'public, max-age=604800'],
      '/icons/icon-maskable-512.png': ['icons/icon-maskable-512.png', 'image/png', 'public, max-age=604800'],
      '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png', 'public, max-age=604800'],
      '/icons/favicon-32.png': ['icons/favicon-32.png', 'image/png', 'public, max-age=604800'],
    };
    const file = files[url.pathname];
    if (!file) return json(res, 404, { error: 'Not found.' });
    const body = await readFile(root + file[0]);
    res.writeHead(200, { 'content-type': file[1], 'content-length': body.length, 'cache-control': file[2] });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    json(res, 502, { error: 'The video stream was interrupted. Please retry.' });
  }
});
const mediaServer = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
  const url = new URL(req.url, `http://127.0.0.1:${mediaPort}`);
  if (!url.pathname.startsWith('/api/stream/')) return json(res, 404, { error: 'Not found.' });
  serveStream(req, res, url);
});
mediaServer.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Media port ${mediaPort} is busy; streams will use port ${port}.` : error.message);
  mediaBase = '';
});
mediaServer.listen(mediaPort, host, () => {
  mediaBase = `http://127.0.0.1:${mediaPort}`;
});

server.listen(port, host, () => {
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`Dinosour is ready: http://${shownHost}:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    const addresses = new Set();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const address of list || []) {
        if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) addresses.add(address.address);
      }
    }
    for (const address of addresses) console.log(`On your phone (same Wi-Fi): http://${address}:${port}`);
  }
  if (process.argv.includes('--open')) {
    const url = `http://localhost:${port}`;
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
});
server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT to another port.` : error.message); process.exitCode = 1; });
