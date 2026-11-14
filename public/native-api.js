import { search, shortsFeed, shortsPool } from './native/youtube-search.js';
import { selectAudioFormats, audioTrackGroups } from './native/audio-formats.js';

const cache = new Map();
const videoId = value => /^[\w-]{11}$/.test(value || '');
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
async function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const entry = { promise: Promise.resolve().then(loader), expires: Date.now() + ttl };
  cache.set(key, entry);
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  try { return await entry.promise; }
  catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
}
function mediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.googlevideo.com') ? url.href : null;
  } catch { return null; }
}
export function normalizeVideo(info) {
  if (info.is_live || info.is_upcoming) throw new Error('Choose a recorded public video. Live broadcasts are not supported.');
  const formats = (info.formats || []).filter(f => f.protocol === 'https' && !f.has_drm && mediaUrl(f.url));
  const height = f => Math.min(f.width || 0, f.height || 0) || f.height || 0;
  const seen = new Set();
  const qualities = formats.filter(f => f.vcodec?.startsWith('avc1') && height(f) > 0 && height(f) <= 1080)
    .sort((a, b) => height(b) - height(a) || (b.tbr || 0) - (a.tbr || 0))
    .filter(f => !seen.has(height(f)) && seen.add(height(f)))
    .map(f => ({ label: `${height(f)}p`, height: height(f), src: f.url, separateAudio: f.acodec === 'none' }));
  const audio = selectAudioFormats(formats);
  if (!qualities.length || (qualities.every(q => q.separateAudio) && !audio.length)) throw new Error('No compatible public stream is available for this video.');
  const captions = [];
  for (const [automatic, tracks] of [[false, info.subtitles || {}], [true, info.automatic_captions || {}]]) {
    for (const [language, entries] of Object.entries(tracks)) {
      if (captions.some(c => c.language === language)) continue;
      const format = entries.find(f => f.ext === 'vtt' && /^https:\/\/(?:www\.)?youtube\.com\//.test(f.url || ''));
      if (format) captions.push({ language, label: `${entries[0]?.name || language}${automatic ? ' (Auto)' : ''}`, src: format.url });
    }
  }
  return {
    id: info.id, title: info.title || 'YouTube video', channel: info.uploader || info.channel || 'YouTube',
    duration: info.duration || 0, views: info.view_count, published: info.upload_date || '',
    description: info.description || '', thumb: `/api/thumb/${info.id}`,
    qualities, audio: audio[0]?.url || null, audioFallbacks: audio.slice(1, 3).map(f => f.url),
    audioTracks: audioTrackGroups(formats).map(({ formats: tracks, ...group }) => ({
      ...group, src: tracks[0].url, fallbacks: tracks.slice(1).map(f => f.url),
    })),
    captions,
  };
}
export async function handleRequest(url, signal) {
  try {
    const params = url.searchParams;
    let data;
    switch (url.pathname) {
      case '/api/ping': data = { ok: true, app: 'dinosour', standalone: true }; break;
      case '/api/network':
        data = { standalone: true, lan: [], publicUrl: null, accessRequired: false,
          inviteUrl: 'https://github.com/lexerprivate-sudo/dinosour-web/releases/latest/download/DinosourWeb.apk' };
        break;
      case '/api/video': {
        const id = params.get('id');
        if (!videoId(id)) return json({ error: 'Invalid YouTube video ID.' }, 400);
        if (params.get('refresh') === '1') cache.delete(`video:${id}`);
        // Shared metadata jobs outlive one navigation; app.js owns per-view cancellation.
        data = await cached(`video:${id}`, 120000, async () =>
          normalizeVideo(JSON.parse(await window.__dinosourNativeCall('extract', { id }))));
        break;
      }
      case '/api/search': {
        const q = (params.get('q') || '').trim().slice(0, 200);
        const continuation = params.get('continuation') || '';
        const mode = params.get('shorts') === '1' ? 'shorts' : 'video';
        if (!q || continuation.length > 12000) return json({ error: 'Enter a search term.' }, 400);
        const result = await cached(JSON.stringify(['search', q, continuation, mode]), 60000, () =>
          mode === 'shorts' && !continuation ? shortsPool(q) : search(q, continuation, mode));
        data = { ...result, videos: result.videos.slice() };
        if (mode === 'shorts' && !continuation) {
          for (let i = data.videos.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [data.videos[i], data.videos[j]] = [data.videos[j], data.videos[i]];
          }
        }
        break;
      }
      case '/api/shorts': {
        const continuation = params.get('continuation') || '';
        if (continuation.length > 12000) return json({ error: 'Invalid Shorts continuation.' }, 400);
        try { data = await shortsFeed(continuation); }
        catch (error) {
          if (continuation) throw error;
          const fallback = await search('popular shorts', '', 'shorts');
          data = { videos: fallback.videos, continuation: null };
        }
        break;
      }
      case '/api/suggest': {
        const q = (params.get('q') || '').trim().slice(0, 120);
        if (!q) { data = { suggestions: [] }; break; }
        data = await cached(`suggest:${q}`, 60000, async () => {
          const response = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`);
          if (!response.ok) throw new Error('Suggestions are unavailable.');
          const body = await response.json();
          return { suggestions: Array.isArray(body?.[1]) ? body[1].filter(v => typeof v === 'string').slice(0, 10) : [] };
        });
        break;
      }
      default: return json({ error: 'Not found.' }, 404);
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    return json(data);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return json({ error: error.message || 'Check your Wi-Fi or mobile data and try again.' }, 502);
  }
}
