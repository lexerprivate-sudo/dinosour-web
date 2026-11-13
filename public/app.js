const $ = (selector) => document.querySelector(selector);
const main = $('#main');
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const key = 'dinosour.library.v1';
let library;
try { library = JSON.parse(localStorage.getItem(key)) || {}; } catch { library = {}; }
for (const field of ['saved', 'history', 'liked']) if (!Array.isArray(library[field])) library[field] = [];
const videos = new Map();
const infoCache = new Map();
const autoRetryCount = new Map();
let generation = 0, cleanup = () => {}, toastTimer, lastShortsQuery = '';
let shortsFeed = [], shortsFeedCursor = '';
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('dinosour.ui.v1')) || {}; } catch {}
preferences.topics = Array.isArray(preferences.topics) ? [...new Set(preferences.topics.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 80)).filter(Boolean))] : [];
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
  const response = await fetch(path, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not connect. Please retry.');
  return data;
}
function card(v) {
  remember(v);
  const saved = library.saved.some(item => item.id === v.id);
  const hue = [...(v.channel || '')].reduce((n, char) => n + char.charCodeAt(0), 0) % 360;
  const href = v.type === 'short' ? `#short=${v.id}` : `#watch=${v.id}`;
  return `<article class="card"><div class="thumb"><a href="${href}" aria-label="Watch ${escape(v.title)}"><img src="${escape(v.thumb)}" alt="" loading="lazy" decoding="async"></a>${v.duration ? `<span class="duration">${duration(v.duration)}</span>` : ''}<button class="save-card ${saved ? 'selected' : ''}" data-save="${v.id}" aria-label="${saved ? 'Remove' : 'Save'} ${escape(v.title)} ${saved ? 'from' : 'to'} Watch later" aria-pressed="${saved}" title="${saved ? 'Saved to Watch later' : 'Watch later'}">${icon(saved ? 'check' : 'clock')}</button></div><div class="card-body"><span class="avatar" style="--avatar-hue:${hue}" aria-hidden="true">${escape(v.channel?.[0]?.toUpperCase() || 'Y')}</span><div class="card-copy"><h3><a href="${href}">${escape(v.title)}</a></h3><p>${escape(v.channel)}</p><p>${escape(v.viewsText || views(v.views))}</p></div></div></article>`;
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
  const heading = shorts
    ? `<div class="search-heading shorts-heading"><h1>${query ? `Shorts for ${escape(query)}` : 'Shorts'}</h1></div>`
    : home ? '<h1 class="sr-only">Home</h1>' : `<div class="search-heading"><h1>Results for ${escape(query)}</h1><span>Videos</span></div>`;
  main.innerHTML = `${chips(query || '', shorts ? 'shorts' : 'search')}${heading}<div id="feed" aria-busy="true">${shorts ? shortsSkeleton() : skeleton()}</div>`;
  let continuation = '', loading = false, ended = false, failed = false, initialized = false, frame;
  const seen = new Set(), usedCursors = new Set();
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
      $('#results').insertAdjacentHTML('beforeend', fresh.map(shorts ? shortCard : card).join(''));
      if (shorts) {
        for (const v of data.videos) if (!shortsFeed.some(item => item.id === v.id)) shortsFeed.push(v);
        shortsFeedCursor = data.continuation || shortsFeedCursor;
      }
      if (continuation) usedCursors.add(continuation);
      continuation = data.continuation || '';
      ended = !continuation || usedCursors.has(continuation);
      if (!$('#results').children.length && ended) $('#results').innerHTML = empty(shorts ? 'No Shorts found' : 'No videos found', shorts ? 'Try another Shorts search or add a topic.' : 'Try another search or paste a YouTube video link.');
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
  main.innerHTML = `<div class="collection-heading"><div><h1>${titles[field]}</h1><p>${count} ${count === 1 ? 'video' : 'videos'} · Saved on this device</p></div>${count ? `<button class="clear" id="clear-library">${icon('trash')}Clear ${field === 'history' ? 'history' : 'list'}</button>` : ''}</div>${count ? `<div class="grid">${library[field].map(card).join('')}</div>` : empty(field === 'history' ? 'Keep track of what you watch' : 'Your collection starts here', field === 'history' ? 'Videos you play will appear here, ready to pick up where you left off.' : 'Save or like a video to find it here later.')}`;
  if ($('#clear-library')) $('#clear-library').onclick = () => { library[field] = []; persist(); collection(field); };
}

function qualityOptions(info) {
  return info.qualities.map((q, i) => `<option value="${i}" ${q.height === 720 || (i === 0 && !info.qualities.some(q => q.height === 720)) ? 'selected' : ''}>${q.label}</option>`).join('');
}
const speedOptions = () => [0.5, 0.75, 1, 1.25, 1.5, 2].map(n => `<option ${n === 1 ? 'selected' : ''} value="${n}">${n}×</option>`).join('');
function bindInfoActions(id) {
  $('#save').onclick = () => { const selected = toggle('saved', id); $('#save').classList.toggle('selected', selected); $('#save').setAttribute('aria-pressed', String(selected)); };
  $('#like').onclick = () => { const selected = toggle('liked', id); $('#like').classList.toggle('selected', selected); $('#like').setAttribute('aria-pressed', String(selected)); };
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
  if (navigator.connection?.saveData || /(^|-)2g$/.test(navigator.connection?.effectiveType || '')) return;
  if (warmWatch?.id === id || location.hash === `#watch=${id}`) return;
  discardWarmWatch();
  const entry = { id, controller: new AbortController(), video: document.createElement('video'), audio: document.createElement('audio') };
  warmWatch = entry;
  entry.video.preload = entry.audio.preload = 'auto';
  entry.video.playsInline = true;
  entry.promise = api(`/api/video?id=${id}`, entry.controller.signal).then(info => {
    if (entry.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const quality = info.qualities.find(q => q.height === 720) || info.qualities[0];
    entry.video.src = quality.src;
    if (quality.separateAudio && info.audio) entry.audio.src = info.audio;
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

async function watch(id, current, controller, refresh) {
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
  let waitingTimer, hasFrame = false;
  const hideLoading = () => {
    hasFrame = true; loading.hidden = true; video.controls = true;
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
    library.history = [{ ...compact(info), position: video.ended ? 0 : video.currentTime, watchedAt: Date.now() }, ...library.history.filter(v => v.id !== id)].slice(0, 200);
    persist();
  };
  cleanup = () => {
    saveProgress(); disposed = true; clearInterval(syncTimer); clearTimeout(waitingTimer);
    warmed?.controller.abort();
    video.pause(); audio.pause();
    video.removeAttribute('src'); audio.removeAttribute('src'); video.load(); audio.load();
  };
  const showError = message => {
    if (disposed) return;
    loading.hidden = true; bufferHint.hidden = true; clearTimeout(waitingTimer);
    video.pause(); audio.pause();
    $('#unmute')?.remove();
    showStatus(`<div><h2>Couldn't play this one.</h2><p>${escape(message)}</p><button data-retry>Retry video</button></div>`);
  };
  const retryPlayback = message => {
    if (disposed || retrying) return;
    if ((autoRetryCount.get(id) || 0) >= 2) return showError(`${message} Retry to request a fresh stream.`);
    retrying = true;
    autoRetryCount.set(id, (autoRetryCount.get(id) || 0) + 1);
    const position = video.currentTime;
    if (info && position >= 1) {
      library.history = [{ ...compact(info), position, watchedAt: Date.now() }, ...library.history.filter(v => v.id !== id)].slice(0, 200);
      persist();
    }
    video.pause(); audio.pause();
    showStatus('<div><span class="spinner" aria-hidden="true"></span><h2>Reconnecting…</h2><p>Refreshing this video’s stream.</p></div>');
    setTimeout(() => { if (!disposed) route(true); }, 600);
  };
  video.onerror = () => retryPlayback('The video stream was interrupted.');
  try {
    info = warmed
      ? await warmed.promise.catch(() => api(`/api/video?id=${id}`, controller.signal))
      : await api(`/api/video?id=${id}${refresh ? '&refresh=1' : ''}`, controller.signal);
    if (current !== generation) return;
    remember(info);
    video.poster = info.thumb || video.poster;
    document.title = `${info.title} — Dinosour`;
    const savedPosition = library.history.find(v => v.id === id)?.position || 0;
    $('#watch-info').innerHTML = `<h1 class="watch-title">${escape(info.title)}</h1><div class="watch-actions"><div class="channel"><span class="avatar">${escape(info.channel[0])}</span><div><strong>${escape(info.channel)}</strong><span>YouTube channel</span></div></div><button id="like" aria-pressed="${library.liked.some(v => v.id === id)}" class="${library.liked.some(v => v.id === id) ? 'selected' : ''}">${icon('like')}Like</button><button id="save" aria-pressed="${library.saved.some(v => v.id === id)}" class="${library.saved.some(v => v.id === id) ? 'selected' : ''}">${icon('save')}Save</button><button id="share">${icon('share')}Share</button></div><div class="player-tools"><span>Playback</span><div class="volume-control"><button type="button" id="mute-toggle" class="volume-button" aria-label="Mute" title="Mute">${icon('volume')}</button><input id="volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume"></div><label>Quality <select id="quality" aria-label="Video quality">${qualityOptions(info)}</select></label><label>Speed <select id="speed" aria-label="Playback speed">${speedOptions()}</select></label></div><div class="description"><p><strong>${views(info.views)}${info.published ? ` · ${escape(info.published.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))}` : ''}</strong></p><p class="description-preview">${escape((info.description || 'No description available.').split('\n').filter(Boolean).slice(0, 2).join('\n'))}</p><details><summary>Show more</summary><p>${escape(info.description || 'No description available.')}</p><p class="playback-note">Direct playback of public videos. Creator sponsorships within videos remain. Restricted videos and live streams may be unavailable.</p></details></div><p class="shortcuts">Space to pause · ← / → to seek · F for fullscreen</p>`;
    bindInfoActions(id);
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
      if (!separate || disposed) return;
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
      video.pause(); audio.pause(); separate = selected.separateAudio;
      audioIndex = 0;
      audioFallbacks = info.audioFallbacks || [];
      if (video.error || video.getAttribute('src') !== selected.src) video.src = selected.src;
      video.playbackRate = rate;
      audio.playbackRate = rate;
      if (separate && info.audio) {
        if (audio.error || audio.getAttribute('src') !== info.audio) audio.src = info.audio;
      } else { audio.removeAttribute('src'); audio.load(); }
      const restorePosition = () => {
        if (disposed) return;
        if (position) video.currentTime = Math.min(position, Math.max(0, video.duration - 1));
        syncAudio();
      };
      video.onloadedmetadata = restorePosition;
      if (video.readyState >= 1) restorePosition();
      if (autoplay) startPlayback(); else clearStatus();
    };
    video.onplay = () => { if (video.readyState >= 3) playAudio(); };
    video.onplaying = () => { hideLoading(); clearStatus(); playAudio(); healthySince = Date.now(); };
    audio.onplaying = () => { $('#unmute')?.remove(); };
    video.onpause = () => { audio.pause(); clearTimeout(waitingTimer); bufferHint.hidden = true; };
    video.onwaiting = () => { audio.pause(); healthySince = 0; showBuffering(); };
    video.onseeking = () => { audio.pause(); syncAudio(); showBuffering(); };
    video.onseeked = () => { syncAudio(); if (!video.paused) playAudio(); };
    video.onvolumechange = () => {
      syncAudio(); refreshVolumeUi();
      preferences.volume = video.volume; preferences.muted = video.muted; savePreferences();
    };
    video.onratechange = syncAudio;
    video.onended = () => { audio.pause(); saveProgress(); };
    video.ontimeupdate = () => {
      if (healthySince && Date.now() - healthySince > 10000) autoRetryCount.delete(id);
      if (Date.now() - lastSave > 5000) { saveProgress(); lastSave = Date.now(); }
    };
    syncTimer = setInterval(syncAudio, 1000);
    $('#quality').onchange = () => {
      const playing = !video.paused;
      loadQuality(Number($('#quality').value), video.currentTime, playing);
    };
    $('#speed').onchange = () => { video.playbackRate = Number($('#speed').value); };
    loadQuality(Number($('#quality').value), savedPosition, true);
    try {
      const related = await api(`/api/search?q=${encodeURIComponent(info.channel)}&page=1`, controller.signal);
      if (current === generation) $('#related').innerHTML = `<div class="grid">${related.videos.filter(v => v.id !== id).slice(0, 8).map(card).join('')}</div>`;
    } catch { if (current === generation) $('#related').innerHTML = '<p class="muted">More videos are unavailable right now.</p>'; }
  } catch (error) {
    if (current !== generation || error.name === 'AbortError') return;
    showError(error.message); $('#related').innerHTML = '';
  }
}

const shortInfo = (id, signal, refresh) => {
  if (!refresh && infoCache.has(id)) return Promise.resolve(infoCache.get(id));
  const request = api(`/api/video?id=${id}${refresh ? '&refresh=1' : ''}`, signal).then(info => {
    infoCache.set(id, info);
    return info;
  });
  if (!refresh) {
    infoCache.set(id, request);
    request.catch(() => { if (infoCache.get(id) === request) infoCache.delete(id); });
  }
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
      const audioSrc = quality.separateAudio && data.audio ? data.audio : '';
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
    library.history = [{ ...compact(item), type: 'short', position, watchedAt: Date.now() }, ...library.history.filter(v => v.id !== item.id)].slice(0, 200);
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
      audioFallbacks = info.audioFallbacks || [];
      if (preloaded) {
        // Keep the promoted element's buffered source. Audio may not have been
        // preloaded if this format carries its audio in the video stream.
        if (separate && !preloaded.audioSrc && info.audio) audio.src = info.audio;
      } else {
        video.src = quality.src;
        if (separate && info.audio) audio.src = info.audio;
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
      const next = list[index + 1];
      if (next) shortInfo(next.id, controller.signal).catch(() => {});
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
    v.onwaiting = () => { if (v !== video) return; audio.pause(); healthySince = 0; if (!video.paused) showLoadHintSoon(loadToken); };
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
$('#search-form').onsubmit = event => {
  event.preventDefault(); const q = $('#search').value.trim(); if (!q) return;
  const id = getVideoId(q);
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
document.addEventListener('keydown', event => {
  if ($('#topic-dialog').open) return;
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
window.addEventListener('pagehide', () => cleanup());
route();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
if (window.DinosourAndroid?.openSettings) {
  const androidSettings = $('#android-settings');
  androidSettings.hidden = false;
  androidSettings.onclick = () => window.DinosourAndroid.openSettings();
}
