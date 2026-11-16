import { $, icon, escape, views, api, toast, preferences, savePreferences, replacePreferences, shortsSession, isMetered, shortInfo, preferredAudio } from './playback-core.js';
import { LocalDownloads } from '/downloads.js';
const main = $('#main');
const key = 'dinosour.library.v1';
let library;
try { library = JSON.parse(localStorage.getItem(key)); } catch { library = null; }
if (!library || typeof library !== 'object' || Array.isArray(library)) library = {};
library = sanitizeLibrary(library);
const videos = new Map();
let browsePrepareTimer, browsePreparing = false;
const autoRetryCount = new Map();
let generation = 0, cleanup = () => {};
let playbackBusy = false, playbackBufferAhead = Infinity, miniSession = null;
let downloadsTimer = null;
function allowPrefetch() {
  return !playbackBusy && playbackBufferAhead >= 3 && !isMetered();
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', theme === 'light' ? '#ffffff' : '#0f0f0f');
  const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
  $('#theme-toggle').innerHTML = icon(theme === 'light' ? 'moon' : 'sun');
  $('#theme-toggle').setAttribute('aria-label', label);
  $('#theme-toggle').title = label;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#ffffff' : '#0f0f0f';
}
setTheme(preferences.theme === 'light' || (!preferences.theme && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark');
$('#theme-toggle').onclick = () => {
  preferences.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  setTheme(preferences.theme); savePreferences();
};
const narrowNavigation = matchMedia('(max-width: 1100px)');
function updateNavigation() {
  const expanded = narrowNavigation.matches ? document.body.classList.contains('nav-open') : !preferences.collapsed;
  document.body.classList.toggle('nav-collapsed', !!preferences.collapsed);
  $('#menu-toggle').setAttribute('aria-expanded', String(expanded));
  $('#nav-scrim').hidden = !narrowNavigation.matches || !expanded;
}
function closeNavigation() { document.body.classList.remove('nav-open'); updateNavigation(); }
$('#menu-toggle').onclick = () => {
  if (narrowNavigation.matches) document.body.classList.toggle('nav-open');
  else { preferences.collapsed = !preferences.collapsed; savePreferences(); }
  updateNavigation();
};
$('#nav-scrim').onclick = closeNavigation;
narrowNavigation.addEventListener('change', closeNavigation);
updateNavigation();
function updateSearch() { $('#clear-search').hidden = !$('#search').value; }
$('#search').addEventListener('input', updateSearch);
$('#clear-search').onclick = () => { $('#search').value = ''; updateSearch(); $('#search').focus(); };
function persist() {
  try { localStorage.setItem(key, JSON.stringify(library)); } catch { toast('Device storage is full; changes could not be saved.'); }
}
persist();
// Resume any download that was in flight when the app last closed.
syncDownloadWatchers();
function duration(seconds) {
  if (!seconds) return '';
  const s = Math.floor(seconds);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function remember(v) { videos.set(v.id, v); return v; }
function compact(v) {
  return { id: v.id, title: v.title, channel: v.channel, duration: v.duration, views: v.views, viewsText: v.viewsText, thumb: v.thumb, type: v.type };
}
function toggle(field, id) {
  const v = videos.get(id);
  if (!v) return;
  const exists = library[field].some(item => item.id === id);
  library[field] = exists ? library[field].filter(item => item.id !== id) : [compact(v), ...library[field]].slice(0, 500);
  persist();
  toast(exists ? 'Removed from your library' : field === 'saved' ? 'Saved to Watch later' : 'Added to liked videos');
  return !exists;
}
function watchProgress(v) {
  const item = library.history.find(entry => entry.id === v.id);
  if (!item || !item.duration || item.position < 2) return 0;
  return Math.min(100, Math.max(0, item.position / item.duration * 100));
}
function card(v) {
  remember(v);
  const saved = library.saved.some(item => item.id === v.id);
  const hue = [...(v.channel || '')].reduce((n, char) => n + char.charCodeAt(0), 0) % 360;
  const href = v.type === 'short' ? `#short=${v.id}` : `#watch=${v.id}`;
  const percent = watchProgress(v);
  return `<article class="card"><div class="thumb"><a href="${href}" aria-label="Watch ${escape(v.title)}"><img src="${escape(v.thumb)}" alt="" loading="lazy" decoding="async"></a>${v.duration ? `<span class="duration">${duration(v.duration)}</span>` : ''}${percent ? `<span class="watched-bar" style="width:${percent.toFixed(1)}%" aria-hidden="true"></span>` : ''}<button class="save-card ${saved ? 'selected' : ''}" data-save="${v.id}" aria-label="${saved ? 'Remove' : 'Save'} ${escape(v.title)} ${saved ? 'from' : 'to'} Watch later" aria-pressed="${saved}" title="${saved ? 'Saved to Watch later' : 'Watch later'}">${icon(saved ? 'check' : 'clock')}</button></div><div class="card-body"><span class="avatar" style="--avatar-hue:${hue}" aria-hidden="true">${escape(v.channel?.[0]?.toUpperCase() || 'Y')}</span><div class="card-copy"><h3><a href="${href}">${escape(v.title)}</a></h3><p>${escape(v.channel)}</p><p>${escape(v.viewsText || views(v.views))}</p><div class="queue-card-tools"><button data-queue-next="${v.id}" aria-label="Play next: ${escape(v.title)}">Play next</button><button data-queue-add="${v.id}" aria-label="Queue: ${escape(v.title)}">Queue</button><button data-save-to="${v.id}" aria-label="Save ${escape(v.title)} to a collection">Save to…</button></div></div></div></article>`;
}
function continueWatching() {
  // Older history entries may not have a stored duration yet. Keep them
  // resumable anyway; the progress bar appears once duration is known.
  const items = library.history.filter(v => v && v.position > 5 && !v.continueHidden &&
    (!v.duration || (v.duration > 20 && v.position < v.duration - 10))).slice(0, 10);
  if (!items.length) return '';
  return `<section class="continue-section" aria-labelledby="continue-title"><div class="continue-heading"><div><h2 id="continue-title">Continue watching</h2><p>Pick up where you left off</p></div><button data-clear-continue>Clear</button></div><div class="continue-rail">${items.map(v => {
    remember(v);
    const percent = v.duration ? Math.min(100, v.position / v.duration * 100) : 0;
    return `<article class="continue-card"><a class="continue-thumb" href="#watch=${v.id}" aria-label="Resume ${escape(v.title)}"><img src="${escape(v.thumb)}" alt="" loading="lazy" decoding="async"><span class="duration">${v.duration ? `${duration(v.duration - v.position)} left` : 'In progress'}</span>${percent ? `<span class="watched-bar" style="width:${percent.toFixed(1)}%" aria-hidden="true"></span>` : ''}</a><div class="continue-copy"><h3><a href="#watch=${v.id}">${escape(v.title)}</a></h3><p>${escape(v.channel)}</p><div class="continue-actions"><a class="resume" href="#watch=${v.id}">Resume</a><button data-restart="${v.id}">Start over</button><button class="continue-remove" data-continue-remove="${v.id}" aria-label="Remove ${escape(v.title)} from Continue watching">×</button></div></div></article>`;
  }).join('')}</div></section>`;
}
function shortCard(v) {
  remember(v);
  const saved = library.saved.some(item => item.id === v.id);
  return `<article class="short-card"><div class="short-thumb"><a href="#short=${v.id}" aria-label="Play ${escape(v.title)}"><img src="${escape(v.thumb)}" alt="" loading="lazy" decoding="async"></a><button class="save-card ${saved ? 'selected' : ''}" data-save="${v.id}" aria-label="${saved ? 'Remove' : 'Save'} ${escape(v.title)} ${saved ? 'from' : 'to'} Watch later" aria-pressed="${saved}" title="${saved ? 'Saved to Watch later' : 'Watch later'}">${icon(saved ? 'check' : 'clock')}</button></div><div class="short-copy"><h3><a href="#short=${v.id}">${escape(v.title)}</a></h3><p>${escape(v.viewsText || views(v.views))}</p></div></article>`;
}
function skeleton() { return `<div class="grid">${Array.from({ length: 9 }, () => '<div class="skeleton"><div class="thumb"></div><div class="bone"></div><div class="bone" style="width:50%"></div></div>').join('')}</div>`; }
function shortsSkeleton() { return `<div class="shorts-grid">${Array.from({ length: 12 }, () => '<div class="skeleton short-skeleton"><div class="thumb"></div><div class="bone"></div></div>').join('')}</div>`; }
function empty(title, text, retry = false) {
  return `<div class="empty">${icon(retry ? 'history' : 'library')}<h2>${escape(title)}</h2><p>${escape(text)}</p>${retry ? '<button data-retry class="primary">Try again</button>' : '<a class="primary" href="#home">Browse videos</a>'}</div>`;
}
function chips(selected, scope = 'search') {
  const shorts = scope === 'shorts';
  const all = shorts ? '#shorts' : '#home';
  const topicHref = topic => shorts ? `#shorts=${encodeURIComponent(topic)}` : `#search=${encodeURIComponent(topic)}`;
  return `<nav class="chips" aria-label="Your topics"><a class="${!selected ? 'active' : ''}" href="${all}" ${!selected ? 'aria-current="page"' : ''}>All</a>${preferences.topics.map(topic => `<span class="topic-chip ${selected === topic ? 'active' : ''}"><a href="${topicHref(topic)}" ${selected === topic ? 'aria-current="page"' : ''}>${escape(topic)}</a><button data-remove-topic="${escape(topic)}" aria-label="Remove ${escape(topic)}" title="Remove topic">${icon('close')}</button></span>`).join('')}<button class="add-topic" data-add-topic aria-label="Add a topic" title="Add a topic">${icon('plus')}</button></nav>`;
}
function decodeValue(hash) {
  try { return decodeURIComponent(hash.split('=').slice(1).join('=')); } catch { return ''; }
}
function chipsState() {
  const hash = location.hash.slice(1) || 'home';
  if (hash === 'shorts') return { scope: 'shorts', selected: '' };
  if (hash.startsWith('shorts=')) return { scope: 'shorts', selected: decodeValue(hash) };
  if (hash.startsWith('search=')) return { scope: 'search', selected: decodeValue(hash) };
  return { scope: 'search', selected: '' };
}
function inShortsContext() {
  const hash = location.hash.slice(1);
  return hash === 'shorts' || hash.startsWith('shorts=') || hash.startsWith('short=');
}
function renderTopicNavigation() {
  $('#topic-navigation').innerHTML = `<h2 class="nav-label">Your topics</h2>${preferences.topics.map(topic => `<a href="#search=${encodeURIComponent(topic)}" data-nav="${escape(topic)}" title="${escape(topic)}">${icon('search')}<span>${escape(topic)}</span></a>`).join('')}<button class="sidebar-add-topic" data-add-topic>${icon('plus')}<span>Add a topic</span></button>`;
}
renderTopicNavigation();
function openTopicDialog() {
  $('#topic-form').reset(); $('#topic-name').setCustomValidity('');
  $('#topic-dialog').showModal(); $('#topic-name').focus();
}
$('#close-topic').onclick = $('#cancel-topic').onclick = () => $('#topic-dialog').close();
$('#topic-name').oninput = () => $('#topic-name').setCustomValidity('');
$('#topic-form').onsubmit = event => {
  event.preventDefault();
  const topic = $('#topic-name').value.trim().replace(/\s+/g, ' ');
  if (!topic) { $('#topic-name').setCustomValidity('Enter a topic name.'); $('#topic-name').reportValidity(); return; }
  const existing = preferences.topics.find(t => t.toLowerCase() === topic.toLowerCase());
  if (!existing) { preferences.topics.push(topic); savePreferences(); renderTopicNavigation(); }
  $('#topic-dialog').close();
  const hash = inShortsContext() ? `#shorts=${encodeURIComponent(existing || topic)}` : `#search=${encodeURIComponent(existing || topic)}`;
  if (location.hash === hash) route(); else location.hash = hash;
};

async function feed(query, current, controller, mode = 'video') {
  const shorts = mode === 'shorts';
  const home = !query && !shorts;
  if (shorts) {
    if (shortsSession.query !== query) { shortsSession.items = []; shortsSession.cursor = ''; }
    shortsSession.query = query;
  }
  const homeShorts = shorts && !query;
  const term = query || (shorts ? 'popular shorts' : 'beautiful nature science short films');
  main.className = shorts ? 'shorts-page' : home ? 'home-page' : 'search-page';
  const filters = {
    duration: query && ['short', 'medium', 'long'].includes(preferences.searchDuration) ? preferences.searchDuration : 'any',
    sort: query && ['newest', 'views', 'shortest', 'longest'].includes(preferences.searchSort) ? preferences.searchSort : 'relevance',
  };
  const option = (value, label, selected) => `<option value="${value}" ${selected ? 'selected' : ''}>${label}</option>`;
  const filterBar = !shorts && query ? `<div class="search-filters" aria-label="Search filters"><label>Duration <select id="filter-duration">${option('any', 'Any length', filters.duration === 'any')}${option('short', 'Under 4 minutes', filters.duration === 'short')}${option('medium', '4–20 minutes', filters.duration === 'medium')}${option('long', 'Over 20 minutes', filters.duration === 'long')}</select></label><label>Sort by <select id="filter-sort">${option('relevance', 'Relevance', filters.sort === 'relevance')}${option('newest', 'Newest', filters.sort === 'newest')}${option('views', 'Most viewed', filters.sort === 'views')}${option('shortest', 'Shortest', filters.sort === 'shortest')}${option('longest', 'Longest', filters.sort === 'longest')}</select></label><span id="result-count"></span></div>` : '';
  const heading = shorts
    ? `<div class="search-heading shorts-heading"><h1>${query ? `Shorts for ${escape(query)}` : 'Shorts'}</h1></div>`
    : home ? '<h1 class="sr-only">Home</h1>' : `<div class="search-heading"><h1>Results for ${escape(query)}</h1><span>Videos</span></div>`;
  main.innerHTML = `${chips(query || '', shorts ? 'shorts' : 'search')}${home ? continueWatching() : ''}${heading}${filterBar}<h2 class="sr-only">${shorts ? 'Shorts feed' : 'Videos'}</h2><div id="feed" aria-busy="true">${shorts ? shortsSkeleton() : skeleton()}</div>`;
  let continuation = '', loading = false, ended = false, failed = false, initialized = false, frame;
  const seen = new Set(), usedCursors = new Set(), allResults = [];
  const durationMatches = v => filters.duration === 'any' || !v.duration ||
    filters.duration === 'short' && v.duration < 240 ||
    filters.duration === 'medium' && v.duration >= 240 && v.duration <= 1200 ||
    filters.duration === 'long' && v.duration > 1200;
  const viewNumber = v => Number(v.views) || (() => {
    const match = String(v.viewsText || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
    return match ? Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] || 1) : 0;
  })();
  const publishedNumber = v => Number(v.publishedAt) || Date.parse(v.published || '') || 0;
  const sortResults = list => {
    if (filters.sort === 'views') return [...list].sort((a, b) => viewNumber(b) - viewNumber(a));
    if (filters.sort === 'newest') return [...list].sort((a, b) => publishedNumber(b) - publishedNumber(a));
    if (filters.sort === 'shortest') return [...list].sort((a, b) => (a.duration || Infinity) - (b.duration || Infinity));
    if (filters.sort === 'longest') return [...list].sort((a, b) => (b.duration || 0) - (a.duration || 0));
    return list;
  };
  const visibleResults = () => sortResults(allResults.filter(durationMatches));
  const updateResultCount = () => {
    const count = visibleResults().length;
    if ($('#result-count')) $('#result-count').textContent = `${count}${ended ? '' : '+'} ${count === 1 ? 'video' : 'videos'}`;
  };
  const renderResults = () => {
    const node = $('#results');
    if (!node) return;
    const visible = visibleResults();
    node.innerHTML = visible.length ? visible.map(card).join('') :
      ended ? (allResults.length
        ? empty('No videos match these filters', 'Try a different duration or sort option.')
        : empty('No videos found', 'Try another search or paste a YouTube video link.')) : '';
    updateResultCount();
  };
  const bindFilters = () => {
    $('#filter-duration')?.addEventListener('change', event => {
      filters.duration = event.target.value; preferences.searchDuration = filters.duration; savePreferences(); renderResults(); prepareVisibleMetadata();
    });
    $('#filter-sort')?.addEventListener('change', event => {
      filters.sort = event.target.value; preferences.searchSort = filters.sort; savePreferences(); renderResults(); prepareVisibleMetadata();
    });
  };
  bindFilters();
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) load();
  }, { rootMargin: '650px 0px' });
  cleanup = () => { observer.disconnect(); cancelAnimationFrame(frame); };
  // Cache the first page per query locally so repeat visits paint instantly,
  // then swap in fresh results when the network answers.
  const bootKey = `dinosour.feed.v1:${query || 'home'}`;
  let booted = false;
  const load = async () => {
    if (loading || ended || failed || current !== generation) return;
    const firstPage = continuation === '';
    loading = true;
    $('#feed').setAttribute('aria-busy', 'true');
    if (!initialized && firstPage && !shorts) {
      try {
        const saved = JSON.parse(localStorage.getItem(bootKey) || 'null');
        if (saved?.videos?.length) {
          $('#feed').innerHTML = `<div class="grid" id="results">${saved.videos.slice(0, 18).map(card).join('')}</div><div id="feed-status" class="feed-status" role="status"></div>`;
          initialized = true;
          booted = true;
          observer.observe($('#feed-status'));
        }
      } catch { /* localStorage unavailable */ }
    }
    const status = $('#feed-status');
    if (status) status.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Loading more ${shorts ? 'Shorts' : 'videos'}…</span>`;
    try {
      const params = new URLSearchParams();
      if (homeShorts) {
        if (continuation) params.set('continuation', continuation);
      } else {
        params.set('q', term);
        if (shorts) params.set('shorts', '1');
        if (continuation) params.set('continuation', continuation);
      }
      const data = await api(`${homeShorts ? '/api/shorts' : '/api/search'}?${params}`, controller.signal);
      if (current !== generation) return;
      if (!initialized) {
        $('#feed').innerHTML = `<div class="${shorts ? 'shorts-grid' : 'grid'}" id="results"></div><div id="feed-status" class="feed-status" role="status"></div>`;
        initialized = true;
        observer.observe($('#feed-status'));
      } else if (booted) {
        booted = false;
        $('#results').innerHTML = '';
      }
      if (firstPage && !shorts) {
        try { localStorage.setItem(bootKey, JSON.stringify(data.videos.slice(0, 18))); } catch { /* quota */ }
      }
      const fresh = data.videos.filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; });
      if (shorts) {
        $('#results').insertAdjacentHTML('beforeend', fresh.map(shortCard).join(''));
        for (const v of data.videos) if (!shortsSession.items.some(item => item.id === v.id)) shortsSession.items.push(v);
        shortsSession.cursor = data.continuation || shortsSession.cursor;
      } else {
        allResults.push(...fresh);
        if (filters.sort === 'relevance') {
          if ($('#results .empty')) $('#results').innerHTML = '';
          $('#results').insertAdjacentHTML('beforeend', fresh.filter(durationMatches).map(card).join(''));
          updateResultCount();
        } else renderResults();
        prepareVisibleMetadata();
      }
      if (continuation) usedCursors.add(continuation);
      continuation = data.continuation || '';
      ended = !continuation || usedCursors.has(continuation);
      if (!shorts) {
        updateResultCount();
        if (ended && !$('#results').children.length) renderResults();
      } else if (!$('#results').children.length && ended) {
        $('#results').innerHTML = empty('No Shorts found', 'Try another Shorts search or add a topic.');
      }
      $('#feed-status').textContent = ended ? (shorts ? 'You’re all caught up for these Shorts.' : 'You’re all caught up for this search.') : '';
      if (ended) observer.disconnect();
      $('#feed').setAttribute('aria-busy', 'false');
    } catch (error) {
      if (current !== generation || error.name === 'AbortError') return;
      failed = true;
      // Explicit offline detection: navigator.onLine === false, or the api()
      // fetch failure message while the browser reports not-online.
      const offline = typeof navigator !== 'undefined' && (navigator.onLine === false
        || (navigator.onLine !== true && /could not reach the server/i.test(error.message || '')));
      if (initialized) {
        $('#feed-status').innerHTML = `<span>${escape(offline ? 'You appear to be offline. Check your connection, then try again.' : error.message)}</span><button id="retry-feed">Retry</button>`;
        $('#retry-feed').onclick = () => { failed = false; load(); };
        $('#feed').setAttribute('aria-busy', 'false');
      }
      else { $('#feed').innerHTML = offline ? empty('You appear to be offline', 'Your saved library and history are still available. Check your connection, then try again.', true) : empty('Couldn’t load videos', error.message, true); $('#feed').setAttribute('aria-busy', 'false'); }
    } finally {
      loading = false;
      if (current === generation && !failed && !ended) {
        frame = requestAnimationFrame(() => {
          if ($('#feed-status')?.getBoundingClientRect().top < innerHeight + 650) load();
        });
      }
    }
  };
  await load();
}

function collection(field) {
  const titles = { saved: 'Watch later', history: 'Watch history', liked: 'Liked videos' };
  const count = library[field].length;
  main.className = 'collection-page';
  main.innerHTML = `<div class="collection-heading"><div><h1>${titles[field]}</h1><p>${count} ${count === 1 ? 'video' : 'videos'} · Saved on this device</p></div><div class="collection-actions"><button data-backup>${icon('save')}Backup</button>${count ? `<button class="clear" id="clear-library">${icon('trash')}Clear ${field === 'history' ? 'history' : 'list'}</button>` : ''}</div></div>${count ? `<div class="grid">${library[field].map(card).join('')}</div>` : empty(field === 'history' ? 'Keep track of what you watch' : 'Your collection starts here', field === 'history' ? 'Videos you play will appear here, ready to pick up where you left off.' : 'Save or like a video to find it here later.')}`;
  if ($('#clear-library')) $('#clear-library').onclick = () => { library[field] = []; persist(); collection(field); };
  prepareVisibleMetadata();
}

// Library: one page for Watch later, Liked videos and the user's own
// collections. Collections live inside library.collections on the same
// dinosour.library.v1 blob, so backup/restore carries them automatically.
let currentCollectionId = null;
function refreshLibraryView() {
  const y = window.scrollY;
  const hash = location.hash.slice(1);
  if (hash === 'library' || hash === 'saved' || hash === 'liked') libraryPage();
  else if (hash.startsWith('collection=')) collectionDetail(decodeValue(hash));
  else return;
  window.scrollTo(0, y);
}
// Downloads keep moving while the app is open — poll the local engine once a
// second and fold finished transfers into the library. One shared timer, only
// while something is actually downloading.
function syncDownloadWatchers() {
  const active = (library.downloads || []).filter(d => d.state === 'downloading');
  if (!active.length) { clearInterval(downloadsTimer); downloadsTimer = null; return; }
  if (downloadsTimer) return;
  downloadsTimer = setInterval(() => {
    const remaining = (library.downloads || []).filter(d => d.state === 'downloading');
    if (!remaining.length) { clearInterval(downloadsTimer); downloadsTimer = null; return; }
    for (const entry of remaining) refreshDownloadState(entry);
  }, 1000);
}
function refreshDownloadState(entry) {
  LocalDownloads.stat(entry.id).then(stat => {
    if (!stat) return;
    if (stat.state === 'done') {
      entry.state = 'done';
      entry.videoBytes = Number(stat.videoBytes) || 0;
      entry.audioBytes = Number(stat.audioBytes) || 0;
      entry.bytes = entry.videoBytes + entry.audioBytes;
      entry.downloadedAt = Date.now();
      persist(); syncDownloadWatchers();
      if (location.hash === '#library' || location.hash.startsWith('#downloads') || location.hash === '#watch=' + entry.id || location.hash.startsWith('#collection=')) refreshLibraryView();
      if (document.querySelector('[data-download-toggle]')) paintDownloadControls(entry.id);
      toast('Downloaded — watch offline any time');
    } else if (stat.state === 'failed' && entry.state !== 'failed') {
      entry.state = 'failed';
      persist(); syncDownloadWatchers();
      refreshLibraryView();
      if (document.querySelector('[data-download-toggle]')) paintDownloadControls(entry.id);
      toast('Download failed. Tap Download to try again.');
    }
  }).catch(() => {});
}
function synthesizeOfflineInfo(id, entry, urls) {
  const known = videos.get(id);
  return {
    id,
    title: known?.title || entry.title || 'Offline video',
    channel: known?.channel || entry.channel || 'YouTube',
    duration: entry.duration || known?.duration || 0,
    views: known?.views ?? null,
    viewsText: known?.viewsText || '',
    published: '',
    description: 'Downloaded on this device. This video plays offline.',
    thumb: entry.thumb || `/api/thumb/${id}`,
    qualities: [{ label: `${entry.qualityHeight || 'Offline'}p (offline)`, height: entry.qualityHeight || 0, src: urls.video, separateAudio: Boolean(urls.audio), size: entry.videoBytes || null }],
    audio: urls.audio || null,
    audioFallbacks: [],
    audioTracks: [],
    audioSize: entry.audioBytes || null,
    captions: [],
  };
}
let downloadsWatchInfo = null, activeObjectUrls = [];
function paintDownloadControls(id) {
  const entry = (library.downloads || []).find(d => d.id === id);
  const btn = document.querySelector('#download-toggle');
  if (btn) {
    const done = entry?.state === 'done';
    btn.classList.toggle('selected', done);
    btn.setAttribute('aria-pressed', String(done));
    if (done) { btn.innerHTML = `${icon('check')}Downloaded`; btn.title = 'Downloaded — plays offline'; }
    else if (entry?.state === 'downloading') { btn.innerHTML = `${icon('download')}Downloading…`; btn.title = 'Downloading on this device…'; }
    else if (entry?.state === 'failed') { btn.innerHTML = `${icon('download')}Retry download`; btn.title = 'Download failed — try again'; }
    else { btn.innerHTML = `${icon('download')}Download`; btn.title = 'Download for offline playback'; }
  }
  const del = document.querySelector('#delete-download');
  if (del) del.hidden = entry?.state !== 'done';
}
function ensureDownloadDialog() {
  let dialog = document.querySelector('#download-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'download-dialog'; dialog.className = 'backup-dialog download-dialog';
  dialog.innerHTML = `<div class="dialog-heading"><h2>Download video</h2><button class="icon-button" id="download-close" type="button" aria-label="Close">${icon('close')}</button></div><p class="backup-intro">Pick a quality. Dinosour stores the video and its audio on this device so you can watch without a connection. Sizes are estimates.</p><div class="download-quality-list" id="download-quality-list"></div><div class="dialog-actions"><button id="download-cancel" type="button">Close</button></div>`;
  document.body.append(dialog);
  dialog.querySelector('#download-close').onclick = () => dialog.close();
  dialog.querySelector('#download-cancel').onclick = () => dialog.close();
  return dialog;
}
function openDownloadDialog(id, info) {
  const dialog = ensureDownloadDialog();
  const list = dialog.querySelector('#download-quality-list');
  const downloaded = (library.downloads || []).find(d => d.id === id);
  const audioSize = info?.audioSize;
  const audioLabel = audioSize ? ` + ${formatBytes(audioSize)} audio` : '';
  list.innerHTML = info?.qualities?.length
    ? info.qualities.map((q, index) => {
        const active = downloaded?.state === 'done' && q.height === downloaded.qualityHeight;
        return `<button class="save-row" data-download-quality="${index}" aria-pressed="${active}"><span class="save-row-icon">${icon(active ? 'check' : 'download')}</span><span class="save-row-text">${escape(q.label)}${active ? ' · Downloaded' : ''}<small>${formatBytes(q.size)} video${audioLabel}</small></span><span class="save-state ${active ? 'on' : ''}">${icon(active ? 'check' : 'plus')}</span></button>`;
      }).join('')
    : '<p class="save-to-empty">Quality information is unavailable for this video right now. Try again when you are online.</p>';
  list.onclick = event => {
    const row = event.target.closest('[data-download-quality]');
    if (!row) return;
    const quality = info.qualities[Number(row.dataset.downloadQuality)];
    if (quality) startDownload(id, info, quality);
  };
  dialog.showModal();
}
function startDownload(id, info, quality) {
  const entry = {
    id, title: info.title, channel: info.channel, duration: info.duration || 0,
    thumb: info.thumb || `/api/thumb/${id}`,
    qualityHeight: quality.height, qualityLabel: quality.label,
    videoBytes: 0, audioBytes: 0, bytes: 0, downloadedAt: 0, state: 'downloading',
  };
  library.downloads = [entry, ...(library.downloads || []).filter(d => d.id !== id)];
  persist();
  paintDownloadControls(id);
  syncDownloadWatchers();
  ensureDownloadDialog().close();
  LocalDownloads.start({ id, info, height: quality.height }).catch(error => {
    entry.state = 'failed';
    persist(); syncDownloadWatchers(); paintDownloadControls(id); refreshLibraryView();
    toast(error?.message || 'Download failed. Check your connection and try again.');
  });
  toast('Download started');
  return entry;
}
const formatBytes = bytes => {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'size unknown';
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  const mb = bytes / 1048576;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
};
function cleanDownload(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[\w-]{11}$/.test(item.id)) return null;
  const text = (v, l) => typeof v === 'string' ? v.trim().slice(0, l) : '';
  const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(max, n) : 0; };
  const clean = { id: item.id };
  clean.title = text(item.title, 300) || 'YouTube video';
  clean.channel = text(item.channel, 120) || 'YouTube';
  const thumb = text(item.thumb, 500);
  clean.thumb = thumb && (/^\/(?!\/)/.test(thumb) || /^https:\/\//i.test(thumb)) ? thumb : `/api/thumb/${item.id}`;
  if (item.type === 'short') clean.type = 'short';
  clean.duration = num(item.duration, 864000);
  clean.position = num(item.position, 864000);
  clean.qualityHeight = num(item.qualityHeight, 4320);
  clean.videoBytes = num(item.videoBytes, Number.MAX_SAFE_INTEGER);
  clean.audioBytes = num(item.audioBytes, Number.MAX_SAFE_INTEGER);
  clean.bytes = num(item.bytes, Number.MAX_SAFE_INTEGER) || clean.videoBytes + clean.audioBytes;
  clean.downloadedAt = num(item.downloadedAt, Number.MAX_SAFE_INTEGER) || Date.now();
  clean.state = ['done', 'downloading', 'failed'].includes(item.state) ? item.state : 'failed';
  return clean;
}
function compactVideo(id) {
  const known = videos.get(id);
  if (known) return compact(known);
  const title = $('.watch-title')?.textContent?.trim().slice(0, 300) || 'YouTube video';
  const channel = $('.watch-actions .channel strong')?.textContent?.trim().slice(0, 120) || 'YouTube';
  return { id, title, channel, thumb: `/api/thumb/${id}`, type: location.hash.startsWith('#short=') ? 'short' : undefined };
}
function downloadsSection(downloads) {
  if (!downloads.length) return '';
  const totalBytes = downloads.reduce((n, d) => n + (d.bytes || 0), 0);
  return `<section class="library-section" id="downloads" aria-labelledby="downloads-title"><div class="library-section-head"><h2 id="downloads-title">Downloads<span class="library-count">${downloads.length}</span></h2><p class="library-bytes">${escape(formatBytes(totalBytes))} stored on this device</p></div><div class="library-rail">${downloads.slice(0, 12).map(item => `<div class="collection-item"><button class="collection-remove" data-delete-download="${item.id}" aria-label="Delete the downloaded video ${escape(item.title)}" title="Delete download">${icon('trash')}</button>${card(item)}</div>`).join('')}</div></section>`;
}
function sectionRail(id, title, items, clearable) {
  if (!items.length) return '';
  return `<section class="library-section" id="${id}" aria-labelledby="${id}-title"><div class="library-section-head"><h2 id="${id}-title">${title}<span class="library-count">${items.length}</span></h2>${clearable ? `<button class="library-clear" data-clear-field="${clearable}">${icon('trash')}Clear</button>` : ''}</div><div class="library-rail">${items.slice(0, 12).map(card).join('')}</div></section>`;
}
function collectionCard(collection) {
  const count = collection.items.length;
  const cells = [0, 1, 2, 3].map(i => collection.items[i]
    ? `<img src="${escape(collection.items[i].thumb)}" alt="" loading="lazy" decoding="async">`
    : '<span class="mosaic-fill" aria-hidden="true"></span>').join('');
  return `<article class="collection-card"><a class="collection-cover" href="#collection=${collection.id}" aria-label="Open collection ${escape(collection.name)}"><span class="mosaic${count === 1 ? ' mosaic-single' : ''}">${cells}</span><span class="collection-count">${count} ${count === 1 ? 'video' : 'videos'}</span></a><div class="collection-meta"><a class="collection-name" href="#collection=${collection.id}" title="${escape(collection.name)}">${escape(collection.name)}</a><div class="collection-tools"><button data-play-all="${collection.id}" aria-label="Play all in ${escape(collection.name)}" title="Play all">${icon('play')}</button><button data-rename-collection="${collection.id}" aria-label="Rename ${escape(collection.name)}" title="Rename">${icon('edit')}</button><button data-delete-collection="${collection.id}" aria-label="Delete ${escape(collection.name)}" title="Delete">${icon('trash')}</button></div></div></article>`;
}
function libraryPage() {
  currentCollectionId = null;
  document.title = 'Library — Dinosour';
  main.className = 'library-page';
  const saved = library.saved, liked = library.liked, collections = library.collections, downloads = library.downloads || [];
  const total = saved.length + liked.length + downloads.length + collections.reduce((n, c) => n + c.items.length, 0);
  const hasAnything = saved.length || liked.length || downloads.length || collections.length;
  main.innerHTML = `<div class="collection-heading"><div><h1>Library</h1><p>${hasAnything ? `${total} ${total === 1 ? 'video' : 'videos'} · Saved on this device` : 'Everything you keep, in one place'}</p></div><div class="collection-actions"><button data-backup>${icon('save')}Backup</button><button class="primary" data-new-collection>${icon('plus')}New collection</button></div></div>${sectionRail('watch-later', 'Watch later', saved, 'saved')}${sectionRail('liked-videos', 'Liked videos', liked, 'liked')}${downloadsSection(downloads)}<section class="library-section" id="collections" aria-labelledby="collections-title"><div class="library-section-head"><h2 id="collections-title">Your collections<span class="library-count">${collections.length}</span></h2></div><div class="collection-grid">${collections.map(collectionCard).join('')}<button class="collection-card collection-new" data-new-collection><span class="collection-new-icon">${icon('plus')}</span><span class="collection-new-label">New collection</span><span class="collection-new-hint">Gather the videos you love</span></button></div></section>`;
  prepareVisibleMetadata();
}
function collectionDetail(id) {
  const col = library.collections.find(c => c.id === id);
  if (!col) { location.hash = '#library'; return; }
  currentCollectionId = id;
  document.title = `${col.name} — Dinosour`;
  main.className = 'collection-page';
  const count = col.items.length;
  main.innerHTML = `<div class="collection-heading"><div><a class="back-link" href="#library">${icon('back')}Library</a><h1>${escape(col.name)}</h1><p>${count} ${count === 1 ? 'video' : 'videos'} · Saved on this device</p></div><div class="collection-actions">${count ? `<button class="primary" data-play-all="${col.id}">${icon('play')}Play all</button>` : ''}<button data-rename-collection="${col.id}">${icon('edit')}Rename</button><button class="clear" data-delete-collection="${col.id}">${icon('trash')}Delete</button></div></div>${count ? `<div class="grid">${col.items.map(item => `<div class="collection-item"><button class="collection-remove" data-uncollect="${item.id}" aria-label="Remove ${escape(item.title)} from ${escape(col.name)}" title="Remove from collection">${icon('close')}</button>${card(item)}</div>`).join('')}</div>` : empty('This collection is empty', 'Save videos here from anywhere using “Save to…” on any video.')}`;
  prepareVisibleMetadata();
}
function sortIntoCollection(collection, id) {
  const at = collection.items.findIndex(i => i.id === id);
  if (at >= 0) { collection.items.splice(at, 1); return false; }
  collection.items = [compactVideo(id), ...collection.items].slice(0, 500);
  return true;
}
function toggleCollectionItem(collectionId, id) {
  const collection = library.collections.find(c => c.id === collectionId);
  if (!collection || !id) return;
  const added = sortIntoCollection(collection, id);
  persist();
  toast(added ? `Added to ${collection.name}` : `Removed from ${collection.name}`);
}
function playCollection(id) {
  const col = library.collections.find(c => c.id === id);
  if (!col || !col.items.length) return;
  col.items.forEach(item => remember(item));
  library.queue = col.items.slice(0, 100).map(compact);
  persist();
  location.hash = `#watch=${col.items[0].id}`;
}
function newCollection(name) {
  const collection = { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 40), name, createdAt: Date.now(), items: [] };
  library.collections = [...library.collections, collection];
  persist();
  return collection;
}
function ensureCollectionDialog() {
  let dialog = $('#collection-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'collection-dialog'; dialog.className = 'backup-dialog collection-dialog';
  dialog.innerHTML = `<form id="collection-form"><div class="dialog-heading"><h2 id="collection-dialog-title">New collection</h2><button class="icon-button" id="collection-dialog-close" type="button" aria-label="Close">${icon('close')}</button></div><label for="collection-name">Collection name</label><input id="collection-name" name="name" maxlength="80" required autocomplete="off" placeholder="e.g. Design inspo, Workouts, Recipes"><div class="dialog-actions"><button id="collection-cancel" type="button">Cancel</button><button class="primary" type="submit">Save</button></div></form>`;
  document.body.append(dialog);
  dialog.querySelector('#collection-dialog-close').onclick = () => dialog.close();
  dialog.querySelector('#collection-cancel').onclick = () => dialog.close();
  dialog.querySelector('#collection-name').oninput = event => event.target.setCustomValidity('');
  dialog.querySelector('#collection-form').onsubmit = event => {
    event.preventDefault();
    const input = dialog.querySelector('#collection-name');
    const name = input.value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) { input.setCustomValidity('Enter a collection name.'); input.reportValidity(); return; }
    if (dialog.dataset.mode === 'rename') {
      const col = library.collections.find(c => c.id === dialog.dataset.id);
      if (col) { col.name = name; toast('Collection renamed'); persist(); }
      dialog.close(); refreshLibraryView();
      return;
    }
    const collection = newCollection(name);
    toast(`Collection “${name}” created`);
    dialog.close();
    location.hash = `#collection=${collection.id}`;
  };
  return dialog;
}
function openCollectionDialog(mode, id) {
  const dialog = ensureCollectionDialog();
  dialog.dataset.mode = mode;
  dialog.dataset.id = id || '';
  dialog.querySelector('#collection-dialog-title').textContent = mode === 'rename' ? 'Rename collection' : 'New collection';
  const input = dialog.querySelector('#collection-name');
  input.value = mode === 'rename' ? (library.collections.find(c => c.id === id)?.name || '') : '';
  dialog.showModal();
  input.focus();
  input.select();
}
let saveToVideoId = null;
function ensureSaveToDialog() {
  let dialog = $('#save-to-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'save-to-dialog'; dialog.className = 'backup-dialog save-to-dialog';
  dialog.innerHTML = `<div class="dialog-heading"><h2>Save to…</h2><button class="icon-button" id="save-to-close" type="button" aria-label="Close">${icon('close')}</button></div><p class="save-to-sub">Add this video to Watch later or one of your collections.</p><div class="save-to-list" id="save-to-list"></div><form id="save-to-new" class="save-to-new"><input id="save-to-name" maxlength="80" autocomplete="off" placeholder="New collection name" aria-label="New collection name"><button class="primary" type="submit">Create</button></form><div class="dialog-actions"><button class="primary" id="save-to-done" type="button">Done</button></div>`;
  document.body.append(dialog);
  dialog.querySelector('#save-to-close').onclick = () => dialog.close();
  dialog.querySelector('#save-to-done').onclick = () => dialog.close();
  dialog.querySelector('#save-to-name').oninput = event => event.target.setCustomValidity('');
  dialog.querySelector('#save-to-list').addEventListener('click', event => {
    const watchLater = event.target.closest('[data-save-watch-later]');
    if (watchLater) { toggle('saved', saveToVideoId); renderSaveToList(); refreshLibraryView(); return; }
    const row = event.target.closest('[data-save-collection]');
    if (row) { toggleCollectionItem(row.dataset.saveCollection, saveToVideoId); renderSaveToList(); refreshLibraryView(); }
  });
  dialog.querySelector('#save-to-new').onsubmit = event => {
    event.preventDefault();
    const input = dialog.querySelector('#save-to-name');
    const name = input.value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) { input.setCustomValidity('Enter a collection name.'); input.reportValidity(); return; }
    const collection = newCollection(name);
    sortIntoCollection(collection, saveToVideoId);
    persist();
    input.value = '';
    toast(`Saved to “${name}”`);
    renderSaveToList();
    refreshLibraryView();
  };
  return dialog;
}
function renderSaveToList() {
  const list = $('#save-to-list');
  if (!list) return;
  const savedIn = library.saved.some(i => i.id === saveToVideoId);
  list.innerHTML = `<button class="save-row" data-save-watch-later aria-pressed="${savedIn}"><span class="save-row-icon">${icon('clock')}</span><span class="save-row-text">Watch later<small>${library.saved.length} ${library.saved.length === 1 ? 'video' : 'videos'}</small></span><span class="save-state ${savedIn ? 'on' : ''}" aria-hidden="true">${icon(savedIn ? 'check' : 'plus')}</span></button>${library.collections.map(c => {
    const inCollection = c.items.some(i => i.id === saveToVideoId);
    return `<button class="save-row" data-save-collection="${c.id}" aria-pressed="${inCollection}"><span class="save-row-icon">${icon('library')}</span><span class="save-row-text">${escape(c.name)}<small>${c.items.length} ${c.items.length === 1 ? 'video' : 'videos'}</small></span><span class="save-state ${inCollection ? 'on' : ''}" aria-hidden="true">${icon(inCollection ? 'check' : 'plus')}</span></button>`;
  }).join('')}${library.collections.length === 0 ? '<p class="save-to-empty">No collections yet — create one below and this video goes straight in.</p>' : ''}`;
}
function openSaveToDialog(id) {
  if (!id) return;
  saveToVideoId = id;
  const dialog = ensureSaveToDialog();
  renderSaveToList();
  dialog.showModal();
}

// Resolve the slow stream-details step while the viewer is browsing, rather
// than waiting until touch-down. Only three visible cards, one request at a time.
function prepareVisibleMetadata() {
  clearTimeout(browsePrepareTimer);
  const current = generation;
  browsePrepareTimer = setTimeout(async () => {
    if (browsePreparing || document.hidden || !allowPrefetch()) return;
    const ids = [...new Set([...main.querySelectorAll('.card .thumb a[href^="#watch="]')]
      .filter(link => { const r = link.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })
      .map(link => link.getAttribute('href').slice(7)))].slice(0, 3);
    browsePreparing = true;
    try {
      for (const id of ids) {
        if (current !== generation || document.hidden || !allowPrefetch()) break;
        try { await shortInfo(id); } catch { /* Clicking still allows a fresh retry. */ }
      }
    } finally { browsePreparing = false; }
  }, 350);
}

function qualityOptions(info) {
  return info.qualities.map((q, i) => `<option value="${i}" ${q.height === 720 || (i === 0 && !info.qualities.some(q => q.height === 720)) ? 'selected' : ''}>${q.label}</option>`).join('');
}
const speedOptions = () => [0.5, 0.75, 1, 1.25, 1.5, 2].map(n => `<option ${n === 1 ? 'selected' : ''} value="${n}">${n}×</option>`).join('');
function bindInfoActions(id) {
  $('#save').onclick = () => {
    const selected = toggle('saved', id);
    const button = $('#save');
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', selected ? 'Remove from Watch later' : 'Save to Watch later');
  };
  $('#like').onclick = () => {
    const selected = toggle('liked', id);
    const button = $('#like');
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  };
  const saveToButton = $('#save-to');
  if (saveToButton) saveToButton.onclick = () => openSaveToDialog(id);
  $('#share').onclick = async () => {
    try { await navigator.clipboard.writeText(`https://www.youtube.com/watch?v=${id}`); toast('YouTube link copied'); } catch { toast('Copy the video link from your address bar.'); }
  };
}

// Warm one likely next video, then adopt the same media elements on navigation.
// Reusing elements retains their buffered bytes instead of downloading them twice.
let warmWatch = null, warmIntentTimer;
function discardWarmWatch() {
  if (!warmWatch) return;
  clearTimeout(warmWatch.expiry);
  warmWatch.controller.abort();
  for (const media of [warmWatch.video, warmWatch.audio]) {
    media.removeAttribute('src'); media.load();
  }
  warmWatch = null;
}
// Only drop the warmed entry if the next route is for a different video, the
// entry expired, or loading failed. A healthy playback sequence must keep it.
function maybeKeepWarmWatch(nextId) {
  if (warmWatch && warmWatch.id !== nextId) discardWarmWatch();
}
// Warm the upcoming queue/related video into a detached, real media pair.
// With `force` (Play pressed), warm before any buffer exists; without it,
// wait until this video reaches a healthy buffer. The queue head is an
// explicit watch choice, so it warms even with autoplay off; related
// entries only warm when autoplay will actually advance to them. A warm
// entry for a stale target is displaced by the current queue head.
function warmNextWatch(currentId, force = false) {
  if (isMetered()) return;
  const queued = library.queue[0]?.id;
  if (!queued && !preferences.autoplay) return;
  if (!force && !allowPrefetch()) return;
  const nextId = queued || $('#related a[href^="#watch="]')?.getAttribute('href')?.slice(7);
  if (nextId && nextId !== currentId) prepareWatch(nextId, force);
}
function prepareWatch(id, force = false) {
  // `force` warms on an explicit Play press, before any buffer exists.
  // Metered connections are never prefetched, even then.
  if (force ? isMetered() : !allowPrefetch()) return;
  if (warmWatch?.id === id || location.hash === `#watch=${id}`) return;
  maybeKeepWarmWatch(id);
  const entry = { id, controller: new AbortController(), video: document.createElement('video'), audio: document.createElement('audio'), ready: false };
  warmWatch = entry;
  entry.video.preload = entry.audio.preload = 'auto';
  entry.video.addEventListener('canplaythrough', () => { entry.ready = true; }, { once: true });
  entry.video.playsInline = true;
  entry.promise = shortInfo(id).then(info => {
    if (entry.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const quality = info.qualities[startQuality(info)];
    entry.video.src = quality.src;
    const track = preferredAudio(info);
    if (quality.separateAudio && (track?.src || info.audio)) entry.audio.src = track?.src || info.audio;
    return info;
  });
  entry.promise.catch(() => { if (warmWatch === entry) discardWarmWatch(); });
  entry.expiry = setTimeout(() => { if (warmWatch === entry) discardWarmWatch(); }, 180000);
}
for (const event of ['pointerover', 'focusin', 'pointerdown']) {
  main.addEventListener(event, e => {
    const link = e.target.closest('a[href^="#watch="]');
    if (!link) return;
    clearTimeout(warmIntentTimer);
    const id = link.getAttribute('href').slice(7);
    if (!/^[\w-]{11}$/.test(id)) return;
    if (event === 'pointerdown') prepareWatch(id);
    else warmIntentTimer = setTimeout(() => prepareWatch(id), 180);
  });
}
main.addEventListener('pointerout', e => {
  const link = e.target.closest('a[href^="#watch="]');
  if (link && !link.contains(e.relatedTarget)) clearTimeout(warmIntentTimer);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(warmIntentTimer); discardWarmWatch(); }
});

function startQuality(info) {
  const target = Number(preferences.qualityHeight) || (navigator.connection?.saveData ? 360 : 480);
  const candidates = info.qualities.map((q, i) => ({ ...q, i })).sort((a, b) => b.height - a.height);
  return (candidates.find(q => q.height <= target) || candidates.at(-1)).i;
}
function renderQueue() {
  const panel = $('#watch-queue');
  if (!panel) return;
  panel.innerHTML = `<div class="queue-heading"><h2>Up next (${library.queue.length})</h2><button data-queue-clear ${library.queue.length ? '' : 'disabled'}>Clear</button></div><label class="autoplay-label"><input id="queue-autoplay" type="checkbox" ${preferences.autoplay ? 'checked' : ''}> Autoplay queue / related video</label><ol>${library.queue.map((v, i) => `<li><a href="#watch=${v.id}">${escape(v.title)}</a><button data-queue-up="${i}" aria-label="Move ${escape(v.title)} up" ${i ? '' : 'disabled'}>↑</button><button data-queue-remove="${i}" aria-label="Remove ${escape(v.title)}">×</button></li>`).join('')}</ol>${library.queue.length ? '' : '<p class="muted">Use “Play next” or “+ Queue” on a video.</p>'}`;
  $('#queue-autoplay').onchange = e => { preferences.autoplay = e.target.checked; savePreferences(); };
}
document.addEventListener('click', event => {
  const next = event.target.closest('[data-queue-next]'), add = event.target.closest('[data-queue-add]');
  if (next || add) {
    const id = next?.dataset.queueNext || add.dataset.queueAdd, item = videos.get(id);
    if (item) {
      library.queue = library.queue.filter(v => v.id !== id);
      if (next) library.queue.unshift(compact(item)); else library.queue.push(compact(item));
      library.queue = library.queue.slice(0, 100);
      toast(next ? 'Added to play next' : 'Added to queue');
    }
  } else if (event.target.closest('[data-queue-clear]')) library.queue = [];
  else if (event.target.closest('[data-queue-remove]')) library.queue.splice(Number(event.target.closest('[data-queue-remove]').dataset.queueRemove), 1);
  else if (event.target.closest('[data-queue-up]')) {
    const i = Number(event.target.closest('[data-queue-up]').dataset.queueUp);
    if (i > 0 && i < library.queue.length) [library.queue[i - 1], library.queue[i]] = [library.queue[i], library.queue[i - 1]];
  } else return;
  persist(); renderQueue();
});

async function loadShareDialog() {
  const summary = $('#share-summary');
  const link = $('#share-invite');
  const publicLink = $('#share-public');
  const code = $('#share-code');
  const lan = $('#share-lan');
  if (!summary) return;
  summary.textContent = 'Checking connection…';
  try {
    const data = await api('/api/network');
    const publicUrl = data.publicUrl;
    const invite = data.inviteUrl || '';
    link.value = invite;
    publicLink.value = publicUrl || '';
    publicLink.placeholder = publicUrl ? '' : 'Public link is offline';
    code.value = data.accessCode ? `${data.accessCode.slice(0, 5)}-${data.accessCode.slice(5)}` : 'No code needed';
    code.dataset.raw = data.accessCode || '';
    lan.innerHTML = data.lan.length ? data.lan.map(url => `<code>${escape(url)}</code>`).join('<br>') : 'No Wi-Fi address detected.';
    summary.className = `share-summary ${publicUrl ? 'online' : 'offline'}`;
    summary.innerHTML = publicUrl
      ? `<strong>Public access is on.</strong> ${data.publicStable ? 'The address is stable while the server runs.' : 'This quick address can change after a restart; use the stable option for a permanent address.'}`
      : '<strong>Public access is off.</strong> On the computer, run <code>Start Dinosour (Public).cmd</code> or <code>npm run share</code>. Then press Refresh.';
    $('#share-open').hidden = !publicUrl;
    $('#share-open').href = publicUrl || '#';
    $('#share-copy-invite').disabled = !invite;
    $('#share-copy-code').disabled = !data.accessCode;
    $('#share-code').closest('.share-row').hidden = !data.accessCode;
  } catch (error) {
    summary.className = 'share-summary offline';
    summary.textContent = error.message;
  }
}
function openShareDialog() {
  if (window.__dinosourStandalone) {
    let dialog = $('#share-native-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'share-native-dialog';
      dialog.className = 'share-dialog';
      const link = 'https://github.com/lexerprivate-sudo/dinosour-web/releases/latest/download/DinosourWeb.apk';
      dialog.innerHTML = `<div class="dialog-heading"><h2>Share Dinosour</h2><button type="button" data-close aria-label="Close">×</button></div><p>Send the Android app to a friend. It works directly on Wi-Fi or mobile data, with no computer or access code.</p><div class="share-input"><input readonly aria-label="App download link" value="${link}"><button type="button" data-copy>Copy</button></div>`;
      document.body.append(dialog);
      dialog.querySelector('[data-close]').onclick = () => dialog.close();
      dialog.querySelector('[data-copy]').onclick = async () => {
        try { await navigator.clipboard.writeText(link); toast('App link copied'); }
        catch { dialog.querySelector('input').select(); toast('Select and copy the app link.'); }
      };
    }
    dialog.showModal();
    return;
  }
  let dialog = $('#share-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'share-dialog'; dialog.className = 'share-dialog';
    dialog.innerHTML = `<div class="dialog-heading"><h2>Share Dinosour</h2><button type="button" data-close-share aria-label="Close">×</button></div><p class="share-intro">Your friend can use this server from another country. Keep the computer and server running while they watch.</p><div id="share-summary" class="share-summary" role="status"></div><div class="share-row"><label for="share-invite">Invite link</label><div class="share-input"><input id="share-invite" readonly><button id="share-copy-invite" type="button">Copy</button></div></div><div class="share-row"><label for="share-public">Public address</label><div class="share-input"><input id="share-public" readonly><a id="share-open" class="share-open" target="_blank" rel="noopener" hidden>Open</a></div></div><div class="share-row"><label for="share-code">Access code</label><div class="share-input"><input id="share-code" readonly><button id="share-copy-code" type="button">Copy</button></div></div><div class="share-row"><label>Same Wi-Fi</label><div id="share-lan" class="share-lan"></div></div><div class="share-buttons"><button type="button" data-refresh-share>Refresh</button><button type="button" data-close-share>Done</button></div><p class="share-help">The access code protects your computer from strangers. Share the invite link only with people you trust. For a permanent address, use <code>Start Dinosour (Stable Public).cmd</code> with Tailscale Funnel.</p>`;
    document.body.append(dialog);
    dialog.querySelectorAll('[data-close-share]').forEach(button => button.onclick = () => dialog.close());
    dialog.querySelector('[data-refresh-share]').onclick = loadShareDialog;
    dialog.querySelector('#share-copy-invite').onclick = async () => {
      try { await navigator.clipboard.writeText($('#share-invite').value); toast('Invite link copied'); }
      catch { $('#share-invite').select(); toast('Select and copy the invite link.'); }
    };
    dialog.querySelector('#share-copy-code').onclick = async () => {
      try { await navigator.clipboard.writeText($('#share-code').dataset.raw || $('#share-code').value); toast('Access code copied'); }
      catch { $('#share-code').select(); toast('Select and copy the access code.'); }
    };
  }
  dialog.showModal();
  loadShareDialog();
}
$('#share-app').onclick = openShareDialog;

const backupPreferenceKeys = ['theme', 'collapsed', 'volume', 'muted', 'qualityHeight', 'autoplay', 'audioLanguage', 'captions', 'topics', 'searchSort', 'searchDuration', 'recentSearches'];
function backupPayload() {
  const chosen = {};
  for (const field of backupPreferenceKeys) if (preferences[field] !== undefined) chosen[field] = preferences[field];
  // Downloads are device-local media; they cannot travel inside a JSON backup.
  const { downloads: _downloads, ...portableLibrary } = library;
  return { app: 'dinosour', version: 1, exportedAt: new Date().toISOString(), library: portableLibrary, preferences: chosen };
}
function cleanLibraryItem(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[\w-]{11}$/.test(item.id)) return null;
  const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const number = (value, max) => {
    if (value === null || value === '' || value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(0, parsed)) : undefined;
  };
  const clean = { id: item.id };
  clean.title = text(item.title, 300) || 'YouTube video';
  clean.channel = text(item.channel, 120) || 'YouTube';
  const thumb = text(item.thumb, 500);
  clean.thumb = thumb && (/^\/(?!\/)/.test(thumb) || /^https:\/\//i.test(thumb)) ? thumb : `/api/thumb/${item.id}`;
  const viewsText = text(item.viewsText, 80);
  if (viewsText) clean.viewsText = viewsText;
  for (const [field, max] of [['views', Number.MAX_SAFE_INTEGER], ['duration', 864000], ['position', 864000], ['watchedAt', Number.MAX_SAFE_INTEGER]]) {
    const value = number(item[field], max);
    if (value !== undefined) clean[field] = value;
  }
  if (item.continueHidden) clean.continueHidden = true;
  if (item.type === 'short') clean.type = 'short';
  return clean;
}
function cleanCollection(source) {
  if (!source || typeof source !== 'object') return null;
  const name = typeof source.name === 'string' ? source.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  if (!name) return null;
  const id = typeof source.id === 'string' && /^c[a-z0-9]{8,40}$/i.test(source.id)
    ? source.id
    : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 40);
  const createdAt = Number.isFinite(source.createdAt) && source.createdAt > 0 ? source.createdAt : Date.now();
  const seen = new Set();
  const items = (Array.isArray(source.items) ? source.items : [])
    .map(cleanLibraryItem)
    .filter(item => item && !seen.has(item.id) && seen.add(item.id))
    .slice(0, 500);
  return { id, name, createdAt, items };
}
function sanitizeLibrary(source) {
  const clean = {};
  for (const field of ['saved', 'history', 'liked', 'queue']) {
    const list = Array.isArray(source?.[field]) ? source[field] : [];
    const seen = new Set();
    const limit = field === 'queue' ? 100 : field === 'history' ? 200 : 500;
    clean[field] = list.map(cleanLibraryItem).filter(item => item && !seen.has(item.id) && seen.add(item.id)).slice(0, limit);
  }
  const collections = Array.isArray(source?.collections) ? source.collections : [];
  const seenCollections = new Set();
  clean.collections = collections.map(cleanCollection)
    .filter(collection => collection && !seenCollections.has(collection.id) && seenCollections.add(collection.id))
    .slice(0, 50);
  const downloads = Array.isArray(source?.downloads) ? source.downloads : [];
  const seenDownloads = new Set();
  clean.downloads = downloads.map(cleanDownload)
    .filter(item => item && !seenDownloads.has(item.id) && seenDownloads.add(item.id))
    .slice(0, 500);
  return clean;
}
function sanitizeBackup(data) {
  if (!data || data.app !== 'dinosour' || !data.library || typeof data.library !== 'object') throw new Error('This is not a Dinosour backup file.');
  const clean = sanitizeLibrary(data.library);
  const input = data.preferences && typeof data.preferences === 'object' ? data.preferences : {};
  const prefs = {};
  for (const field of backupPreferenceKeys) if (input[field] !== undefined) prefs[field] = input[field];
  prefs.topics = Array.isArray(input.topics) ? [...new Set(input.topics.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 80)).filter(Boolean))].slice(0, 100) : [];
  prefs.recentSearches = Array.isArray(input.recentSearches) ? [...new Set(input.recentSearches.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 120)).filter(Boolean))].slice(0, 8) : [];
  return { library: clean, preferences: prefs };
}
function mergeLibrary(current, incoming) {
  const merged = {};
  for (const field of ['saved', 'liked', 'queue']) {
    const seen = new Set();
    merged[field] = [...incoming[field], ...current[field]].filter(item => item && !seen.has(item.id) && seen.add(item.id)).slice(0, field === 'queue' ? 100 : 500);
  }
  const history = new Map();
  for (const item of [...current.history, ...incoming.history]) {
    const previous = history.get(item.id);
    if (!previous || (item.watchedAt || 0) > (previous.watchedAt || 0)) history.set(item.id, item);
  }
  merged.history = [...history.values()].sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)).slice(0, 200);
  const collections = new Map();
  for (const collection of [...(current.collections || []), ...(incoming.collections || [])]) {
    const existing = collections.get(collection.id);
    if (!existing) { collections.set(collection.id, { ...collection, items: [...collection.items] }); continue; }
    const mergedItems = new Map();
    for (const item of [...collection.items, ...existing.items]) {
      if (!mergedItems.has(item.id)) mergedItems.set(item.id, item);
    }
    collections.set(collection.id, { ...existing, name: existing.name || collection.name, items: [...mergedItems.values()].slice(0, 500) });
  }
  merged.collections = [...collections.values()].slice(0, 50);
  merged.downloads = Array.isArray(current.downloads) ? current.downloads : [];
  return merged;
}
function applyBackup(data, replace) {
  const clean = sanitizeBackup(data);
  const safe = replace ? { ...clean.library, downloads: Array.isArray(library.downloads) ? library.downloads : [] } : null;
  library = replace ? safe : mergeLibrary(library, clean.library);
  replacePreferences(replace ? { ...preferences, ...clean.preferences } : {
    ...preferences,
    ...clean.preferences,
    topics: [...new Set([...(preferences.topics || []), ...(clean.preferences.topics || [])])],
    recentSearches: [...new Set([...(clean.preferences.recentSearches || []), ...(preferences.recentSearches || [])])].slice(0, 8),
  });
  preferences.topics = [...new Set((preferences.topics || []).filter(t => typeof t === 'string'))];
  preferences.recentSearches = (preferences.recentSearches || []).slice(0, 8);
  persist(); savePreferences(); setTheme(preferences.theme === 'light' || (!preferences.theme && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'); renderTopicNavigation();
  const hash = location.hash.slice(1) || 'home';
  if (hash === 'history') collection('history');
  else if (hash === 'library' || hash === 'saved' || hash === 'liked' || hash.startsWith('collection=')) refreshLibraryView();
  else if (hash === 'home') route();
  toast(replace ? 'Backup restored' : 'Backup merged');
}
function openBackupDialog() {
  let dialog = $('#backup-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'backup-dialog'; dialog.className = 'backup-dialog';
    dialog.innerHTML = `<div class="dialog-heading"><h2>Backup &amp; restore</h2><button type="button" data-close-backup aria-label="Close">×</button></div><p class="backup-intro">Save your topics, Watch later, liked videos, collections, history, queue and playback settings as one file. Restore it here or on another device.</p><div class="backup-actions"><button class="primary" type="button" data-export-backup>Download backup</button><button type="button" data-import-backup>Restore from file</button><input id="backup-file" type="file" accept="application/json,.json" hidden></div><div id="backup-summary" class="backup-summary" role="status"></div>`;
    document.body.append(dialog);
    dialog.querySelector('[data-close-backup]').onclick = () => dialog.close();
    dialog.querySelector('[data-export-backup]').onclick = () => {
      if (window.DinosourAndroid?.exportBackup) {
        window.DinosourAndroid.exportBackup(JSON.stringify(backupPayload(), null, 2));
        dialog.querySelector('#backup-summary').textContent = 'Choose where to save your backup.';
        return;
      }
      const blob = new Blob([JSON.stringify(backupPayload(), null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `dinosour-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      dialog.querySelector('#backup-summary').textContent = `Backup downloaded: ${library.saved.length} saved, ${library.history.length} history items.`;
    };
    const file = dialog.querySelector('#backup-file');
    dialog.querySelector('[data-import-backup]').onclick = () => file.click();
    file.onchange = async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      const summary = dialog.querySelector('#backup-summary');
      try {
        const data = JSON.parse(await selected.text());
        const clean = sanitizeBackup(data);
        window.__pendingBackup = data;
        summary.innerHTML = `<p><strong>${escape(selected.name)}</strong> contains ${clean.library.saved.length} saved, ${clean.library.history.length} history, ${clean.library.liked.length} liked, ${clean.library.collections.length} ${clean.library.collections.length === 1 ? 'collection' : 'collections'} and ${clean.library.queue.length} queued videos.</p><div class="backup-choice"><button type="button" data-backup-merge>Merge with this device</button><button type="button" class="primary" data-backup-replace>Replace everything</button></div>`;
        summary.querySelector('[data-backup-merge]').onclick = () => applyBackup(data, false);
        summary.querySelector('[data-backup-replace]').onclick = () => applyBackup(data, true);
      } catch (error) {
        summary.innerHTML = `<p class="error-text">${escape(error.message)}</p>`;
      } finally { file.value = ''; }
    };
  }
  dialog.querySelector('#backup-summary').textContent = '';
  dialog.showModal();
}
document.addEventListener('click', event => {
  if (event.target.closest('[data-backup]')) openBackupDialog();
});

// Keep the actual player mounted while browsing, so both its buffer and audio
// survive navigation. Native PiP is optional; the in-app mini-player works in WebView.
function enableMiniPlayer(id) {
  if (miniSession) return;
  const layout = $('.watch-layout');
  if (!layout) return;
  const host = document.createElement('section');
  host.id = 'mini-player'; host.className = 'watch-page'; host.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'mini-toolbar';
  bar.innerHTML = `<a href="#watch=${id}">Return to video</a><button aria-label="Close mini-player">×</button>`;
  host.append(bar); document.body.append(host);
  miniSession = { id, host, layout, cleanup, controller: routeController, detached: false };
  bar.querySelector('button').onclick = () => {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    if (miniSession?.detached) miniSession.cleanup();
    host.remove(); miniSession = null;
  };
}
function movePlayer(layout, target) {
  const video = layout.querySelector('video'), resume = video && !video.paused;
  if (target.moveBefore) target.moveBefore(layout, null);
  else {
    target.append(layout);
    // Older WebViews pause media when reparenting it. Resume after that task.
    if (resume) setTimeout(() => {
      if (video.isConnected) video.play().catch(() => {});
    }, 0);
  }
}

let routeController;
async function route(refresh = false) {
  closeSuggestions();
  const destination = location.hash.slice(1) || 'home';
  if (miniSession) {
    if (destination === `watch=${miniSession.id}` && refresh !== true && miniSession.detached) {
      generation++; routeController?.abort(); cleanup();
      main.className = 'watch-page'; main.replaceChildren(); movePlayer(miniSession.layout, main);
      cleanup = miniSession.cleanup; routeController = miniSession.controller;
      miniSession.detached = false; miniSession.host.hidden = true;
      document.title = `${$('#watch-info h1')?.textContent || 'Video'} — Dinosour`;
      document.querySelectorAll('[data-nav]').forEach(a => { a.classList.remove('active'); a.removeAttribute('aria-current'); });
      $('#search').value = ''; updateSearch();
      closeNavigation(); window.scrollTo(0, 0); return;
    }
    if (destination.startsWith('watch=') || destination.startsWith('short=')) {
      if (miniSession.detached) miniSession.cleanup();
      miniSession.host.remove(); miniSession = null;
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    } else if (!miniSession.detached) {
      miniSession.host.hidden = false; movePlayer(miniSession.layout, miniSession.host);
      miniSession.detached = true; cleanup = () => {}; routeController = null;
    }
  }
  generation++;
  const current = generation;
  routeController?.abort(); cleanup(); cleanup = () => {};
  routeController = new AbortController();
  window.scrollTo(0, 0);
  // Keyboard/screen-reader users land on the main landmark after navigation.
  // preventScroll because the route may re-attach the mini player without a scroll.
  try { main.focus({ preventScroll: true }); } catch {}
  document.title = 'Dinosour';
  closeNavigation();
  const hash = location.hash.slice(1) || 'home';
  const value = decodeValue(hash);
  clearTimeout(warmIntentTimer);
  clearTimeout(browsePrepareTimer);
  if (!hash.startsWith('watch=')) discardWarmWatch();
  document.querySelectorAll('[data-nav]').forEach(a => {
    let active = a.dataset.nav === hash || a.dataset.nav === value;
    if (a.dataset.nav === 'library') active = hash === 'library' || hash.startsWith('collection=');
    if (a.dataset.nav === 'shorts') active = hash === 'shorts' || hash.startsWith('shorts=') || hash.startsWith('short=');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#search').value = hash.startsWith('search=') || hash.startsWith('shorts=') ? value : '';
  updateSearch();
  if (hash.startsWith('watch=') && /^[\w-]{11}$/.test(value)) {
    const { watch } = await import('./watch.js');
    await watch(value, current, routeController, refresh === true);
  }
  else if (hash.startsWith('short=') && /^[\w-]{11}$/.test(value)) {
    const { reel } = await import('./reel.js');
    await reel(value, current, routeController);
  }
  else if (hash === 'shorts' || hash.startsWith('shorts=')) await feed(hash.startsWith('shorts=') ? value : '', current, routeController, 'shorts');
  else if (hash === 'library') libraryPage();
  else if (hash.startsWith('collection=')) collectionDetail(value || '');
  else if (hash === 'saved' || hash === 'liked') {
    libraryPage();
    const target = hash === 'saved' ? 'watch-later' : 'liked-videos';
    requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }));
  }
  else if (hash === 'history') collection('history');
  else await feed(hash.startsWith('search=') ? value : '', current, routeController);
}
function getVideoId(text) {
  if (/^[\w-]{11}$/.test(text)) return text;
  try {
    const u = new URL(text);
    let id;
    if (u.hostname === 'youtu.be') id = u.pathname.slice(1);
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(u.hostname)) id = u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}
const suggestionBox = $('#search-suggestions');
let suggestTimer, suggestController, suggestionIndex = -1;
function closeSuggestions() {
  if (!suggestionBox) return;
  suggestionBox.hidden = true; suggestionBox.innerHTML = ''; suggestionIndex = -1;
  $('#search').setAttribute('aria-expanded', 'false');
}
function renderSuggestions(items, recent = false) {
  suggestionIndex = -1;
  if (!items.length) return closeSuggestions();
  suggestionBox.innerHTML = items.map((value, index) => `<button type="button" class="search-suggestion" role="option" data-suggestion="${escape(value)}" data-index="${index}">${icon(recent ? 'history' : 'search')}<span class="suggest-label">${escape(value)}</span><span class="suggest-kind">${recent ? 'Recent' : ''}</span></button>`).join('') +
    (recent ? '<button type="button" class="suggest-clear" data-clear-recent>Clear recent searches</button>' : '');
  suggestionBox.hidden = false;
  $('#search').setAttribute('aria-expanded', 'true');
}
function loadSuggestions() {
  const value = $('#search').value.trim();
  clearTimeout(suggestTimer); suggestController?.abort();
  if (!value) { renderSuggestions(preferences.recentSearches, true); return; }
  suggestController = new AbortController();
  suggestTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/suggest?q=${encodeURIComponent(value)}`, suggestController.signal);
      if ($('#search').value.trim() === value && document.activeElement === $('#search')) renderSuggestions(data.suggestions || []);
    } catch (error) { if (error.name !== 'AbortError') closeSuggestions(); }
  }, 180);
}
function chooseSuggestion(value) {
  $('#search').value = value; updateSearch(); closeSuggestions();
  $('#search-form').requestSubmit();
}
$('#search').addEventListener('focus', loadSuggestions);
$('#search').addEventListener('input', loadSuggestions);
$('#search').addEventListener('keydown', event => {
  if (suggestionBox.hidden) return;
  const buttons = [...suggestionBox.querySelectorAll('[data-suggestion]')];
  if (!buttons.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    suggestionIndex = (suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons.forEach((button, index) => { button.classList.toggle('active', index === suggestionIndex); button.setAttribute('aria-selected', String(index === suggestionIndex)); });
    buttons[suggestionIndex].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && suggestionIndex >= 0) {
    event.preventDefault(); chooseSuggestion(buttons[suggestionIndex].dataset.suggestion);
  } else if (event.key === 'Escape') { closeSuggestions(); $('#search').blur(); }
});
suggestionBox.addEventListener('pointerdown', event => event.preventDefault());
suggestionBox.addEventListener('click', event => {
  if (event.target.closest('[data-clear-recent]')) {
    preferences.recentSearches = []; savePreferences(); closeSuggestions(); return;
  }
  const item = event.target.closest('[data-suggestion]');
  if (item) chooseSuggestion(item.dataset.suggestion);
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.search-wrap')) closeSuggestions();
});
$('#search-form').onsubmit = event => {
  event.preventDefault(); const q = $('#search').value.trim(); if (!q) return;
  closeSuggestions();
  // Starting a fresh search resets filters — persisted ones are fine within a
  // single search session, but a different query should not silently return 0.
  preferences.searchDuration = 'any';
  preferences.searchSort = 'relevance';
  const id = getVideoId(q);
  if (!id) {
    preferences.recentSearches = [q, ...preferences.recentSearches.filter(value => value.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  }
  savePreferences();
  const next = id
    ? (/\/shorts\//.test(q) ? `#short=${id}` : `#watch=${id}`)
    : inShortsContext() ? `#shorts=${encodeURIComponent(q)}` : `#search=${encodeURIComponent(q)}`;
  if (location.hash === next) route(); else location.hash = next;
  $('#search').blur();
};
document.addEventListener('click', event => {
  if (event.target.closest('[data-add-topic]')) openTopicDialog();
  const removeTopic = event.target.closest('[data-remove-topic]');
  if (removeTopic) {
    const topic = removeTopic.dataset.removeTopic;
    preferences.topics = preferences.topics.filter(t => t !== topic);
    savePreferences(); renderTopicNavigation();
    if (location.hash === `#search=${encodeURIComponent(topic)}`) location.hash = '#home';
    else if (location.hash === `#shorts=${encodeURIComponent(topic)}`) location.hash = '#shorts';
    else if ($('.chips')) { const state = chipsState(); $('.chips').outerHTML = chips(state.selected, state.scope); }
    toast('Topic removed');
  }
  const restart = event.target.closest('[data-restart]');
  if (restart) {
    event.preventDefault();
    const id = restart.dataset.restart;
    sessionStorage.setItem(`dinosour.restart.${id}`, '1');
    const href = `#watch=${id}`;
    if (location.hash === href) route(true); else location.hash = href;
  }
  const removeContinue = event.target.closest('[data-continue-remove]');
  if (removeContinue) {
    const item = library.history.find(v => v.id === removeContinue.dataset.continueRemove);
    if (item) { item.continueHidden = true; persist(); }
    removeContinue.closest('.continue-card')?.remove();
    if (!$('.continue-card')) $('.continue-section')?.remove();
  }
  if (event.target.closest('[data-clear-continue]')) {
    for (const item of library.history) item.continueHidden = true;
    persist(); $('.continue-section')?.remove();
    toast('Continue watching cleared');
  }
  const save = event.target.closest('[data-save]');
  if (save) {
    event.preventDefault();
    const selected = toggle('saved', save.dataset.save);
    save.classList.toggle('selected', selected); save.innerHTML = icon(selected ? 'check' : 'clock');
    save.setAttribute('aria-pressed', String(selected));
    save.setAttribute('aria-label', `${selected ? 'Remove from' : 'Save to'} Watch later`);
    save.title = selected ? 'Saved to Watch later' : 'Watch later';
    if (location.hash === '#library' || location.hash === '#saved' || location.hash === '#liked' || location.hash.startsWith('#collection=')) refreshLibraryView();
  }
  const saveTo = event.target.closest('[data-save-to]');
  if (saveTo) { event.preventDefault(); openSaveToDialog(saveTo.dataset.saveTo); return; }
  const downloadToggle = event.target.closest('[data-download-toggle]');
  if (downloadToggle) { event.preventDefault(); openDownloadDialog(downloadToggle.dataset.downloadToggle, downloadsWatchInfo); return; }
  const deleteDownloadButton = event.target.closest('[data-delete-download]');
  if (deleteDownloadButton) {
    event.preventDefault();
    const id = deleteDownloadButton.dataset.deleteDownload;
    LocalDownloads.delete(id).catch(() => {}).finally(() => {
      library.downloads = (library.downloads || []).filter(d => d.id !== id);
      persist();
      toast('Download deleted');
      refreshLibraryView();
      paintDownloadControls(id);
    });
    return;
  }
  const newCollectionButton = event.target.closest('[data-new-collection]');
  if (newCollectionButton) { event.preventDefault(); openCollectionDialog('create'); return; }
  const renameCollectionButton = event.target.closest('[data-rename-collection]');
  if (renameCollectionButton) { openCollectionDialog('rename', renameCollectionButton.dataset.renameCollection); return; }
  const deleteCollectionButton = event.target.closest('[data-delete-collection]');
  if (deleteCollectionButton) {
    if (deleteCollectionButton.dataset.armed === '1') {
      const id = deleteCollectionButton.dataset.deleteCollection;
      library.collections = library.collections.filter(c => c.id !== id);
      persist();
      toast('Collection deleted');
      if (location.hash.startsWith('#collection=')) location.hash = '#library';
      else refreshLibraryView();
    } else {
      deleteCollectionButton.dataset.armed = '1';
      deleteCollectionButton.classList.add('armed');
      deleteCollectionButton.dataset.label = deleteCollectionButton.getAttribute('aria-label') || 'Delete';
      deleteCollectionButton.setAttribute('aria-label', 'Confirm delete');
      deleteCollectionButton.title = 'Click again to delete';
      setTimeout(() => {
        if (!document.body.contains(deleteCollectionButton)) return;
        delete deleteCollectionButton.dataset.armed;
        deleteCollectionButton.classList.remove('armed');
        deleteCollectionButton.setAttribute('aria-label', deleteCollectionButton.dataset.label || 'Delete');
        deleteCollectionButton.title = '';
      }, 4000);
    }
    return;
  }
  const playAllButton = event.target.closest('[data-play-all]');
  if (playAllButton) { event.preventDefault(); playCollection(playAllButton.dataset.playAll); return; }
  const removeFromCollectionButton = event.target.closest('[data-uncollect]');
  if (removeFromCollectionButton && currentCollectionId) {
    const target = library.collections.find(c => c.id === currentCollectionId);
    if (target) {
      target.items = target.items.filter(item => item.id !== removeFromCollectionButton.dataset.uncollect);
      persist();
      toast(`Removed from ${target.name}`);
      refreshLibraryView();
    }
    return;
  }
  const clearFieldButton = event.target.closest('[data-clear-field]');
  if (clearFieldButton) {
    const field = clearFieldButton.dataset.clearField;
    if (field === 'saved' || field === 'liked') {
      library[field] = [];
      persist();
      refreshLibraryView();
      toast(field === 'saved' ? 'Watch later cleared' : 'Liked videos cleared');
    }
    return;
  }
  if (event.target.closest('[data-retry]')) {
    const id = location.hash.match(/^#(?:watch|short)=([\w-]{11})/)?.[1];
    if (id) autoRetryCount.delete(id);
    route(true);
  }
});
document.addEventListener('fullscreenchange', () => {
  const button = $('#fullscreen-toggle');
  if (!button) return;
  button.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  button.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen');
});
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') { closeNavigation(); $('#search').blur(); }
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
  if (event.key === '/') { event.preventDefault(); $('#search').focus(); return; }
  if ($('#reel')) {
    if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); $('#reel-next')?.click(); return; }
    if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); $('#reel-prev')?.click(); return; }
  }
  const video = $('#video');
  if (!video || !video.src) return;
  if (event.code === 'Space' || event.key === 'k') {
    event.preventDefault();
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }
  if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (event.key === 'ArrowLeft' ? -5 : 5))); }
  if (event.key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else ($('#reel') || video).requestFullscreen?.().catch(() => {});
  }
});
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { cleanup(); if (miniSession?.detached) miniSession.cleanup(); });
route();
if (!window.__dinosourStandalone && 'serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
if (window.DinosourAndroid?.openSettings) {
  const androidSettings = $('#android-settings');
  androidSettings.hidden = false;
  androidSettings.onclick = () => window.DinosourAndroid.openSettings();
  if (window.__dinosourStandalone) {
    $('#share-app').title = 'Share Dinosour';
    $('#share-app').setAttribute('aria-label', 'Share Dinosour');
  }
}
// Signal readiness after initialization, without waiting for live feed requests.
window.__dinosourReady = true;
window.DinosourAndroid?.appReady?.();
// Track media playback state for the OS media notification and keep the
// Android background-audio service in sync. "Active media" is the visible
// player pair: on the watch page the video id is #video and the separate
// audio element is #audio; on the Shorts reel both share those ids with the
// active pair only. Preloaded (idle) pairs carry no ids, so they never
// trigger this. While the app is hidden, the video track is paused but the
// audio keeps playing — the foreground service must stay up for that case.
const activeMediaPlaying = () => {
  for (const sel of ['#video', '#audio']) {
    const m = document.querySelector(sel);
    if (m && !m.paused && !m.ended) return true;
  }
  return false;
};
const syncMediaState = () => {
  const playing = activeMediaPlaying();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  window.DinosourAndroid?.backgroundAudio?.(playing, playing ? document.title.replace(/ — Dinosour$/, '') : '');
};
document.addEventListener('playing', event => { if (['VIDEO', 'AUDIO'].includes(event.target.tagName)) syncMediaState(); }, true);
document.addEventListener('pause', event => { if (['VIDEO', 'AUDIO'].includes(event.target.tagName)) syncMediaState(); }, true);

// Public surface for the lazily imported reel chunk (public/reel.js). The
// reel re-uses these bindings live; it cannot assign to them, so it calls
// the two helpers below to install its per-route cleanup and reset the
// shared playback gate.
export { library, videos, remember, compact, toggle, persist, generation };
export function setRouteCleanup(fn) { cleanup = fn; }
export function releasePlaybackState() { playbackBusy = false; playbackBufferAhead = Infinity; }
// Public surface for the lazily imported watch chunk (public/watch.js). The
// watch rides on the same pattern: it re-uses the bindings below live;
// assignments go through the setter helpers, and its per-route cleanup is
// installed with setRouteCleanup above.
export { card, skeleton, synthesizeOfflineInfo, qualityOptions, speedOptions, bindInfoActions, paintDownloadControls, startQuality, renderQueue, enableMiniPlayer, discardWarmWatch, warmNextWatch, autoRetryCount, warmIntentTimer, warmWatch, activeObjectUrls, playbackBufferAhead };
export function setPlaybackBusy(value) { playbackBusy = value; }
export function setPlaybackBufferAhead(value) { playbackBufferAhead = value; }
export function setDownloadsWatchInfo(value) { downloadsWatchInfo = value; }
export function setActiveObjectUrls(value) { activeObjectUrls = value; }
export function claimWarmWatch() { const warmed = warmWatch; warmWatch = null; return warmed; }
