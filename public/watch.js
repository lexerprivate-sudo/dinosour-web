// Dinosour watch page, lazy-loaded by route() on the first #watch=<id> visit.
// The entry bundle never parses this module; it only rides along as an
// on-demand import.
import { $, icon, escape, views, api, toast, preferences, savePreferences, shortInfo, preferredAudio, bufferedAhead } from './playback-core.js';
import { LocalDownloads } from '/downloads.js';
import { library, videos, remember, compact, persist, generation, card, skeleton, synthesizeOfflineInfo, qualityOptions, speedOptions, bindInfoActions, paintDownloadControls, startQuality, renderQueue, enableMiniPlayer, discardWarmWatch, warmNextWatch, autoRetryCount, warmIntentTimer, warmWatch, activeObjectUrls, playbackBufferAhead, setPlaybackBusy, setPlaybackBufferAhead, setDownloadsWatchInfo, setActiveObjectUrls, claimWarmWatch, setRouteCleanup, releasePlaybackState } from './app.js';

const main = $('#main');

export async function watch(id, current, controller, refresh) {
  const watchStarted = performance.now();
  setPlaybackBusy(true); setPlaybackBufferAhead(0);
  clearTimeout(warmIntentTimer);
  const warmed = !refresh && warmWatch?.id === id ? warmWatch : null;
  if (warmed) { clearTimeout(warmed.expiry); claimWarmWatch(); }
  else discardWarmWatch();
  main.className = 'watch-page';
  main.innerHTML = `<div class="watch-layout"><section class="watch-primary"><div class="player-shell"><video id="video" controls playsinline preload="auto"></video><audio id="audio" preload="auto"></audio><div id="player-status" class="player-status" hidden></div></div><div id="watch-info"></div></section><aside class="watch-related" aria-label="Up next and related"><h2>More to watch</h2><div id="related">${skeleton()}</div></aside></div>`;
  if (warmed) {
    warmed.video.id = 'video'; warmed.audio.id = 'audio';
    $('#video').replaceWith(warmed.video); $('#audio').replaceWith(warmed.audio);
  }
  const video = $('#video'), audio = $('#audio'), status = $('#player-status');
  const preview = videos.get(id);
  // Paint the header from the lightweight public player response (usually
  // under a second) while yt-dlp resolves the actual streams; yt-dlp's answer
  // replaces this panel when it arrives.
  api(`/api/video-lite?id=${encodeURIComponent(id)}`, controller.signal).then(lite => {
    if (disposed || !lite) return;
    setMediaMetadata(lite.title, lite.channel);
    const info = $('#watch-info');
    if (info && !info.innerHTML.trim()) {
      info.innerHTML = `<h1 class="watch-title">${escape(lite.title)}</h1><p class="description-preview"><strong>${escape(lite.channel)}</strong>${lite.views ? ` · ${escape(views(lite.views))}` : ''}</p>`;
    }
    const caption = loading.querySelector('.watch-loading-caption span:last-child');
    if (caption && caption.textContent === 'Preparing playback') caption.textContent = lite.title;
  }).catch(() => {});
  video.poster = preview?.thumb || `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  video.controls = false;
  const loading = document.createElement('div');
  loading.className = 'watch-loading';
  loading.setAttribute('role', 'status');
  loading.innerHTML = `<img src="${escape(video.poster)}" alt="" onerror="this.style.display='none'"><div class="watch-loading-caption"><svg class="watch-progress" viewBox="0 0 80 80" role="progressbar" aria-label="Buffering" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><circle class="watch-progress-track" cx="40" cy="40" r="34"/><circle class="watch-progress-fill" cx="40" cy="40" r="34"/><text class="watch-progress-pct" x="40" y="40" text-anchor="middle">0</text></svg><strong>Getting your video ready…</strong><span>${escape(preview?.title || 'Preparing playback')}</span></div>`;
  video.parentElement.append(loading);
  const bufferHint = document.createElement('div');
  bufferHint.className = 'watch-buffer-hint'; bufferHint.hidden = true;
  bufferHint.setAttribute('role', 'status'); bufferHint.textContent = 'Buffering…';
  video.parentElement.append(bufferHint);
  let waitingTimer, stallTimer, hasFrame = false, switching = false, playingIntent = true, audioBuffering = false, ignorePause = false;
  let reloadStreams, captionRequest = 0, captionBlob = null;
  let metadataMs = 0, firstFrameMs = 0, rebuffers = 0, recoveries = 0, qualityLoads = 0, statsTimer = null;
  let consecutiveStalls = 0; // consecutive 8s stall-timer fires with no playback resume
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
    clearInterval(bufferTimer);
    clearTimeout(waitingTimer); bufferHint.hidden = true;
  };
  const bufferFill = () => {
    const fill = loading.querySelector('.watch-progress-fill');
    const pct = loading.querySelector('.watch-progress-pct');
    const ring = loading.querySelector('.watch-progress');
    if (!fill) return;
    let buffered = 0;
    try { if (video.buffered && video.buffered.length) buffered = video.buffered.end(video.buffered.length - 1) - video.currentTime; } catch {}
    const target = Math.min(8, video.duration || 8);
    const fraction = Math.max(0, Math.min(1, buffered / target)); // ready against ~first 8 s of playback
    const indeterminate = fraction === 0; // no meaningful buffered data yet (metadata / first-byte phase)
    const circumference = 2 * Math.PI * 34;
    // In indeterminate mode draw a ~35% arc so the rotating sweep reads as a
    // healthy "working" signal instead of a static empty ring. The CSS agent
    // owns .watch-progress--zero (light pulse keyframe); .indeterminate stays
    // as the fallback so the ring keeps sweeping even without that CSS.
    fill.style.strokeDashoffset = String(circumference * (indeterminate ? 0.65 : 1 - fraction));
    if (pct) pct.textContent = String(Math.round(fraction * 100) + '%');
    if (ring) {
      ring.classList.toggle('indeterminate', indeterminate);
      ring.classList.toggle('watch-progress--zero', indeterminate);
      ring.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    }
  };
  const bufferTimer = setInterval(bufferFill, 200);
  // Watchdog: if within 25s of opening the page the video has not advanced to
  // a playable state and no retry is in flight, give the user a way forward.
  // Based on first-frame/readyState, not on `paused` — a video whose play was
  // honoured but never gets a frame is the "keeps loading forever" case.
  const watchdog = setTimeout(() => {
    if (disposed || firstFrameMs || switching || video.readyState >= 2) return;
    showError('The video did not start in time. It may be region-locked, unavailable, or your network is too slow.');
  }, 25000);

  const showBuffering = () => {
    clearTimeout(waitingTimer);
    if (hasFrame) waitingTimer = setTimeout(() => {
      if (!disposed && !video.paused && video.readyState < 3) bufferHint.hidden = false;
    }, 500);
  };
  const clearStatus = () => { status.innerHTML = ''; status.hidden = true; };
  const showStatus = html => { status.innerHTML = html; status.hidden = false; };
  let disposed = false, syncTimer, lastSave = 0, separate = false, info, audioFallbacks = [], audioIndex = 0, healthySince = 0, retrying = false, errorShown = false;
  // Background listening: when the app goes away, hold only the audio track.
  // The video decoder would idle-burn battery and risk background killers,
  // while audio alone is exactly what a "music" session needs.
  let backgroundAudioHold = false;
  // Media Session: the same API the real YouTube/Spotify clients use. Android
  // maps it to a native MediaSession for WebView pages, which is what makes
  // the notification and lockscreen show track info and working controls.
  const advanceToNext = () => {
    const next = library.queue.shift() || videos.get($('#related a[href^="#watch="]')?.getAttribute('href')?.slice(7));
    persist(); renderQueue();
    if (next && next.id !== id) location.hash = `#watch=${next.id}`;
  };
  const setMediaMetadata = (title, channel) => {
    if (!('mediaSession' in navigator) || !title) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: channel || 'Dinosour',
        album: 'Dinosour',
        artwork: [{ src: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }],
      });
      navigator.mediaSession.playbackState = video.paused ? 'paused' : 'playing';
    } catch { /* media session unavailable */ }
  };
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => video.play());
      navigator.mediaSession.setActionHandler('pause', () => video.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => history.back());
      navigator.mediaSession.setActionHandler('nexttrack', advanceToNext);
    } catch { /* media session unavailable */ }
  }
  const onVisibility = () => {
    if (document.hidden) {
      if (!disposed && !audio.paused && !video.paused) {
        ignorePause = true;
        video.pause();
        backgroundAudioHold = true;
      }
    } else if (backgroundAudioHold && !disposed) {
      backgroundAudioHold = false;
      video.currentTime = audio.currentTime;
      if (playingIntent) video.play().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  const saveProgress = () => {
    if (!info || video.currentTime < 1) return;
    library.history = [{ ...compact(info), position: video.ended ? 0 : video.currentTime, duration: video.duration || info.duration || 0, watchedAt: Date.now() }, ...library.history.filter(v => v.id !== id)].slice(0, 200);
    persist();
  };
  setRouteCleanup(() => {
    saveProgress(); disposed = true; clearInterval(syncTimer); clearTimeout(waitingTimer); clearTimeout(stallTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    clearInterval(statsTimer); clearInterval(bufferTimer); $('#stats-dialog')?.remove();
    releasePlaybackState();
    captionRequest++; if (captionBlob) URL.revokeObjectURL(captionBlob);
    for (const url of activeObjectUrls) URL.revokeObjectURL?.(url);
    setActiveObjectUrls([]);
    setDownloadsWatchInfo(null);
    warmed?.controller.abort();
    video.pause(); audio.pause();
    video.removeAttribute('src'); audio.removeAttribute('src'); video.load(); audio.load();
  });
  const showError = message => {
    if (disposed) return;
    // First-write-wins: the underlying cause shown earlier (e.g. a server-side
    // reason) must not be replaced by the generic watchdog text.
    if (errorShown) {
      loading.hidden = true; bufferHint.hidden = true;
      clearTimeout(waitingTimer); clearTimeout(stallTimer); setPlaybackBusy(false);
      video.pause(); audio.pause();
      return;
    }
    errorShown = true;
    clearInterval(bufferTimer);
    loading.hidden = true; bufferHint.hidden = true; clearTimeout(waitingTimer);
    clearTimeout(stallTimer); setPlaybackBusy(false);
    video.pause(); audio.pause();
    $('#unmute')?.remove();
    showStatus(`<div><h2>Couldn't play this one.</h2><p>${escape(message)}</p><button data-retry>Retry video</button></div>`);
  };
  const retryPlayback = async message => {
    if (disposed || retrying) return;
    if ((autoRetryCount.get(id) || 0) >= 2) {
      // Terminal state: keep the message, but guarantee the overlay/hint are hidden
      // and showError's Retry button is the visible way forward.
      loading.hidden = true; bufferHint.hidden = true;
      return showError(`${message} Retry to request a fresh stream.`);
    }
    retrying = true; recoveries++;
    autoRetryCount.set(id, (autoRetryCount.get(id) || 0) + 1);
    const position = video.currentTime;
    if (info && position >= 1) {
      library.history = [{ ...compact(info), position, duration: video.duration || info.duration || 0, watchedAt: Date.now() }, ...library.history.filter(v => v.id !== id)].slice(0, 200);
      persist();
    }
    freezeFrame(); setPlaybackBusy(true); discardWarmWatch();
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
  // Prefer a completed local copy — no network at all, instant, works offline.
  const downloadsEntry = (library.downloads || []).find(d => d.id === id);
  let localUrls = null;
  setActiveObjectUrls([]);
  if (downloadsEntry?.state === 'done') {
    try { const urls = await LocalDownloads.objectUrls(id); if (urls?.done) { localUrls = urls; setActiveObjectUrls([urls.video, urls.audio].filter(Boolean)); } } catch { /* fall back to network streams */ }
  }
  try {
    info = localUrls
      ? synthesizeOfflineInfo(id, downloadsEntry, localUrls)
      : warmed
        ? await warmed.promise.catch(() => api(`/api/video?id=${id}`, controller.signal))
        : await shortInfo(id, controller.signal, refresh);
    metadataMs = performance.now() - watchStarted;
    if (current !== generation) return;
    // Defense in depth: only English caption tracks ever reach the UI,
    // even if an older bundled server hands us the unfiltered list.
    if (Array.isArray(info.captions)) info.captions = info.captions.filter(t => /^en([-_][a-z0-9-]*)?$/i.test(String(t?.language || '')));
    remember(info);
    video.poster = info.thumb || video.poster;
    document.title = `${info.title} — Dinosour`;
    const restartKey = `dinosour.restart.${id}`;
    const savedPosition = sessionStorage.getItem(restartKey) ? 0 : (library.history.find(v => v.id === id)?.position || 0);
    sessionStorage.removeItem(restartKey);
    setMediaMetadata(info.title, info.channel);
    $('#watch-info').innerHTML = `<h1 class="watch-title">${escape(info.title)}</h1><div class="watch-actions"><div class="channel"><span class="avatar">${escape(info.channel[0])}</span><div><strong>${escape(info.channel)}</strong><span>YouTube channel</span></div></div><button id="like" aria-pressed="${library.liked.some(v => v.id === id)}" class="${library.liked.some(v => v.id === id) ? 'selected' : ''}">${icon('like')}Like</button><button id="save" aria-pressed="${library.saved.some(v => v.id === id)}" class="${library.saved.some(v => v.id === id) ? 'selected' : ''}">${icon('save')}Save</button><button id="save-to">${icon('library')}Save to…</button><button id="download-toggle" data-download-toggle="${id}" aria-label="Download this video for offline playback" title="Download for offline playback">${icon('download')}Download</button><button id="delete-download" data-delete-download="${id}" class="icon-button" aria-label="Delete downloaded video" title="Delete download" hidden>${icon('trash')}</button><button id="share">${icon('share')}Share</button></div><div class="player-tools"><span>Playback</span><div class="volume-control"><button type="button" id="mute-toggle" class="volume-button" aria-label="Mute" title="Mute">${icon('volume')}</button><input id="volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume"></div><label>Quality <select id="quality" aria-label="Video quality">${qualityOptions(info)}</select></label><label>Speed <select id="speed" aria-label="Playback speed">${speedOptions()}</select></label></div><div class="description"><p><strong>${views(info.views)}${info.published ? ` · ${escape(info.published.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))}` : ''}</strong></p><p class="description-preview">${escape((info.description || 'No description available.').split('\n').filter(Boolean).slice(0, 2).join('\n'))}</p><details><summary>Show more</summary><p>${escape(info.description || 'No description available.')}</p><p class="playback-note">Direct playback of public videos. Creator sponsorships within videos remain. Restricted videos and live streams may be unavailable.</p></details></div><p class="shortcuts">Space to pause · ← / → to seek · F for fullscreen</p>`;
    bindInfoActions(id);
    setDownloadsWatchInfo(info);
    paintDownloadControls(id);
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
      $('#captions').closest('label')?.toggleAttribute('hidden', !(info.captions || []).length);
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
        if (!disposed && request === captionRequest && error.name !== 'AbortError') {
        toast(error.message);
        $('#captions').value = '';
        preferences.captions = '';
        savePreferences();
      }
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
      window.__dinosourStats = { metadataMs, firstFrameMs, rebuffers, recoveries, qualityLoads, buffer: playbackBufferAhead, warmReady: Boolean(warmed?.ready) };
    };
    $('#stats-toggle').onclick = () => {
      statsDialog.showModal(); updateStats();
      clearInterval(statsTimer); statsTimer = setInterval(updateStats, 1000);
    };
    statsDialog.addEventListener('close', () => clearInterval(statsTimer));
    const syncAudio = () => {
      if (!separate || disposed) return;
      // When the background hold hides the app and pauses the video track,
      // let audio run free — do not rewind to the frozen video clock.
      if (backgroundAudioHold) { audio.playbackRate = video.playbackRate; audio.volume = video.volume; audio.muted = video.muted; return; }
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
      setPlaybackBusy(true); setPlaybackBufferAhead(0);
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
        else { switching = false; setPlaybackBusy(false); }
      };
      video.onloadedmetadata = restorePosition;
      if (video.readyState >= 1) restorePosition();
      if (autoplay && !position) startPlayback(); else clearStatus();
    };
    reloadStreams = (fresh, position, autoplay) => {
      const height = info.qualities[selectedQuality].height;
      info = fresh; audioTrack = preferredAudio(info);
      if (Array.isArray(info.captions)) info.captions = info.captions.filter(t => /^en([-_][a-z0-9-]*)?$/i.test(String(t?.language || '')));
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
    video.onplay = () => {
      playingIntent = true; if (video.readyState >= 3) playAudio();
      // Any play intent (autoplay, #start-play button, Space/k): warm the queued
      // next video now, before any buffering exists. No-ops once one is warm.
      warmNextWatch(id, true);
    };
    video.onplaying = () => {
      switching = false; setPlaybackBusy(false); clearTimeout(stallTimer); clearTimeout(watchdog);
      if (!firstFrameMs) firstFrameMs = performance.now() - watchStarted;
      bufferHint.textContent = 'Buffering…'; hideLoading(); clearStatus(); playAudio(); healthySince = Date.now(); consecutiveStalls = 0;
    };
    audio.onplaying = () => { $('#unmute')?.remove(); };
    audio.onwaiting = () => {
      if (!separate || disposed || retrying || switching || video.paused || video.seeking) return;
      audioBuffering = true; setPlaybackBusy(true);
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
      audio.pause(); healthySince = 0; setPlaybackBusy(true); rebuffers++; showBuffering();
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (disposed || !playingIntent || video.readyState >= 3) return;
        consecutiveStalls += 1;
        if (consecutiveStalls >= 3) return showError('Playback is too stalled on this connection — try a lower quality manually or retry.');
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
      clearTimeout(waitingTimer);
      loading.hidden = true; bufferHint.hidden = true; frozenFrame.hidden = true;
      // When no navigation happens, release the busy/buffer state so the next
      // manual interaction starts fresh (the navigate path is reset by cleanup()).
      const resetPlaybackState = () => { releasePlaybackState(); };
      if (!preferences.autoplay) { resetPlaybackState(); return; }
      const href = $('#related a[href^="#watch="]')?.getAttribute('href') || '';
      const relatedId = href.match(/^#watch=([\w-]{11})$/)?.[1];
      const next = library.queue.shift() || (relatedId ? videos.get(relatedId) : undefined);
      persist(); renderQueue();
      if (next && next.id !== id) location.hash = `#watch=${next.id}`;
      else resetPlaybackState();
    };
    video.ontimeupdate = () => {
      if (healthySince && Date.now() - healthySince > 10000) autoRetryCount.delete(id);
      if (Date.now() - lastSave > 5000) { saveProgress(); lastSave = Date.now(); }
    };
    syncTimer = setInterval(() => {
      syncAudio();
      setPlaybackBufferAhead(Math.min(bufferedAhead(video), separate ? bufferedAhead(audio) : Infinity));
      if (playbackBufferAhead < 3) { /* hold warm buffer; it recovers */ }
      // Once this video reaches a healthy buffer, hold a warm pair ready for
      // the next queue/related video. prepareWatch dedupes, so a shifted queue re-warms.
      warmNextWatch(id);
      // Yield to the current stream. YouTube throttles extra concurrent
      // connections from one IP, so while the active video is starved (or not
      // playing yet) the warm pair stops downloading instead of stealing its
      // budget; it resumes once the main buffer recovers or when paused.
      if (warmWatch) {
        const low = !video.paused && video.readyState < 4 && playbackBufferAhead < 10;
        const preload = low ? 'none' : 'auto';
        if (warmWatch.video.preload !== preload) { warmWatch.video.preload = preload; warmWatch.audio.preload = preload; }
      }
      // Progressive MP4 sources cannot switch quality seamlessly. Raising the
      // quality here discarded a healthy buffer every 25 seconds. Keep Auto
      // stable; its stall handler can still lower quality when necessary.
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
