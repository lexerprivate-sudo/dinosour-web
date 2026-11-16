// Dinosour playback kernel: the pieces shared by the entry bundle (app.js)
// and the lazily imported Shorts reel (reel.js). app.js imports what it uses
// statically; reel.js imports it on demand so the entry bundle shrinks.
const $ = (selector) => document.querySelector(selector);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const views = n => n == null ? 'YouTube' : `${Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)} views`;

async function api(path, signal) {
  let response;
  try {
    response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  let data = null;
  const type = response.headers.get('content-type') || '';
  if (type.includes('json')) {
    try { data = await response.json(); } catch (error) {
      if (error?.name === 'AbortError') throw error;
      data = null;
    }
  }
  if (response.status === 401) {
    const next = `${location.pathname}${location.search}${location.hash}`;
    location.assign(`/unlock?next=${encodeURIComponent(next)}`);
    throw new Error(data?.error || 'This server needs its access code. Open the invite link again.');
  }
  if (!response.ok) throw new Error(data?.error || `The server answered HTTP ${response.status}. Please retry.`);
  if (data === null) throw new Error('The server returned an unexpected response. Please retry.');
  return data;
}
// Shared feed-metadata cache and SWR logic live below; `inflight` holds
// id -> Promise for requests still loading, `resolved` the finished entries.
const inflight = new Map();
const resolved = new Map();
const resolvedTimes = new Map();
const shortsSession = { query: '', items: [], cursor: '', shuffled: false };
const isMetered = () => Boolean(navigator.connection?.saveData) || ['slow-2g', '2g'].includes(navigator.connection?.effectiveType || '');
// Preferences are loaded once here so the entry bundle and the lazy reel
// read the same object. `replacePreferences` swaps its contents in place so
// importers never have to reassign an imported binding.
let toastTimer;
function toast(text) {
  $('#toast').textContent = text; $('#toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2600);
}
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('dinosour.ui.v1')); } catch { preferences = null; }
if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) preferences = {};
preferences.topics = Array.isArray(preferences.topics) ? [...new Set(preferences.topics.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 80)).filter(Boolean))] : [];
preferences.recentSearches = Array.isArray(preferences.recentSearches) ? [...new Set(preferences.recentSearches.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 120)).filter(Boolean))].slice(0, 8) : [];
savePreferences();
function savePreferences() {
  try { localStorage.setItem('dinosour.ui.v1', JSON.stringify(preferences)); } catch {}
}

const infoTtlMs = 120000, infoStaleMaxMs = 6 * 60 * 60 * 1000, infoCap = 20;
// `inflight` holds id -> Promise for requests still loading; `resolved` holds
// id -> info for finished requests. They are split so the identity guard can
// key off the inflight entry alone.
const shortInfo = (id, signal, refresh) => {
  const now = Date.now();
  if (!refresh) {
    const info = resolved.get(id);
    if (info) {
      const age = now - (resolvedTimes.get(id) || 0);
      if (age < infoStaleMaxMs) {
        if (age >= infoTtlMs && !inflight.has(id)) {
          // Stale-while-revalidate: serve the stale entry now and refresh in
          // the background so the next caller gets fresh data.
          shortInfo(id, undefined, true).catch(() => {});
        }
        // LRU: move the entry to the end on every access.
        resolved.delete(id); resolved.set(id, info);
        return Promise.resolve(info);
      }
      // Older than the stale window: drop it and fall through to a fetch.
      resolved.delete(id); resolvedTimes.delete(id);
    }
    if (inflight.has(id)) return inflight.get(id);
  }
  let request;
  request = api(`/api/video?id=${id}${refresh ? '&refresh=1' : ''}`, signal).then(info => {
    // An older prefetch may finish after a refresh. Only the current request
    // owns this cache entry; evicted requests must not reinsert themselves.
    if (inflight.get(id) === request) {
      inflight.delete(id);
      resolved.delete(id); resolved.set(id, info);
      resolvedTimes.set(id, Date.now()); // Stamped at resolution, not at insertion.
      if (resolved.size > infoCap) {
        const oldest = resolved.keys().next().value;
        resolved.delete(oldest); resolvedTimes.delete(oldest);
      }
    }
    return info;
  });
  // Cache the in-flight request as well, so a concurrent prefetch or retry
  // cannot fall back to the old stream tickets while fresh metadata loads.
  inflight.set(id, request);
  request.catch(() => {
    if (inflight.get(id) === request) inflight.delete(id);
  });
  return request;
};


// Seconds of media buffered ahead of the current playback position, or 0 when
// the position is not inside a buffered range. Shared by watch and reel.
function bufferedAhead(media) {
  for (let i = 0; i < media.buffered.length; i++) {
    if (media.buffered.start(i) <= media.currentTime && media.buffered.end(i) >= media.currentTime) return media.buffered.end(i) - media.currentTime;
  }
  return 0;
}

function preferredAudio(info) {
  const tracks = info.audioTracks || [];
  if (!preferences.audioLanguage || ['en', 'preferred-en'].includes(preferences.audioLanguage)) {
    const english = tracks.filter(t => t.language.split('-')[0] === 'en');
    return english.find(t => t.original) || english[0] || tracks.find(t => t.original) || tracks[0];
  }
  const exact = tracks.find(t => t.id === preferences.audioLanguage);
  if (exact) return exact;
  if (preferences.audioLanguage === 'original') return tracks.find(t => t.original) || tracks[0];
  const language = preferences.audioLanguage || 'en';
  return tracks.find(t => t.language === language) ||
    tracks.find(t => t.language.split('-')[0] === language.split('-')[0]) ||
    tracks.find(t => t.original) || tracks[0];
}

// applyBackup() swaps the whole preferences object; the entry bundle cannot
// reassign an imported binding, so it calls this instead.
function replacePreferences(next) {
  for (const key of Object.keys(preferences)) delete preferences[key];
  Object.assign(preferences, next);
  return preferences;
}

export {
  $, icon, escape, views, api, toast,
  preferences, savePreferences, replacePreferences,
  shortsSession, isMetered, shortInfo, bufferedAhead, preferredAudio,
};
