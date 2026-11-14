// Public web search only. Playback resolution is handled separately by yt-dlp.
const text = value => value?.simpleText || value?.runs?.map(run => run.text || '').join('') || '';
const viewCount = value => {
  const match = text(value).replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return 0;
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] || 1;
  return Math.round(Number(match[1]) * scale) || 0;
};
// Search results publish a relative age ("2 years ago"), not a date. Turn it
// into an approximate timestamp so the Newest sort still orders loaded results.
const publishedAt = value => {
  const match = text(value).toLowerCase().match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) return undefined;
  const units = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
  return Date.now() - Number(match[1]) * units[match[2]];
};
const SHORTS_PARAMS = 'EgIQCQ%3D%3D';
const VIDEO_PARAMS = 'EgIQAQ%3D%3D';
const CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20240910.00.00', hl: 'en', gl: 'US' } };
const YOUTUBE_HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  origin: 'https://www.youtube.com',
  cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+000; SOCS=CAI',
};
const shortId = value => value?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
  || value?.onTap?.innertubeCommand?.commandMetadata?.webCommandMetadata?.url?.match(/\/shorts\/([\w-]{11})/)?.[1]
  || value?.entityId?.match(/([\w-]{11})$/)?.[1]
  || '';
export async function search(query, continuation, mode = 'video') {
  const response = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: YOUTUBE_HEADERS,
    body: JSON.stringify({
      context: CONTEXT,
      ...(continuation ? { continuation } : { query, params: mode === 'shorts' ? SHORTS_PARAMS : VIDEO_PARAMS }),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('YouTube search is temporarily unavailable. Please retry.');
  const data = await response.json();
  const videos = [], seen = new Set();
  let next;
  function addShort(s) {
    const id = shortId(s);
    if (!/^[\w-]{11}$/.test(id) || seen.has(id)) return;
    seen.add(id);
    videos.push({
      id,
      title: s.overlayMetadata?.primaryText?.content || s.accessibilityText?.split(',')[0] || 'YouTube Short',
      channel: 'YouTube Short',
      duration: 0,
      views: viewCount(s.overlayMetadata?.secondaryText?.content),
      viewsText: s.overlayMetadata?.secondaryText?.content || '',
      thumb: `/api/thumb/${id}?t=short`,
      type: 'short',
    });
  }
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.shortsLockupViewModel) addShort(node.shortsLockupViewModel);
    // Continuation pages can include regular videos even with the Shorts filter.
    // The Shorts shelf only wants shortsLockupViewModel entries.
    const v = mode === 'shorts' ? null : node.videoRenderer;
    if (v && /^[\w-]{11}$/.test(v.videoId) && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      const length = text(v.lengthText);
      videos.push({ id: v.videoId, title: text(v.title), channel: text(v.ownerText) || text(v.longBylineText),
        duration: length ? length.split(':').reduce((n, part) => n * 60 + Number(part), 0) : 0,
        views: viewCount(v.viewCountText), viewsText: text(v.viewCountText),
        published: text(v.publishedTimeText) || undefined, publishedAt: publishedAt(v.publishedTimeText),
        thumb: `/api/thumb/${v.videoId}`, type: 'video' });
    }
    if (!next && node.continuationCommand?.token) next = node.continuationCommand.token;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(data);
  return { videos, continuation: next || null };
}

// The anonymous Shorts page exposes a real, server-ordered watch sequence.
// Unlike a fixed search query, this sequence changes between requests, so the
// All tab does not show the same handful of Shorts on every visit.
const shortMetaCache = new Map();
const BROWSE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+000; SOCS=CAI',
};

async function shortDetails(id) {
  const hit = shortMetaCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.value;
  try {
    const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: YOUTUBE_HEADERS,
      body: JSON.stringify({ context: CONTEXT, videoId: id, contentCheckOk: true, racyCheckOk: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const details = (await response.json()).videoDetails;
    if (!details) return null;
    const value = {
      title: details.title || 'YouTube Short',
      channel: details.author || 'YouTube Short',
      views: Number(details.viewCount) || 0,
    };
    if (shortMetaCache.size > 400) shortMetaCache.delete(shortMetaCache.keys().next().value);
    shortMetaCache.set(id, { value, expires: Date.now() + 30 * 60 * 1000 });
    return value;
  } catch { return null; }
}

async function reelSequence(continuation) {
  const response = await fetch('https://www.youtube.com/youtubei/v1/reel/reel_watch_sequence?prettyPrint=false', {
    method: 'POST',
    headers: YOUTUBE_HEADERS,
    body: JSON.stringify({ context: CONTEXT, continuation }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('YouTube Shorts is temporarily unavailable. Please retry.');
  const data = await response.json();
  const entries = (data.entries || [])
    .map(entry => entry?.command?.reelWatchEndpoint)
    .filter(entry => /^[\w-]{11}$/.test(entry?.videoId || ''));
  return {
    entries,
    continuation: data.continuationEndpoint?.continuationCommand?.token || null,
  };
}

export async function shortsFeed(continuation) {
  let entries = [], next = null;
  if (continuation) {
    ({ entries, continuation: next } = await reelSequence(continuation));
  } else {
    const response = await fetch('https://www.youtube.com/shorts', {
      headers: BROWSE_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('YouTube Shorts is temporarily unavailable. Please retry.');
    const html = await response.text();
    const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
    if (!match) throw new Error('YouTube did not return a Shorts feed. Please retry.');
    const initial = JSON.parse(match[1]);
    const first = initial.replacementEndpoint?.reelWatchEndpoint;
    const token = initial.sequenceContinuation;
    const sequence = token ? await reelSequence(token) : { entries: [], continuation: null };
    entries = [first, ...sequence.entries];
    next = sequence.continuation;
  }

  const seen = new Set(), videos = [];
  for (const entry of entries) {
    const id = entry?.videoId;
    if (!/^[\w-]{11}$/.test(id || '') || seen.has(id)) continue;
    seen.add(id);
    const prefetched = entry.unserializedPrefetchData?.playerResponse?.videoDetails;
    videos.push({
      id,
      title: prefetched?.title || 'YouTube Short',
      channel: prefetched?.author || 'YouTube Short',
      duration: 0,
      views: Number(prefetched?.viewCount) || 0,
      viewsText: '',
      thumb: `/api/thumb/${id}?t=short`,
      type: 'short',
    });
  }

  // The sequence only embeds full metadata for its first item. Resolve the rest
  // through the lightweight public player response, in parallel, so grid cards
  // still show real titles and channels instead of placeholders.
  await Promise.all(videos.map(async video => {
    if (video.title !== 'YouTube Short') return;
    const details = await shortDetails(video.id);
    if (!details) return;
    video.title = details.title;
    video.channel = details.channel;
    video.views = details.views;
  }));

  return { videos, continuation: next || null };
}

// A Shorts search is stable by design. Pull a few result pages into one pool so
// the initial page can be reordered on every visit while every card still
// belongs to the requested topic.
export async function shortsPool(query, pages = 3) {
  const videos = [], seen = new Set();
  let continuation = '', next = null;
  for (let page = 0; page < pages; page++) {
    const data = await search(query, continuation, 'shorts');
    for (const video of data.videos) {
      if (seen.has(video.id)) continue;
      seen.add(video.id);
      videos.push(video);
    }
    next = data.continuation || null;
    if (!next) break;
    continuation = next;
  }
  return { videos, continuation: next };
}
