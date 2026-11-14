const $ = (selector) => document.querySelector(selector);
const main = $('#main');
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const key = 'dinosour.library.v1';
let library;
try { library = JSON.parse(localStorage.getItem(key)); } catch { library = null; }
if (!library || typeof library !== 'object' || Array.isArray(library)) library = {};
library = sanitizeLibrary(library);
const videos = new Map();
const infoCache = new Map();
const infoCacheTimes = new Map();
let browsePrepareTimer, browsePreparing = false;
const autoRetryCount = new Map();
let generation = 0, cleanup = () => {}, toastTimer, lastShortsQuery = '';
let shortsFeed = [], shortsFeedCursor = '';
let preferences = {};
let playbackBusy = false, playbackBufferAhead = Infinity, miniSession = null;
function allowPrefetch() {
  return !playbackBusy && playbackBufferAhead >= 8 && !navigator.connection?.saveData &&
    !/(^|-)2g$/.test(navigator.connection?.effectiveType || '');
}
try { preferences = JSON.parse(localStorage.getItem('dinosour.ui.v1')); } catch { preferences = null; }
if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) preferences = {};
preferences.topics = Array.isArray(preferences.topics) ? [...new Set(preferences.topics.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 80)).filter(Boolean))] : [];
preferences.recentSearches = Array.isArray(preferences.recentSearches) ? [...new Set(preferences.recentSearches.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 120)).filter(Boolean))].slice(0, 8) : [];
savePreferences();
function savePreferences() {
  try { localStorage.setItem('dinosour.ui.v1', JSON.stringify(preferences)); } catch {}
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
  $('#theme-toggle').innerHTML = icon(theme === 'light' ? 'moon' : 'sun');
  $('#theme-toggle').setAttribute('aria-label', label);
  $('#theme-toggle').title = label;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#ffffff' : '#0f0f0f';
}
setTheme(preferences.theme === 'light' ? 'light' : 'dark');
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
  $('#saved-count').textContent = library.saved.length;
}
persist();
function toast(text) {
  $('#toast').textContent = text; $('#toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2600);
}
function duration(seconds) {
  if (!seconds) return '';
  const s = Math.floor(seconds);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const views = n => n == null ? 'YouTube' : `${Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)} views`;
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
  return `<article class="card"><div class="thumb"><a href="${href}" aria-label="Watch ${escape(v.title)}"><img src="${escape(v.thumb)}" alt="" loading="lazy" decoding="async"></a>${v.duration ? `<span class="duration">${duration(v.duration)}</span>` : ''}${percent ? `<span class="watched-bar" style="width:${percent.toFixed(1)}%" aria-hidden="true"></span>` : ''}<button class="save-card ${saved ? 'selected' : ''}" data-save="${v.id}" aria-label="${saved ? 'Remove' : 'Save'} ${escape(v.title)} ${saved ? 'from' : 'to'} Watch later" aria-pressed="${saved}" title="${saved ? 'Saved to Watch later' : 'Watch later'}">${icon(saved ? 'check' : 'clock')}</button></div><div class="card-body"><span class="avatar" style="--avatar-hue:${hue}" aria-hidden="true">${escape(v.channel?.[0]?.toUpperCase() || 'Y')}</span><div class="card-copy"><h3><a href="${href}">${escape(v.title)}</a></h3><p>${escape(v.channel)}</p><p>${escape(v.viewsText || views(v.views))}</p><div class="queue-card-tools"><button data-queue-next="${v.id}" aria-label="Play ${escape(v.title)} next">Play next</button><button data-queue-add="${v.id}" aria-label="Add ${escape(v.title)} to queue">+ Queue</button></div></div></div></article>`;
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
    if (lastShortsQuery !== query) { shortsFeed = []; shortsFeedCursor = ''; }
    lastShortsQuery = query;
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
  main.innerHTML = `${chips(query || '', shorts ? 'shorts' : 'search')}${home ? continueWatching() : ''}${heading}${filterBar}<div id="feed" aria-busy="true">${shorts ? shortsSkeleton() : skeleton()}</div>`;
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
  const load = async () => {
    if (loading || ended || failed || current !== generation) return;
    loading = true;
    $('#feed').setAttribute('aria-busy', 'true');
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
      }
      const fresh = data.videos.filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; });
      if (shorts) {
        $('#results').insertAdjacentHTML('beforeend', fresh.map(shortCard).join(''));
        for (const v of data.videos) if (!shortsFeed.some(item => item.id === v.id)) shortsFeed.push(v);
        shortsFeedCursor = data.continuation || shortsFeedCursor;
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
      if (initialized) {
        $('#feed-status').innerHTML = `<span>${escape(error.message)}</span><button id="retry-feed">Retry</button>`;
        $('#retry-feed').onclick = () => { failed = false; load(); };
        $('#feed').setAttribute('aria-busy', 'false');
      }
      else { $('#feed').innerHTML = empty('Couldn’t load videos', error.message, true); $('#feed').setAttribute('aria-busy', 'false'); }
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
function prepareWatch(id) {
  if (!allowPrefetch()) return;
  if (warmWatch?.id === id || location.hash === `#watch=${id}`) return;
  discardWarmWatch();
  const entry = { id, controller: new AbortController(), video: document.createElement('video'), audio: document.createElement('audio') };
  warmWatch = entry;
  entry.video.preload = entry.audio.preload = 'auto';
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
  entry.expiry = setTimeout(() => { if (warmWatch === entry) discardWarmWatch(); }, 45000);
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
  return { app: 'dinosour', version: 1, exportedAt: new Date().toISOString(), library, preferences: chosen };
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
function sanitizeLibrary(source) {
  const clean = {};
  for (const field of ['saved', 'history', 'liked', 'queue']) {
    const list = Array.isArray(source?.[field]) ? source[field] : [];
    const seen = new Set();
    const limit = field === 'queue' ? 100 : field === 'history' ? 200 : 500;
    clean[field] = list.map(cleanLibraryItem).filter(item => item && !seen.has(item.id) && seen.add(item.id)).slice(0, limit);
  }
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
  return merged;
}
function applyBackup(data, replace) {
  const clean = sanitizeBackup(data);
  library = replace ? clean.library : mergeLibrary(library, clean.library);
  preferences = replace ? { ...preferences, ...clean.preferences } : {
    ...preferences,
    ...clean.preferences,
    topics: [...new Set([...(preferences.topics || []), ...(clean.preferences.topics || [])])],
    recentSearches: [...new Set([...(clean.preferences.recentSearches || []), ...(preferences.recentSearches || [])])].slice(0, 8),
  };
  preferences.topics = [...new Set((preferences.topics || []).filter(t => typeof t === 'string'))];
  preferences.recentSearches = (preferences.recentSearches || []).slice(0, 8);
  persist(); savePreferences(); setTheme(preferences.theme === 'light' ? 'light' : 'dark'); renderTopicNavigation();
  $('#saved-count').textContent = library.saved.length;
  const hash = location.hash.slice(1) || 'home';
  if (['saved', 'history', 'liked'].includes(hash)) collection(hash);
  else if (hash === 'home') route();
  toast(replace ? 'Backup restored' : 'Backup merged');
}
function openBackupDialog() {
  let dialog = $('#backup-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'backup-dialog'; dialog.className = 'backup-dialog';
    dialog.innerHTML = `<div class="dialog-heading"><h2>Backup &amp; restore</h2><button type="button" data-close-backup aria-label="Close">×</button></div><p class="backup-intro">Save your topics, Watch later, history, liked videos, queue and playback settings as one file. Restore it here or on another device.</p><div class="backup-actions"><button class="primary" type="button" data-export-backup>Download backup</button><button type="button" data-import-backup>Restore from file</button><input id="backup-file" type="file" accept="application/json,.json" hidden></div><div id="backup-summary" class="backup-summary" role="status"></div>`;
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
        summary.innerHTML = `<p><strong>${escape(selected.name)}</strong> contains ${clean.library.saved.length} saved, ${clean.library.history.length} history, ${clean.library.liked.length} liked and ${clean.library.queue.length} queued videos.</p><div class="backup-choice"><button type="button" data-backup-merge>Merge with this device</button><button type="button" class="primary" data-backup-replace>Replace everything</button></div>`;
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

async function watch(id, current, controller, refresh) {
  const watchStarted = performance.now();
  playbackBusy = true; playbackBufferAhead = 0;
  clearTimeout(warmIntentTimer);
  const warmed = !refresh && warmWatch?.id === id ? warmWatch : null;
  if (warmed) { clearTimeout(warmed.expiry); warmWatch = null; }
  else discardWarmWatch();
  main.className = 'watch-page';
  main.innerHTML = `<div class="watch-layout"><section class="watch-primary"><div class="player-shell"><video id="video" controls playsinline preload="auto"></video><audio id="audio" preload="auto"></audio><div id="player-status" class="player-status" hidden></div></div><div id="watch-info"></div></section><aside class="watch-related"><h2>More to watch</h2><div id="related">${skeleton()}</div></aside></div>`;
  if (warmed) {
    warmed.video.id = 'video'; warmed.audio.id = 'audio';
    $('#video').replaceWith(warmed.video); $('#audio').replaceWith(warmed.audio);
  }
  const video = $('#video'), audio = $('#audio'), status = $('#player-status');
  const preview = videos.get(id);
  video.poster = preview?.thumb || `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  video.controls = false;
  const loading = document.createElement('div');
  loading.className = 'watch-loading';
  loading.setAttribute('role', 'status');
  loading.innerHTML = `<img src="${escape(video.poster)}" alt=""><div class="watch-loading-caption"><span class="spinner" aria-hidden="true"></span><strong>Getting your video ready…</strong><span>${escape(preview?.title || 'Preparing playback')}</span></div>`;
  video.parentElement.append(loading);
  const bufferHint = document.createElement('div');
  bufferHint.className = 'watch-buffer-hint'; bufferHint.hidden = true;
  bufferHint.setAttribute('role', 'status'); bufferHint.textContent = 'Buffering…';
  video.parentElement.append(bufferHint);
  let waitingTimer, stallTimer, hasFrame = false, switching = false, playingIntent = true, audioBuffering = false, ignorePause = false;
  let reloadStreams, captionRequest = 0, captionBlob = null;
  let metadataMs = 0, firstFrameMs = 0, rebuffers = 0, recoveries = 0, qualityLoads = 0, statsTimer = null;
  const frozenFrame = document.createElement('canvas');
  frozenFrame.className = 'quality-frame'; frozenFrame.hidden = true;
  video.parentElement.append(frozenFrame);
  const freezeFrame = () => {
    if (video.readyState < 2 || !video.videoWidth) return;
    frozenFrame.width = video.videoWidth; frozenFrame.height = video.videoHeight;
    try { frozenFrame.getContext('2d').drawImage(video, 0, 0); frozenFrame.hidden = false; } catch {}
  };
  const hideLoading = () => {
    hasFrame = true; loading.hidden = true; video.controls = true;
    frozenFrame.hidden = true;
    clearTimeout(waitingTimer); bufferHint.hidden = true;
  };
  const showBuffering = () => {
    clearTimeout(waitingTimer);
    if (hasFrame) waitingTimer = setTimeout(() => {
      if (!disposed && !video.paused && video.readyState < 3) bufferHint.hidden = false;
    }, 500);
  };
  const clearStatus = () => { status.innerHTML = ''; status.hidden = true; };
  const showStatus = html => { status.innerHTML = html; status.hidden = false; };
  let disposed = false, syncTimer, lastSave = 0, separate = false, info, audioFallbacks = [], audioIndex = 0, healthySince = 0, retrying = false;
  const saveProgress = () => {
    if (!info || video.currentTime < 1) return;
    library.history = [{ ...compact(info), position: video.ended ? 0 : video.currentTime, duration: video.duration || info.duration || 0, watchedAt: Date.now() }, ...library.history.filter(v => v.id !== id)].slice(0, 200);
    persist();
  };
  cleanup = () => {
    saveProgress(); disposed = true; clearInterval(syncTimer); clearTimeout(waitingTimer); clearTimeout(stallTimer);
    clearInterval(statsTimer); $('#stats-dialog')?.remove();
    playbackBusy = false; playbackBufferAhead = Infinity;
    captionRequest++; if (captionBlob) URL.revokeObjectURL(captionBlob);
    warmed?.controller.abort();
    video.pause(); audio.pause();
    video.removeAttribute('src'); audio.removeAttribute('src'); video.load(); audio.load();
  };
  const showError = message => {
    if (disposed) return;
    loading.hidden = true; bufferHint.hidden = true; clearTimeout(waitingTimer);
    clearTimeout(stallTimer); playbackBusy = false;
    video.pause(); audio.pause();
    $('#unmute')?.remove();
    showStatus(`<div><h2>Couldn't play this one.</h2><p>${escape(message)}</p><button data-retry>Retry video</button></div>`);
  };
  const retryPlayback = async message => {
    if (disposed || retrying) return;
    if ((autoRetryCount.get(id) || 0) >= 2) return showError(`${message} Retry to request a fresh stream.`);
    retrying = true; recoveries++;
    autoRetryCount.set(id, (autoRetryCount.get(id) || 0) + 1);
    const position = video.currentTime;
    if (info && position >= 1) {
      library.history = [{ ...compact(info), position, duration: video.duration || info.duration || 0, watchedAt: Date.now() }, ...library.history.filter(v => v.id !== id)].slice(0, 200);
      persist();
    }
    freezeFrame(); playbackBusy = true; discardWarmWatch();
    clearTimeout(stallTimer);
    if (!video.paused) ignorePause = true;
    video.pause(); audio.pause();
    bufferHint.textContent = 'Reconnecting…'; bufferHint.hidden = false;
    try {
      const fresh = await shortInfo(id, controller.signal, true);
      if (disposed) return;
      if (!reloadStreams) return showError(message);
      reloadStreams(fresh, position, playingIntent);
    } catch (error) { if (!disposed && error.name !== 'AbortError') showError(error.message); }
    finally { retrying = false; }
  };
  video.onerror = () => retryPlayback('The video stream was interrupted.');
  try {
    info = warmed
      ? await warmed.promise.catch(() => api(`/api/video?id=${id}`, controller.signal))
      : await shortInfo(id, controller.signal, refresh);
    metadataMs = performance.now() - watchStarted;
    if (current !== generation) return;
    remember(info);
    video.poster = info.thumb || video.poster;
    document.title = `${info.title} — Dinosour`;
    const restartKey = `dinosour.restart.${id}`;
    const savedPosition = sessionStorage.getItem(restartKey) ? 0 : (library.history.find(v => v.id === id)?.position || 0);
    sessionStorage.removeItem(restartKey);
    $('#watch-info').innerHTML = `<h1 class="watch-title">${escape(info.title)}</h1><div class="watch-actions"><div class="channel"><span class="avatar">${escape(info.channel[0])}</span><div><strong>${escape(info.channel)}</strong><span>YouTube channel</span></div></div><button id="like" aria-pressed="${library.liked.some(v => v.id === id)}" class="${library.liked.some(v => v.id === id) ? 'selected' : ''}">${icon('like')}Like</button><button id="save" aria-pressed="${library.saved.some(v => v.id === id)}" class="${library.saved.some(v => v.id === id) ? 'selected' : ''}">${icon('save')}Save</button><button id="share">${icon('share')}Share</button></div><div class="player-tools"><span>Playback</span><div class="volume-control"><button type="button" id="mute-toggle" class="volume-button" aria-label="Mute" title="Mute">${icon('volume')}</button><input id="volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume"></div><label>Quality <select id="quality" aria-label="Video quality">${qualityOptions(info)}</select></label><label>Speed <select id="speed" aria-label="Playback speed">${speedOptions()}</select></label></div><div class="description"><p><strong>${views(info.views)}${info.published ? ` · ${escape(info.published.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))}` : ''}</strong></p><p class="description-preview">${escape((info.description || 'No description available.').split('\n').filter(Boolean).slice(0, 2).join('\n'))}</p><details><summary>Show more</summary><p>${escape(info.description || 'No description available.')}</p><p class="playback-note">Direct playback of public videos. Creator sponsorships within videos remain. Restricted videos and live streams may be unavailable.</p></details></div><p class="shortcuts">Space to pause · ← / → to seek · F for fullscreen</p>`;
    bindInfoActions(id);
    library.queue = library.queue.filter(v => v.id !== id); persist();
    $('.watch-related').insertAdjacentHTML('afterbegin', '<section id="watch-queue"></section>');
    renderQueue();
    $('.player-tools').insertAdjacentHTML('beforeend', '<label>Audio <select id="audio-language" aria-label="Audio language"></select></label><label>Captions <select id="captions" aria-label="Captions"></select></label><button id="pip-toggle" type="button">Picture-in-picture</button><button id="mini-toggle" type="button">Mini-player</button><button id="fullscreen-toggle" type="button">Fullscreen</button><button id="stats-toggle" type="button">Stats for nerds</button>');
    $('#quality').insertAdjacentHTML('afterbegin', '<option value="auto">Auto</option>');
    let selectedQuality = startQuality(info), lastQualityChange = Date.now(), audioTrack = preferredAudio(info);
    let autoMode = !preferences.qualityHeight;
    const updateAutoLabel = () => { $('#quality').querySelector('[value="auto"]').textContent = `Auto (${info.qualities[selectedQuality].label})`; };
    $('#quality').value = autoMode ? 'auto' : String(selectedQuality);
    const updateTracks = () => {
      const tracks = info.audioTracks || [];
      $('#audio-language').innerHTML = '<option value="preferred-en">English (preferred)</option><option value="original">Original</option>' +
        tracks.map(t => `<option value="${escape(t.id)}">${escape(t.label)}</option>`).join('');
      const preference = !preferences.audioLanguage || preferences.audioLanguage === 'en' ? 'preferred-en' : preferences.audioLanguage;
      $('#audio-language').value = tracks.some(t => t.id === preference) || ['preferred-en', 'original'].includes(preference) ? preference : 'preferred-en';
      $('#audio-language').disabled = !tracks.length;
      $('#audio-language').title = audioTrack ? `Playing: ${audioTrack.label}` : 'Default audio';
      $('#captions').innerHTML = '<option value="">Off</option>' + (info.captions || []).map(t => `<option value="${escape(t.language)}">${escape(t.label)}</option>`).join('');
      $('#captions').value = (info.captions || []).some(t => t.language === preferences.captions) ? preferences.captions : '';
      $('#captions').disabled = !(info.captions || []).length;
    };
    const setCaptions = async () => {
      const request = ++captionRequest;
      video.querySelectorAll('track').forEach(t => t.remove());
      if (captionBlob) { URL.revokeObjectURL(captionBlob); captionBlob = null; }
      const caption = info.captions?.find(t => t.language === $('#captions').value);
      if (!caption) return;
      try {
        const response = await fetch(caption.src, { signal: controller.signal });
        if (!response.ok) throw new Error('Captions could not load. Try selecting them again.');
        const text = await response.text();
        if (disposed || request !== captionRequest) return;
        if (!text.trimStart().startsWith('WEBVTT')) throw new Error('Captions are unavailable.');
        const track = document.createElement('track');
        track.kind = 'subtitles'; track.srclang = caption.language; track.label = caption.label; track.default = true;
        captionBlob = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
        track.src = captionBlob;
        video.append(track); track.track.mode = 'showing';
      } catch (error) {
        if (!disposed && request === captionRequest && error.name !== 'AbortError') { toast(error.message); $('#captions').value = ''; }
      }
    };
    updateTracks(); setCaptions();
    $('#captions').onchange = () => { preferences.captions = $('#captions').value; savePreferences(); setCaptions(); };
    $('#mini-toggle').onclick = () => { enableMiniPlayer(id); location.hash = '#home'; };
    $('#pip-toggle').onclick = async () => {
      try {
        if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
        else if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
          await video.requestPictureInPicture(); enableMiniPlayer(id);
        } else { enableMiniPlayer(id); location.hash = '#home'; }
      } catch { enableMiniPlayer(id); location.hash = '#home'; toast('Using the in-app mini-player on this device.'); }
    };
    const playerShell = video.parentElement;
    $('#fullscreen-toggle').onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (playerShell.requestFullscreen) await playerShell.requestFullscreen();
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else toast('Fullscreen is not available in this browser.');
      } catch { toast('Fullscreen was blocked. Use your browser’s fullscreen control.'); }
    };
    const gestureHint = document.createElement('div');
    gestureHint.className = 'gesture-hint'; gestureHint.hidden = true; gestureHint.setAttribute('aria-hidden', 'true');
    playerShell.append(gestureHint);
    let lastTap = 0, lastTapX = 0, lastGestureAt = 0, gestureTimer;
    const seekByGesture = (direction) => {
      const target = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + direction * 10));
      video.currentTime = target;
      gestureHint.textContent = direction < 0 ? '−10 seconds' : '+10 seconds';
      gestureHint.className = `gesture-hint ${direction < 0 ? 'seek-back' : 'seek-forward'}`;
      gestureHint.hidden = false;
      clearTimeout(gestureTimer); gestureTimer = setTimeout(() => { gestureHint.hidden = true; }, 650);
      lastGestureAt = Date.now();
    };
    playerShell.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' || event.target.closest('button, input, select, a, .player-tools')) return;
      const now = Date.now();
      if (now - lastTap < 340 && Math.abs(event.clientX - lastTapX) < 70) {
        event.preventDefault(); event.stopPropagation();
        seekByGesture(event.clientX < playerShell.getBoundingClientRect().left + playerShell.clientWidth / 2 ? -1 : 1);
        lastTap = 0;
      } else { lastTap = now; lastTapX = event.clientX; }
    }, { passive: false });
    playerShell.addEventListener('dblclick', event => {
      if (Date.now() - lastGestureAt < 500 || event.target.closest('button, input, select, a')) return;
      event.preventDefault();
      seekByGesture(event.clientX < playerShell.getBoundingClientRect().left + playerShell.clientWidth / 2 ? -1 : 1);
    });
    const statsDialog = document.createElement('dialog');
    statsDialog.id = 'stats-dialog'; statsDialog.className = 'stats-dialog';
    statsDialog.innerHTML = '<div class="dialog-heading"><h2>Playback diagnostics</h2><button type="button" data-close-stats aria-label="Close">×</button></div><pre id="stats-body"></pre><p class="stats-note">Use this when a video is slow or stalls. It shows where time is going.</p>';
    document.body.append(statsDialog);
    statsDialog.querySelector('[data-close-stats]').onclick = () => statsDialog.close();
    const updateStats = () => {
      if (!statsDialog.open || !info) return;
      const quality = video.getVideoPlaybackQuality?.();
      const connection = navigator.connection;
      const audioLabel = audioTrack?.label || 'Default audio';
      const captionLabel = $('#captions')?.selectedOptions?.[0]?.textContent || 'Off';
      const format = value => Number.isFinite(value) ? value.toFixed(1) : '—';
      const lines = [
        `Video       ${info.title}`,
        `Stream      ${info.qualities[selectedQuality].label}${autoMode ? ' (auto)' : ' (manual)'} · ${video.videoWidth || '?'}×${video.videoHeight || '?'}`,
        `Position    ${format(video.currentTime)}s / ${format(video.duration)}s`,
        `Buffer       ${format(playbackBufferAhead)}s ahead`,
        `Startup     stream details ${format(metadataMs / 1000)}s · first frame ${format(firstFrameMs / 1000)}s`,
        `Playback    ${rebuffers} rebuffer${rebuffers === 1 ? '' : 's'} · ${recoveries} recover${recoveries === 1 ? 'y' : 'ies'} · ${Math.max(0, qualityLoads - 1)} quality change${qualityLoads - 1 === 1 ? '' : 's'}`,
        `Frames      ${quality ? `${quality.droppedVideoFrames} dropped / ${quality.totalVideoFrames} total` : 'not reported'}`,
        `Audio       ${audioLabel}${separate ? ' (separate AAC)' : ' (muxed)'}`,
        `Captions    ${captionLabel}`,
        `Speed       ${format(video.playbackRate)}× · volume ${Math.round(video.volume * 100)}%${video.muted ? ' (muted)' : ''}`,
        `Network     ${connection?.effectiveType || 'unknown'}${connection?.downlink ? ` · ~${connection.downlink} Mbps` : ''}${connection?.saveData ? ' · data saver' : ''}`,
        `Server      ${location.host} · ${navigator.onLine ? 'online' : 'offline'}`,
        `Player      ${document.pictureInPictureElement ? 'picture-in-picture' : 'in page'}`,
      ];
      $('#stats-body').textContent = lines.join('\n');
      window.__dinosourStats = { metadataMs, firstFrameMs, rebuffers, recoveries, qualityLoads, buffer: playbackBufferAhead };
    };
    $('#stats-toggle').onclick = () => {
      statsDialog.showModal(); updateStats();
      clearInterval(statsTimer); statsTimer = setInterval(updateStats, 1000);
    };
    statsDialog.addEventListener('close', () => clearInterval(statsTimer));
    const syncAudio = () => {
      if (!separate || disposed) return;
      if (Math.abs(audio.currentTime - video.currentTime) > .35 && audio.readyState) audio.currentTime = video.currentTime;
      audio.playbackRate = video.playbackRate; audio.volume = video.volume; audio.muted = video.muted;
    };
    const refreshVolumeUi = () => {
      const slider = $('#volume');
      const button = $('#mute-toggle');
      if (!slider || !button) return;
      slider.value = String(video.muted ? 0 : video.volume);
      const off = video.muted || video.volume === 0;
      button.innerHTML = icon(off ? 'muted' : 'volume');
      button.setAttribute('aria-label', off ? 'Unmute' : 'Mute');
      button.title = off ? 'Unmute' : 'Mute';
      button.classList.toggle('selected', off);
    };
    const savedVolume = typeof preferences.volume === 'number' ? Math.min(1, Math.max(0, preferences.volume)) : 1;
    video.volume = savedVolume;
    video.muted = !!preferences.muted || savedVolume === 0;
    $('#volume').oninput = () => {
      const value = Number($('#volume').value);
      video.volume = value;
      video.muted = value === 0;
      preferences.volume = value; preferences.muted = video.muted; savePreferences();
      syncAudio(); refreshVolumeUi();
    };
    $('#mute-toggle').onclick = () => {
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 1;
      preferences.muted = video.muted; preferences.volume = video.volume; savePreferences();
      syncAudio(); refreshVolumeUi();
    };
    refreshVolumeUi();
    const showUnmute = () => {
      if (disposed || $('#unmute')) return;
      const button = document.createElement('button');
      button.id = 'unmute'; button.className = 'unmute'; button.type = 'button';
      button.innerHTML = '🔇 Unmute';
      button.onclick = () => {
        audio.play().then(() => button.remove()).catch(() => toast('Audio could not start. Try pressing play.'));
      };
      status.parentElement.append(button);
    };
    const playAudio = () => {
      if (!separate || disposed || video.paused || video.readyState < 3 || video.seeking) return;
      syncAudio();
      audio.play().then(() => $('#unmute')?.remove()).catch(error => {
        if (error.name === 'NotAllowedError' && !disposed) showUnmute();
      });
    };
    const startPlayback = () => {
      if (disposed) return;
      clearStatus();
      video.play().then(playAudio).catch(error => {
        if (disposed) return;
        if (error.name === 'NotAllowedError') {
          loading.hidden = true; video.controls = true;
          showStatus(`<div><button class="primary" id="start-play">▶ &nbsp; Play video</button><p>Your browser paused autoplay.</p></div>`);
          $('#start-play').onclick = () => {
            clearStatus();
            video.play().then(playAudio).catch(() => retryPlayback('Playback was interrupted.'));
          };
        } else if (error.name !== 'AbortError') retryPlayback('Playback was interrupted.');
      });
    };
    audio.onerror = () => {
      if (!separate || disposed) return;
      if (audioIndex < audioFallbacks.length) {
        audio.src = audioFallbacks[audioIndex++];
        audio.load();
        playAudio();
        return;
      }
      retryPlayback('The audio stream was interrupted.');
    };
    const loadQuality = (index, position = 0, autoplay = false) => {
      const selected = info.qualities[index];
      const rate = Number($('#speed')?.value) || 1;
      qualityLoads++;
      freezeFrame(); switching = true; playingIntent = autoplay;
      audioBuffering = false; clearTimeout(stallTimer);
      selectedQuality = index; lastQualityChange = Date.now(); updateAutoLabel();
      playbackBusy = true; playbackBufferAhead = 0; discardWarmWatch();
      if (!video.paused) ignorePause = true;
      video.pause(); audio.pause(); separate = selected.separateAudio;
      audioIndex = 0;
      audioFallbacks = audioTrack?.fallbacks || info.audioFallbacks || [];
      if (video.error || video.getAttribute('src') !== selected.src) video.src = selected.src;
      video.playbackRate = rate;
      audio.playbackRate = rate;
      const audioSource = audioTrack?.src || info.audio;
      if (separate && audioSource) {
        if (audio.error || audio.getAttribute('src') !== audioSource) audio.src = audioSource;
      } else { audio.removeAttribute('src'); audio.load(); }
      const restorePosition = () => {
        if (disposed) return;
        if (position) video.currentTime = Math.min(position, Math.max(0, video.duration - 1));
        syncAudio();
        if (autoplay) startPlayback();
        else { switching = false; playbackBusy = false; }
      };
      video.onloadedmetadata = restorePosition;
      if (video.readyState >= 1) restorePosition();
      if (autoplay && !position) startPlayback(); else clearStatus();
    };
    reloadStreams = (fresh, position, autoplay) => {
      const height = info.qualities[selectedQuality].height;
      info = fresh; audioTrack = preferredAudio(info);
      const index = info.qualities.findIndex(q => q.height === height);
      $('#quality').innerHTML = '<option value="auto">Auto</option>' + qualityOptions(info);
      $('#quality').value = autoMode ? 'auto' : String(index >= 0 ? index : startQuality(info));
      updateTracks(); setCaptions();
      loadQuality(index >= 0 ? index : startQuality(info), position, autoplay);
    };
    $('#audio-language').onchange = () => {
      preferences.audioLanguage = $('#audio-language').value; savePreferences();
      audioTrack = preferredAudio(info); updateTracks();
      loadQuality(selectedQuality, video.currentTime, !video.paused);
    };
    video.onplay = () => { playingIntent = true; if (video.readyState >= 3) playAudio(); };
    video.onplaying = () => {
      switching = false; playbackBusy = false; clearTimeout(stallTimer);
      if (!firstFrameMs) firstFrameMs = performance.now() - watchStarted;
      bufferHint.textContent = 'Buffering…'; hideLoading(); clearStatus(); playAudio(); healthySince = Date.now();
    };
    audio.onplaying = () => { $('#unmute')?.remove(); };
    audio.onwaiting = () => {
      if (!separate || disposed || retrying || switching || video.paused || video.seeking) return;
      audioBuffering = true; playbackBusy = true; discardWarmWatch();
      if (!video.paused) ignorePause = true;
      video.pause(); audio.pause();
      bufferHint.textContent = 'Buffering audio…'; bufferHint.hidden = false;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { if (!disposed && audioBuffering) retryPlayback('The audio stream stalled.'); }, 8000);
    };
    audio.oncanplay = () => {
      if (!audioBuffering || disposed) return;
      audioBuffering = false; clearTimeout(stallTimer);
      if (playingIntent) startPlayback();
    };
    video.onpause = () => {
      if (ignorePause) { ignorePause = false; return; }
      audio.pause();
      if (!switching && !retrying && !video.error) { playingIntent = false; clearTimeout(stallTimer); }
      clearTimeout(waitingTimer); if (!retrying) bufferHint.hidden = true;
    };
    video.onwaiting = () => {
      audio.pause(); healthySince = 0; playbackBusy = true; rebuffers++; discardWarmWatch(); showBuffering();
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (disposed || !playingIntent || video.readyState >= 3) return;
        const lower = info.qualities.map((q, i) => ({ ...q, i })).filter(q => q.height < info.qualities[selectedQuality].height).sort((a, b) => b.height - a.height)[0];
        if (autoMode && lower && Date.now() - lastQualityChange > 4000) {
          loadQuality(lower.i, video.currentTime, true);
        } else retryPlayback('Playback stalled.');
      }, 8000);
    };
    video.onseeking = () => { audio.pause(); syncAudio(); showBuffering(); };
    video.onseeked = () => { syncAudio(); if (!video.paused) playAudio(); else frozenFrame.hidden = true; };
    video.onvolumechange = () => {
      syncAudio(); refreshVolumeUi();
      preferences.volume = video.volume; preferences.muted = video.muted; savePreferences();
    };
    video.onratechange = syncAudio;
    video.onended = () => {
      audio.pause(); saveProgress(); playingIntent = false; clearTimeout(stallTimer);
      if (!preferences.autoplay) return;
      const next = library.queue.shift() || videos.get($('#related a[href^="#watch="]')?.getAttribute('href').slice(7));
      persist(); renderQueue();
      if (next && next.id !== id) location.hash = `#watch=${next.id}`;
    };
    video.ontimeupdate = () => {
      if (healthySince && Date.now() - healthySince > 10000) autoRetryCount.delete(id);
      if (Date.now() - lastSave > 5000) { saveProgress(); lastSave = Date.now(); }
    };
    const ahead = media => {
      for (let i = 0; i < media.buffered.length; i++) {
        if (media.buffered.start(i) <= media.currentTime && media.buffered.end(i) >= media.currentTime) return media.buffered.end(i) - media.currentTime;
      }
      return 0;
    };
    syncTimer = setInterval(() => {
      syncAudio();
      playbackBufferAhead = Math.min(ahead(video), separate ? ahead(audio) : Infinity);
      if (playbackBufferAhead < 3) discardWarmWatch();
      if (!autoMode || disposed || retrying || switching || video.paused || !healthySince ||
          Date.now() - healthySince < 12000 || Date.now() - lastQualityChange < 25000 || playbackBufferAhead < 15) return;
      const cap = navigator.connection?.saveData || /2g|3g/.test(navigator.connection?.effectiveType || '') ? 480 : 1080;
      const higher = info.qualities.map((q, i) => ({ ...q, i })).filter(q => q.height > info.qualities[selectedQuality].height && q.height <= cap).sort((a, b) => a.height - b.height)[0];
      if (higher) loadQuality(higher.i, video.currentTime, true);
    }, 1000);
    $('#quality').onchange = () => {
      const playing = !video.paused;
      autoMode = $('#quality').value === 'auto';
      preferences.qualityHeight = autoMode ? null : info.qualities[Number($('#quality').value)].height; savePreferences();
      loadQuality(autoMode ? startQuality(info) : Number($('#quality').value), video.currentTime, playing);
    };
    $('#speed').onchange = () => { video.playbackRate = Number($('#speed').value); };
    loadQuality(selectedQuality, savedPosition, true);
    try {
      const related = await api(`/api/search?q=${encodeURIComponent(info.channel)}&page=1`, controller.signal);
      if (!disposed) $('#related').innerHTML = `<div class="grid">${related.videos.filter(v => v.id !== id).slice(0, 8).map(card).join('')}</div>`;
    } catch { if (!disposed) $('#related').innerHTML = '<p class="muted">More videos are unavailable right now.</p>'; }
  } catch (error) {
    if (current !== generation || error.name === 'AbortError') return;
    showError(error.message); $('#related').innerHTML = '';
  }
}

const shortInfo = (id, signal, refresh) => {
  if (!refresh && infoCache.has(id) && Date.now() - infoCacheTimes.get(id) < 120000) return Promise.resolve(infoCache.get(id));
  let request;
  request = api(`/api/video?id=${id}${refresh ? '&refresh=1' : ''}`, signal).then(info => {
    // An older prefetch may finish after a refresh. Only the current request
    // owns this cache entry; evicted requests must not reinsert themselves.
    if (infoCache.get(id) === request) {
      infoCache.set(id, info);
      infoCacheTimes.set(id, Date.now());
    }
    return info;
  });
  // Cache the in-flight request as well, so a concurrent prefetch or retry
  // cannot fall back to the old stream tickets while fresh metadata loads.
  infoCache.set(id, request);
  infoCacheTimes.set(id, Date.now());
  if (infoCache.size > 20) {
    const oldest = infoCache.keys().next().value;
    infoCache.delete(oldest); infoCacheTimes.delete(oldest);
  }
  request.catch(() => {
    if (infoCache.get(id) === request) { infoCache.delete(id); infoCacheTimes.delete(id); }
  });
  return request;
};

// Shorts play as a full-height vertical reel: wheel, swipe, arrow keys and the
// on-screen arrows move through the feed one Short at a time, and each one
// starts playing as soon as it becomes active.
async function reel(id, current, controller) {
  main.className = 'shorts-reel-page';
  main.innerHTML = `<div class="reel" id="reel"><div class="reel-main"><div class="reel-stage" id="reel-stage"><div class="reel-top"><a class="reel-back reel-top-button" href="#shorts" aria-label="Back to Shorts" title="Back to Shorts">${icon('back')}</a><button id="reel-play" class="reel-top-button" type="button" aria-label="Pause" title="Pause">${icon('pause')}</button><button id="reel-mute" class="reel-top-button" type="button" aria-label="Mute" title="Mute">${icon('volume')}</button><button id="reel-fullscreen" class="reel-top-button reel-fullscreen" type="button" aria-label="Full screen" title="Full screen">${icon('fullscreen')}</button></div><div class="reel-screen"><div class="reel-player active" data-reel-player><video id="video" playsinline preload="auto"></video><audio id="audio" preload="auto"></audio></div><div class="reel-player" data-reel-player aria-hidden="true"><video playsinline preload="auto"></video><audio preload="auto"></audio></div><div id="player-status" class="player-status" hidden></div><div id="reel-loading" class="reel-loading" hidden aria-hidden="true"><span class="spinner"></span></div><div class="reel-info" id="reel-info"></div><div id="reel-progress" class="reel-progress" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0"><span id="reel-progress-fill"></span></div></div></div><div class="reel-side"><div class="reel-actions" id="reel-actions"></div></div><div class="reel-nav"><button id="reel-prev" type="button" aria-label="Previous Short" title="Previous Short">${icon('up')}</button><button id="reel-next" type="button" aria-label="Next Short" title="Next Short">${icon('down')}</button></div></div></div>`;
  const reel = $('#reel'), stage = $('#reel-stage'), status = $('#player-status');
  const progress = $('#reel-progress'), progressFill = $('#reel-progress-fill'), loading = $('#reel-loading');
  // Two complete player pairs share the stage. The idle pair buffers the next
  // Short, then becomes the live pair on the next swipe. Because the element
  // itself is promoted, its already-buffered frames and audio are kept.
  const players = [...stage.querySelectorAll('.reel-player')].map(wrap => ({
    wrap,
    video: wrap.querySelector('video'),
    audio: wrap.querySelector('audio'),
  }));
  let activePlayer = 0;
  let video = players[0].video, audio = players[0].audio;
  const clearStatus = () => { status.innerHTML = ''; status.hidden = true; };
  const showStatus = html => { clearLoadHint(); status.innerHTML = html; status.hidden = false; };

  const known = shortsFeed.some(v => v.id === id);
  let list = shortsFeed.slice();
  if (!known) list.unshift({ id, title: 'YouTube Short', channel: 'YouTube Short', viewsText: '', thumb: `/api/thumb/${id}?t=short`, type: 'short' });
  let index = list.findIndex(v => v.id === id);
  let info = null, separate = false, disposed = false, syncTimer, lastSave = 0, loadToken = 0, loadHint;
  let audioFallbacks = [], audioIndex = 0, autoRetries = 0, healthySince = 0, growing = false, navLock = 0, wheelAt = 0, recovering = false;
  let prefetched = null, prefetchRequest = 0;
  const idlePlayer = () => players[activePlayer === 0 ? 1 : 0];
  const clearPlayer = pair => {
    pair.video.pause(); pair.audio.pause();
    pair.video.removeAttribute('src'); pair.audio.removeAttribute('src');
    pair.video.load(); pair.audio.load();
  };
  const promote = slot => {
    const old = players[activePlayer], next = players[slot];
    old.video.pause(); old.audio.pause();
    old.wrap.classList.remove('active');
    old.wrap.setAttribute('aria-hidden', 'true');
    old.video.removeAttribute('id'); old.audio.removeAttribute('id');
    activePlayer = slot;
    video = next.video; audio = next.audio;
    next.wrap.classList.add('active');
    next.wrap.removeAttribute('aria-hidden');
    next.video.id = 'video'; next.audio.id = 'audio';
  };
  const prefetchNext = async id => {
    if (disposed || !id || prefetched?.id === id) return;
    if (id === entry().id) return;
    if (navigator.connection?.saveData || ['slow-2g', '2g'].includes(navigator.connection?.effectiveType)) return;
    const request = ++prefetchRequest;
    try {
      const data = await shortInfo(id, controller.signal);
      if (disposed || request !== prefetchRequest || current !== generation) return;
      const slot = activePlayer === 0 ? 1 : 0;
      const pair = players[slot];
      if (pair.video === video) return;
      const qualities = data.qualities || [];
      const quality = qualities.find(q => q.height === 720) || qualities[0];
      if (!quality?.src) return;
      clearPlayer(pair);
      pair.video.src = quality.src;
      pair.audio.muted = true;
      const selectedAudio = preferredAudio(data)?.src || data.audio;
      const audioSrc = quality.separateAudio && selectedAudio ? selectedAudio : '';
      if (audioSrc) pair.audio.src = audioSrc;
      pair.video.load(); pair.audio.load();
      prefetched = { id, slot, audioSrc };
    } catch {
      if (request === prefetchRequest) prefetched = null;
    }
  };
  const takePrefetch = id => {
    if (!prefetched || prefetched.id !== id) return null;
    const taken = prefetched;
    prefetched = null;
    prefetchRequest++;
    return taken;
  };
  const applyVolume = () => {
    video.volume = typeof preferences.volume === 'number' ? Math.min(1, Math.max(0, preferences.volume)) : 1;
    video.muted = !!preferences.muted || video.volume === 0;
    audio.volume = video.volume; audio.muted = video.muted;
  };

  const clearLoadHint = () => { clearTimeout(loadHint); loading.hidden = true; };
  const showLoadHintSoon = token => {
    clearTimeout(loadHint);
    loadHint = setTimeout(() => {
      // Only cover the gap before the first frame exists; once a frame is
      // available the native media pipeline handles buffering feedback.
      if (!disposed && token === loadToken && video.readyState < 2) loading.hidden = false;
    }, 700);
  };

  applyVolume();

  const entry = () => list[index] || { id, title: 'YouTube Short', channel: 'YouTube Short', thumb: `/api/thumb/${id}?t=short`, type: 'short' };
  const saveProgress = (position = video.currentTime) => {
    const item = videos.get(entry().id) || entry();
    if (!(position >= 1)) return;
    library.history = [{ ...compact(item), type: 'short', position, duration: video.duration || item.duration || 0, watchedAt: Date.now() }, ...library.history.filter(v => v.id !== item.id)].slice(0, 200);
    persist();
  };
  cleanup = () => {
    saveProgress(); disposed = true; clearInterval(syncTimer); clearLoadHint();
    prefetchRequest++; prefetched = null;
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    if (document.fullscreenElement === reel) document.exitFullscreen?.().catch(() => {});
    for (const pair of players) clearPlayer(pair);
  };
  function onFullscreenChange() { refreshControls(); }
  const syncAudio = () => {
    if (!separate || disposed) return;
    if (Math.abs(audio.currentTime - video.currentTime) > .35 && audio.readyState) audio.currentTime = video.currentTime;
    audio.playbackRate = video.playbackRate; audio.volume = video.volume; audio.muted = video.muted;
  };
  const playAudio = () => {
    if (!separate || disposed) return;
    syncAudio();
    audio.play().then(() => $('#unmute')?.remove()).catch(error => {
      if (error.name === 'NotAllowedError' && !disposed) showUnmute();
    });
  };
  const showUnmute = () => {
    if (disposed || $('#unmute')) return;
    const button = document.createElement('button');
    button.id = 'unmute'; button.className = 'unmute'; button.type = 'button';
    button.innerHTML = '🔇 Unmute';
    button.onclick = () => { audio.play().then(() => button.remove()).catch(() => toast('Audio could not start. Press play to retry.')); };
    stage.append(button);
  };
  const refreshControls = () => {
    if (disposed) return;
    const play = $('#reel-play'), mute = $('#reel-mute'), full = $('#reel-fullscreen');
    const off = video.muted || video.volume === 0;
    if (play) {
      play.innerHTML = icon(video.paused ? 'play' : 'pause');
      play.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
      play.title = video.paused ? 'Play' : 'Pause';
    }
    if (mute) {
      mute.innerHTML = icon(off ? 'muted' : 'volume');
      mute.setAttribute('aria-label', off ? 'Unmute' : 'Mute');
      mute.title = off ? 'Unmute' : 'Mute';
      mute.classList.toggle('selected', off);
    }
    if (full) {
      const active = document.fullscreenElement === reel;
      full.innerHTML = icon(active ? 'compress' : 'fullscreen');
      full.setAttribute('aria-label', active ? 'Exit full screen' : 'Full screen');
      full.title = active ? 'Exit full screen' : 'Full screen';
    }
  };
  const renderActions = () => {
    const item = entry();
    const liked = library.liked.some(v => v.id === item.id);
    const saved = library.saved.some(v => v.id === item.id);
    const off = video.muted || video.volume === 0;
    const action = (name, selected, label, glyph) => `<button class="reel-action ${selected ? 'selected' : ''}" data-reel-action="${name}" aria-pressed="${selected}" aria-label="${label}" title="${label}"><span class="reel-action-icon">${icon(glyph)}</span><span class="reel-action-label">${label}</span></button>`;
    $('#reel-actions').innerHTML =
      action('like', liked, 'Like', 'heart') +
      action('save', saved, 'Save', saved ? 'check' : 'bookmark') +
      action('share', false, 'Share', 'share') +
      action('mute', off, off ? 'Muted' : 'Sound', off ? 'muted' : 'volume');
    refreshControls();
  };
  const renderInfo = item => {
    const channel = item.channel && item.channel !== 'YouTube Short' ? item.channel : '';
    const hue = [...channel].reduce((n, char) => n + char.charCodeAt(0), 0) % 360;
    const row = channel
      ? `<div class="reel-channel"><span class="avatar" style="--avatar-hue:${hue}" aria-hidden="true">${escape(channel[0].toUpperCase())}</span><strong>${escape(channel)}</strong></div>`
      : '';
    const meta = item.viewsText || (item.views != null ? views(item.views) : '');
    $('#reel-info').innerHTML = `${row}<h1 class="watch-title reel-title">${escape(item.title || 'YouTube Short')}</h1>${meta ? `<p class="reel-views">${escape(meta)}</p>` : ''}`;
  };
  const updateProgress = () => {
    const ratio = video.duration ? Math.min(1, Math.max(0, video.currentTime / video.duration)) : 0;
    progressFill.style.width = `${(ratio * 100).toFixed(2)}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  };
  const refreshNav = () => {
    const prev = $('#reel-prev'), next = $('#reel-next');
    if (prev) prev.hidden = index <= 0;
    if (next) next.disabled = index + 1 >= list.length && !shortsFeedCursor;
  };
  const grow = async () => {
    if (!shortsFeedCursor || growing || disposed) return;
    growing = true;
    try {
      const params = new URLSearchParams({ continuation: shortsFeedCursor });
      if (lastShortsQuery) { params.set('q', lastShortsQuery); params.set('shorts', '1'); }
      const data = await api(`${lastShortsQuery ? '/api/search' : '/api/shorts'}?${params}`, controller.signal);
      if (disposed || current !== generation) return;
      for (const v of data.videos) if (!list.some(item => item.id === v.id)) list.push(v);
      shortsFeedCursor = data.continuation || '';
    } catch {}
    growing = false;
  };
  const load = async (nextIndex, { direction = 0, position = 0, refresh = false } = {}) => {
    if (disposed) return;
    saveProgress();
    const token = ++loadToken;
    index = nextIndex;
    refreshNav();
    const item = entry();
    clearStatus(); clearLoadHint(); $('#unmute')?.remove();
    showLoadHintSoon(token);
    const preloaded = refresh ? null : takePrefetch(item.id);
    if (preloaded) {
      // The next Short was already buffering in the idle player. Promote that
      // element instead of re-assigning its source, so playback can begin from
      // the frames and audio it has already downloaded.
      promote(preloaded.slot);
    } else {
      prefetchRequest++; prefetched = null;
      const spare = idlePlayer();
      if (spare.video !== video) clearPlayer(spare);
      video.pause(); audio.pause();
      video.removeAttribute('src'); audio.removeAttribute('src'); video.load(); audio.load();
    }
    video.poster = item.thumb;
    separate = false;
    progressFill.style.width = '0%'; progress.setAttribute('aria-valuenow', '0');
    renderInfo(item); renderActions();
    history.replaceState(null, '', `#short=${item.id}`);
    if (direction) {
      stage.classList.remove('reel-in-up', 'reel-in-down');
      void stage.offsetWidth;
      stage.classList.add(direction > 0 ? 'reel-in-up' : 'reel-in-down');
    }
    try {
      const data = await shortInfo(item.id, controller.signal, refresh);
      if (disposed || token !== loadToken || current !== generation) return;
      info = data;
      remember({ ...info, type: 'short' });
      document.title = `${info.title} — Dinosour`;
      renderInfo({ ...item, ...info, channel: info.channel || item.channel, title: info.title || item.title });
      renderActions();
      const qualities = info.qualities || [];
      const quality = qualities.find(q => q.height === 720) || qualities[0];
      separate = quality.separateAudio;
      audioIndex = 0;
      const selectedAudio = preferredAudio(info);
      audioFallbacks = selectedAudio?.fallbacks || info.audioFallbacks || [];
      const audioSrc = selectedAudio?.src || info.audio;
      if (preloaded) {
        // Keep the promoted element's buffered source. Audio may not have been
        // preloaded if this format carries its audio in the video stream.
        if (separate && !preloaded.audioSrc && audioSrc) audio.src = audioSrc;
      } else {
        video.src = quality.src;
        if (separate && audioSrc) audio.src = audioSrc;
      }
      applyVolume();
      const restorePosition = () => {
        if (position) video.currentTime = Math.min(position, Math.max(0, video.duration - 1));
        syncAudio();
      };
      if (video.readyState >= 1) restorePosition();
      else video.onloadedmetadata = () => {
        if (disposed || token !== loadToken) return;
        restorePosition();
      };
      video.play().then(playAudio).catch(error => {
        if (disposed || token !== loadToken) return;
        if (error.name === 'NotAllowedError') {
          showStatus('<div><button class="primary" id="start-play">▶ &nbsp; Play Short</button><p>Your browser paused autoplay.</p></div>');
          $('#start-play').onclick = () => { clearStatus(); video.play().then(playAudio).catch(() => recover('Playback was interrupted.')); };
        } else if (error.name !== 'AbortError') recover('Playback was interrupted.');
      });
    } catch (error) {
      if (disposed || current !== generation || error.name === 'AbortError') return;
      showStatus(`<div><h2>Couldn't play this one.</h2><p>${escape(error.message)}</p><button data-retry>Retry Short</button></div>`);
    }
  };
  const showError = message => showStatus(`<div><h2>Couldn't play this one.</h2><p>${escape(message)}</p><button data-retry>Retry Short</button></div>`);
  const recover = async message => {
    if (disposed || recovering) return;
    if (autoRetries >= 2) return showError(`${message} Retry to request a fresh stream.`);
    recovering = true;
    autoRetries++;
    const position = video.currentTime;
    saveProgress(position);
    showStatus('<div><span class="spinner" aria-hidden="true"></span><h2>Reconnecting…</h2><p>Refreshing this Short’s stream.</p></div>');
    try { await load(index, { position, refresh: true }); } finally { recovering = false; }
  };
  const go = async delta => {
    if (disposed || Date.now() < navLock) return;
    navLock = Date.now() + 500;
    const target = index + delta;
    if (target >= list.length) await grow();
    if (target < 0) { toast('You’re at the start of these Shorts'); return; }
    if (target >= list.length) { toast('You’re all caught up for these Shorts'); return; }
    load(target, { direction: delta });
  };

  for (const pair of players) {
    const v = pair.video, a = pair.audio;
    v.onerror = () => { if (v === video) recover('The video stream was interrupted.'); };
    a.onerror = () => {
      if (a !== audio || !separate || disposed) return;
      if (audioIndex < audioFallbacks.length) {
        audio.src = audioFallbacks[audioIndex++];
        audio.load();
        playAudio();
        return;
      }
      recover('The audio stream was interrupted.');
    };
    v.onplay = () => { if (v !== video) return; playAudio(); refreshControls(); };
    v.onplaying = () => {
      if (v !== video) return;
      clearLoadHint(); playAudio(); healthySince = Date.now(); refreshControls();
      prefetchNext(list[index + 1]?.id);
    };
    a.onplaying = () => { if (a === audio) $('#unmute')?.remove(); };
    v.onpause = () => { if (v !== video) return; clearLoadHint(); audio.pause(); refreshControls(); };
    v.onwaiting = () => {
      if (v !== video) return;
      audio.pause(); healthySince = 0;
      prefetchRequest++; prefetched = null;
      clearPlayer(players[activePlayer === 0 ? 1 : 0]);
      if (!video.paused) showLoadHintSoon(loadToken);
    };
    v.onseeking = () => { if (v !== video) return; audio.pause(); syncAudio(); updateProgress(); };
    v.onseeked = () => { if (v !== video) return; syncAudio(); updateProgress(); if (!video.paused) playAudio(); };
    v.ondurationchange = () => { if (v === video) updateProgress(); };
    v.onratechange = () => { if (v === video) syncAudio(); };
    v.onvolumechange = () => {
      if (v !== video) return;
      syncAudio();
      preferences.volume = video.volume; preferences.muted = video.muted; savePreferences();
      renderActions(); refreshControls();
    };
    v.onended = () => { if (v === video) { saveProgress(0); refreshControls(); go(1); } };
    v.ontimeupdate = () => {
      if (v !== video) return;
      updateProgress();
      if (healthySince && Date.now() - healthySince > 10000) autoRetries = 0;
      if (Date.now() - lastSave > 5000) { saveProgress(); lastSave = Date.now(); }
    };
  }
  syncTimer = setInterval(syncAudio, 1000);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  const toggleMute = () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
    preferences.volume = video.volume; preferences.muted = video.muted; savePreferences();
    syncAudio(); renderActions(); refreshControls();
  };
  $('#reel-mute').onclick = toggleMute;
  $('#reel-play').onclick = () => {
    if (video.paused) video.play().catch(() => recover('Playback could not start.'));
    else video.pause();
  };
  $('#reel-fullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else reel.requestFullscreen?.().catch(() => toast('Full screen is not available in this browser.'));
  };
  // Click the picture to pause/resume, like the real Shorts player. Clicks on
  // buttons, links and the text overlay never reach this branch.
  stage.addEventListener('click', event => {
    if (Date.now() < swipedAt + 500) return;
    if (event.target.closest('button, a, #reel-progress, .reel-info, #player-status')) return;
    if (event.target !== video) return;
    if (video.paused) video.play().catch(() => recover('Playback could not start.'));
    else video.pause();
  });

  // Scrubbing. The reel has its own thin red bar because the native control bar
  // is intentionally hidden; this keeps the playback surface clean like Shorts.
  let scrubbing = false;
  const seekFromPointer = event => {
    const rect = progress.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = ratio * video.duration;
  };
  progress.addEventListener('pointerdown', event => {
    event.preventDefault(); event.stopPropagation();
    scrubbing = true; progress.setPointerCapture(event.pointerId); seekFromPointer(event);
  });
  progress.addEventListener('pointermove', event => { if (scrubbing) seekFromPointer(event); });
  progress.addEventListener('pointerup', event => { scrubbing = false; progress.releasePointerCapture?.(event.pointerId); });
  progress.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (event.key === 'ArrowLeft' ? -5 : 5)));
  });

  $('#reel-actions').addEventListener('click', async event => {
    const action = event.target.closest('[data-reel-action]')?.dataset.reelAction;
    if (!action) return;
    const item = entry();
    if (!videos.get(item.id)) remember({ ...item, type: 'short' });
    if (action === 'like' || action === 'save') { toggle(action, item.id); renderActions(); }
    else if (action === 'share') {
      try { await navigator.clipboard.writeText(`https://www.youtube.com/shorts/${item.id}`); toast('YouTube link copied'); }
      catch { toast('Copy the link from your address bar.'); }
    } else if (action === 'mute') toggleMute();
  });
  $('#reel-prev').onclick = () => go(-1);
  $('#reel-next').onclick = () => go(1);
  reel.addEventListener('wheel', event => {
    if (event.target.closest('input, select, button, a, #reel-progress')) return;
    if (Math.abs(event.deltaY) < 12) return;
    event.preventDefault();
    if (Date.now() < wheelAt) return;
    wheelAt = Date.now() + 550;
    go(event.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  let touchFrom = null, swipedAt = 0;
  reel.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || event.target.closest('button, a, #reel-progress')) return;
    touchFrom = event.clientY;
  });
  reel.addEventListener('pointerup', event => {
    if (touchFrom == null) return;
    const distance = touchFrom - event.clientY;
    touchFrom = null;
    if (Math.abs(distance) > 48) { swipedAt = Date.now(); go(distance > 0 ? 1 : -1); }
  });

  renderActions(); renderInfo(entry()); updateProgress();
  if (!known) {
    shortInfo(id, controller.signal).catch(() => {});
    (async () => {
      try {
        const params = new URLSearchParams();
        if (lastShortsQuery) { params.set('q', lastShortsQuery); params.set('shorts', '1'); }
        const data = await api(`${lastShortsQuery ? '/api/search' : '/api/shorts'}?${params}`, controller.signal);
        if (disposed || current !== generation) return;
        for (const v of data.videos) if (!shortsFeed.some(item => item.id === v.id)) shortsFeed.push(v);
        shortsFeedCursor = data.continuation || '';
        for (const v of data.videos) if (!list.some(item => item.id === v.id)) list.push(v);
        refreshNav();
        prefetchNext(list[index + 1]?.id);
      } catch {}
    })();
  }
  await load(index, { direction: 0 });
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
  document.title = 'Dinosour';
  closeNavigation();
  const hash = location.hash.slice(1) || 'home';
  const value = decodeValue(hash);
  clearTimeout(warmIntentTimer);
  clearTimeout(browsePrepareTimer);
  if (!hash.startsWith('watch=')) discardWarmWatch();
  document.querySelectorAll('[data-nav]').forEach(a => {
    let active = a.dataset.nav === hash || a.dataset.nav === value;
    if (a.dataset.nav === 'shorts') active = hash === 'shorts' || hash.startsWith('shorts=') || hash.startsWith('short=');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#search').value = hash.startsWith('search=') || hash.startsWith('shorts=') ? value : '';
  updateSearch();
  if (hash.startsWith('watch=') && /^[\w-]{11}$/.test(value)) await watch(value, current, routeController, refresh === true);
  else if (hash.startsWith('short=') && /^[\w-]{11}$/.test(value)) await reel(value, current, routeController);
  else if (hash === 'shorts' || hash.startsWith('shorts=')) await feed(hash.startsWith('shorts=') ? value : '', current, routeController, 'shorts');
  else if (['saved', 'history', 'liked'].includes(hash)) collection(hash);
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
let suggestTimer, suggestController, suggestionItems = [], suggestionIndex = -1;
function closeSuggestions() {
  if (!suggestionBox) return;
  suggestionBox.hidden = true; suggestionBox.innerHTML = ''; suggestionItems = []; suggestionIndex = -1;
  $('#search').setAttribute('aria-expanded', 'false');
}
function renderSuggestions(items, recent = false) {
  suggestionItems = items; suggestionIndex = -1;
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
  const id = getVideoId(q);
  if (!id) {
    preferences.recentSearches = [q, ...preferences.recentSearches.filter(value => value.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    savePreferences();
  }
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
    if (location.hash === '#saved') collection('saved');
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
