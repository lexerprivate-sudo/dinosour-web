// Dinosour Shorts reel, lazy-loaded by route() on the first #short=<id> visit.
// The entry bundle never parses this module; it only rides along as an
// on-demand import.
import { $, icon, escape, views, api, preferences, savePreferences, shortsSession, isMetered, shortInfo, preferredAudio, bufferedAhead, toast } from './playback-core.js';
import { library, videos, persist, remember, compact, toggle, generation, setRouteCleanup, releasePlaybackState } from './app.js';

const main = $('#main');

// Shorts play as a full-height vertical reel: wheel, swipe, arrow keys and the
// on-screen arrows move through the feed one Short at a time, and each one
// starts playing as soon as it becomes active.
export async function reel(id, current, controller) {
  main.className = 'shorts-reel-page';
  main.innerHTML = `<div class="reel" id="reel"><div class="reel-main"><div class="reel-stage" id="reel-stage"><div class="reel-top"><a class="reel-back reel-top-button" href="#shorts" aria-label="Back to Shorts" title="Back to Shorts">${icon('back')}</a><button id="reel-play" class="reel-top-button" type="button" aria-label="Pause" title="Pause">${icon('pause')}</button><button id="reel-mute" class="reel-top-button" type="button" aria-label="Mute" title="Mute">${icon('volume')}</button><button id="reel-fullscreen" class="reel-top-button reel-fullscreen" type="button" aria-label="Full screen" title="Full screen">${icon('fullscreen')}</button></div><div class="reel-screen"><div class="reel-player active" data-reel-player><video id="video" playsinline preload="auto"></video><audio id="audio" preload="auto"></audio></div><div class="reel-player" data-reel-player aria-hidden="true"><video playsinline preload="auto"></video><audio preload="auto"></audio></div><div id="player-status" class="player-status" hidden></div><div id="reel-loading" class="reel-loading" hidden aria-hidden="true"><span class="spinner"></span></div><div class="reel-info" id="reel-info"></div><div id="reel-progress" class="reel-progress" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0"><span id="reel-progress-fill"></span></div><div id="reel-grow" class="reel-grow" role="status" hidden></div></div></div><div class="reel-side"><div class="reel-actions" id="reel-actions"></div></div><div class="reel-nav"><button id="reel-prev" type="button" aria-label="Previous Short" title="Previous Short">${icon('up')}</button><button id="reel-next" type="button" aria-label="Next Short" title="Next Short">${icon('down')}</button></div></div></div>`;
  const reel = $('#reel'), stage = $('#reel-stage'), status = $('#player-status');
  const progress = $('#reel-progress'), progressFill = $('#reel-progress-fill'), loading = $('#reel-loading'), growHint = $('#reel-grow');
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

  const known = shortsSession.items.some(v => v.id === id);
  // Deep-link into #short= without a feed-context: drop any stale topic list
  // and do a one-shot All-feed fetch so the reel shows the same feed the
  // Shorts button would have.
  if (!known) { shortsSession.items = []; shortsSession.cursor = ''; }
  let list = shortsSession.items.slice();
  if (!known) list.unshift({ id, title: 'YouTube Short', channel: 'YouTube Short', viewsText: '', thumb: `/api/thumb/${id}?t=short`, type: 'short' });
  let index = list.findIndex(v => v.id === id);
  let info = null, separate = false, disposed = false, syncTimer, lastSave = 0, loadToken = 0, loadHint;
  let audioFallbacks = [], audioIndex = 0, autoRetries = 0, healthySince = 0, growing = false, navLock = 0, wheelAt = 0, recovering = false;
  let prefetched = null, prefetchRequest = 0, prefetching = null;
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
    if (disposed || !id || prefetched?.id === id || prefetching === id) return;
    if (video.paused || !healthySince ||
        Math.min(bufferedAhead(video), separate ? bufferedAhead(audio) : Infinity) < Math.min(3, video.duration - video.currentTime)) return;
    if (id === entry().id) return;
    if (isMetered()) return;
    const request = ++prefetchRequest;
    prefetching = id;
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
    } finally {
      if (prefetching === id) prefetching = null;
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
  setRouteCleanup(() => {
    saveProgress(); disposed = true; clearInterval(syncTimer); clearLoadHint();
    prefetchRequest++; prefetched = null;
    releasePlaybackState();
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    if (document.fullscreenElement === reel) document.exitFullscreen?.().catch(() => {});
    for (const pair of players) clearPlayer(pair);
  });
  function onFullscreenChange() { refreshControls(); }
  const syncAudio = () => {
    if (!separate || disposed) return;
    if (document.visibilityState === 'hidden') { audio.playbackRate = video.playbackRate; audio.volume = video.volume; audio.muted = video.muted; return; }
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
    if (next) next.disabled = index + 1 >= list.length && !shortsSession.cursor;
  };
  const hideGrowHint = () => { growHint.hidden = true; growHint.removeAttribute('aria-busy'); growHint.innerHTML = ''; };
  const showGrowSpinner = () => { growHint.hidden = false; growHint.setAttribute('aria-busy', 'true'); growHint.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading more Shorts…</span>'; };
  const showGrowEnd = () => { growHint.hidden = false; growHint.removeAttribute('aria-busy'); growHint.textContent = 'End of results'; };
  // Once a continuation request fails or yields nothing new, stop asking for
  // more pages on every swipe; the end-of-feed row stays up for this reel.
  let growFailed = false;
  const grow = async () => {
    if (!shortsSession.cursor || growing || disposed || growFailed) return;
    growing = true;
    showGrowSpinner();
    try {
      const params = new URLSearchParams({ continuation: shortsSession.cursor });
      if (shortsSession.query) { params.set('q', shortsSession.query); params.set('shorts', '1'); }
      const data = await api(`${shortsSession.query ? '/api/search' : '/api/shorts'}?${params}`, controller.signal);
      if (disposed || current !== generation) return;
      const before = list.length;
      for (const v of data.videos) if (!list.some(item => item.id === v.id)) list.push(v);
      shortsSession.cursor = data.continuation || '';
      if (list.length === before) { growFailed = true; showGrowEnd(); } else hideGrowHint();
    } catch (error) {
      const stillHere = !disposed && current === generation;
      if (stillHere && error?.name !== 'AbortError') { growFailed = true; showGrowEnd(); } else if (stillHere) hideGrowHint();
    } finally {
      growing = false;
    }
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
  syncTimer = setInterval(() => {
    syncAudio();
    prefetchNext(list[index + 1]?.id);
  }, 1000);
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
        if (shortsSession.query) { params.set('q', shortsSession.query); params.set('shorts', '1'); }
        const data = await api(`${shortsSession.query ? '/api/search' : '/api/shorts'}?${params}`, controller.signal);
        if (disposed || current !== generation) return;
        for (const v of data.videos) if (!shortsSession.items.some(item => item.id === v.id)) shortsSession.items.push(v);
        shortsSession.cursor = data.continuation || '';
        for (const v of data.videos) if (!list.some(item => item.id === v.id)) list.push(v);
        refreshNav();
        prefetchNext(list[index + 1]?.id);
      } catch {}
    })();
  }
  await load(index, { direction: 0 });
}
