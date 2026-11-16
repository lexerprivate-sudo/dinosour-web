// Offline download engine for recorded videos.
//
// Two paths share one public API:
//   - Standalone Android (window.__dinosourStandalone): storage, progress and
//     file serving are owned natively. Every method is a passthrough to
//     window.__dinosourNativeCall. Fixed app-origin paths (/dl/<id>/...) are
//     served by the WebView intercept.
//   - Ordinary desktop/browser: files are stored in the Origin Private File
//     System (OPFS) under a single `downloads/` directory as <id>.video /
//     <id>.audio. Progress lives in a module map (seed metadata is mirrored
//     to localStorage so a reload can still report interrupted/completed
//     downloads). Object URLs created from OPFS Files are disk-backed, so
//     large files never enter memory.
//
// This module has no app dependency: it does not import app.js and may be
// loaded by any screen.

const standalone = typeof window !== 'undefined' && Boolean(window.__dinosourStandalone);

const ID_RE = /^[\w-]{11}$/;
const STORE_KEY = 'dinosour.downloads.v1';
const DOWNLOADS_DIR = 'downloads';

// id -> { id, state, hasAudio, videoBytes, audioBytes, videoExpected, audioExpected,
//         videoDone, audioDone, ext, label, downloadedAt, error, startedAt,
//         controller }
const downloads = new Map();

const assertId = id => {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid video ID.');
  return id;
};
const num = value => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const abortError = () => new DOMException('Cancelled', 'AbortError');

// ---- Persisted meta mirror (localStorage) --------------------------------

const readStore = () => {
  try {
    if (typeof localStorage === 'undefined') return {};
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
};
const writeStore = store => {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch {}
};
const snapshotMeta = entry => ({
  state: entry.state,
  hasAudio: Boolean(entry.hasAudio),
  videoBytes: entry.videoBytes || 0,
  audioBytes: entry.audioBytes || 0,
  videoExpected: entry.videoExpected ?? null,
  audioExpected: entry.audioExpected ?? null,
  videoDone: Boolean(entry.videoDone),
  audioDone: Boolean(entry.audioDone),
  ext: entry.ext ?? null,
  label: entry.label ?? null,
  downloadedAt: entry.downloadedAt ?? null,
  error: entry.error,
});
const persistMeta = (id, meta) => {
  const store = readStore();
  store[id] = meta;
  writeStore(store);
};
const dropStoredMeta = id => {
  const store = readStore();
  if (Object.prototype.hasOwnProperty.call(store, id)) {
    delete store[id];
    writeStore(store);
  }
};

// ---- OPFS helpers ---------------------------------------------------------

const downloadsDir = async (create = false) => {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DOWNLOADS_DIR, { create });
};
// Returns the OPFS File for `name`, or null when it does not exist / OPFS
// is unavailable.
const findFile = async name => {
  try {
    const dir = await downloadsDir(false);
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch { return null; }
};
const removeFile = async name => {
  try {
    const dir = await downloadsDir(false);
    await dir.removeEntry(name);
  } catch { /* missing or unavailable is fine */ }
};
const cleanupFiles = async id => {
  await removeFile(`${id}.video`);
  await removeFile(`${id}.audio`);
};

// ---- Friendly errors -------------------------------------------------------

const httpError = status => (status === 410 || status === 404
  ? new Error('Playback link expired. Reopen the video.')
  : new Error('YouTube refused the media stream. Reopen the video to retry.'));
const NETWORK_MESSAGE = 'Check your Wi-Fi or mobile data and try again.';
const friendlyFetchError = error => {
  const message = String(error?.message || '');
  if (message === 'Playback link expired. Reopen the video.'
    || message === 'YouTube refused the media stream. Reopen the video to retry.') return error;
  if (/quota|QuotaExceeded/i.test(message)) return new Error('Not enough storage. Free up space and try again.');
  return new Error(NETWORK_MESSAGE);
};
const friendlyError = error => {
  if (error?.name === 'AbortError') return 'The download was cancelled.';
  const message = String(error?.message || '');
  if (['Playback link expired. Reopen the video.',
       'YouTube refused the media stream. Reopen the video to retry.',
       NETWORK_MESSAGE,
       'Not enough storage. Free up space and try again.'].includes(message)) return message;
  if (/quota|QuotaExceeded/i.test(message)) return 'Not enough storage. Free up space and try again.';
  return 'The download failed. Try again.';
};

// Whether an audio file is expected on disk for this entry. Metas persisted
// before hasAudio existed are inferred from the audio sizes.
const expectsAudioFile = entry => Boolean(
  entry?.hasAudio ?? (((entry?.audioExpected ?? 0) > 0) || ((entry?.audioBytes ?? 0) > 0)),
);

// ---- Stat snapshots ---------------------------------------------------------

const missingStat = () => ({
  state: 'missing',
  videoBytes: 0,
  audioBytes: 0,
  videoExpected: null,
  audioExpected: null,
  videoDone: false,
  audioDone: false,
  progress: null,
});
const totals = (videoBytes, audioBytes, videoExpected, audioExpected) => {
  const expected = (videoExpected || 0) + (audioExpected || 0);
  const received = videoBytes + audioBytes;
  return { expected, received };
};
const snapshotStat = entry => {
  const videoBytes = entry.videoBytes || 0;
  const audioBytes = entry.audioBytes || 0;
  const videoExpected = entry.videoExpected ?? null;
  const audioExpected = entry.audioExpected ?? null;
  const { expected, received } = totals(videoBytes, audioBytes, videoExpected, audioExpected);
  const done = entry.state === 'done';
  const progress = done
    ? 1
    : expected > 0 ? Math.min(1, received / expected) : null;
  const stat = {
    state: entry.state,
    videoBytes,
    audioBytes,
    videoExpected,
    audioExpected,
    videoDone: Boolean(entry.videoDone),
    audioDone: Boolean(entry.audioDone),
    progress,
  };
  if (entry.error) stat.error = entry.error;
  return stat;
};

// ---- Download pipeline ------------------------------------------------------

// Streams one part to the OPFS swap file. Tries each source in order (used
// for the audio primary + fallbacks). Returns { bytes, ext }.
const fetchPart = async (entry, dir, part, sources, controller) => {
  const name = `${entry.id}.${part}`;
  const bytesKey = part === 'video' ? 'videoBytes' : 'audioBytes';
  const expectedKey = part === 'video' ? 'videoExpected' : 'audioExpected';
  let lastError = null;
  for (const src of sources) {
    entry[bytesKey] = 0;
    try {
      const response = await fetch(src, { signal: controller.signal });
      if (!response.ok || !response.body) {
        lastError = httpError(response.status);
        continue;
      }
      const length = num(response.headers.get('content-length'));
      if (length !== null) entry[expectedKey] = length;
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      let received = 0;
      try {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          received += value.byteLength;
          entry[bytesKey] = received;
        }
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const ext = contentType.includes('webm') ? 'webm' : 'mp4';
      return { bytes: received, ext };
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') throw abortError();
      lastError = friendlyFetchError(error);
    }
  }
  throw lastError || new Error(NETWORK_MESSAGE);
};

const runDownload = async (entry, { videoSources, audioSources }) => {
  const { id, controller } = entry;
  try {
    const dir = await downloadsDir(true);
    const video = await fetchPart(entry, dir, 'video', videoSources, controller);
    entry.videoBytes = video.bytes;
    entry.videoDone = true;
    entry.ext = video.ext;
    if (audioSources) {
      const audio = await fetchPart(entry, dir, 'audio', audioSources, controller);
      entry.audioBytes = audio.bytes;
      entry.audioDone = true;
    }
    if (controller.signal.aborted) throw abortError();
    entry.state = 'done';
    entry.downloadedAt = Date.now();
    entry.error = undefined;
    entry.controller = null;
    if (downloads.get(id) === entry) persistMeta(id, snapshotMeta(entry));
  } catch (error) {
    await cleanupFiles(id);
    entry.controller = null;
    entry.videoBytes = 0;
    entry.audioBytes = 0;
    if (controller.signal.aborted) {
      entry.state = 'cancelled';
      entry.error = undefined;
      if (downloads.get(id) === entry) dropStoredMeta(id);
    } else {
      entry.state = 'failed';
      entry.error = friendlyError(error);
      if (downloads.get(id) === entry) persistMeta(id, snapshotMeta(entry));
    }
  }
};

// ---- Public API --------------------------------------------------------------

function supported() {
  if (standalone) return { ok: true };
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (storage && typeof storage.getDirectory === 'function' && typeof storage.estimate === 'function') {
    return { ok: true };
  }
  return { ok: false, reason: 'This browser cannot store videos offline.' };
}

async function start({ id, info, height } = {}) {
  assertId(id);
  if (standalone) return window.__dinosourNativeCall('download', { id, height });
  const support = supported();
  if (!support.ok) throw new Error(support.reason || 'This browser cannot store videos offline.');

  const existing = downloads.get(id);
  if (existing?.state === 'downloading') return { state: 'downloading' };

  const qualities = (Array.isArray(info?.qualities) ? info.qualities : [])
    .map(q => (q && typeof q === 'object' ? { ...q, height: num(q.height) } : null))
    .filter(q => q && q.height && typeof q.src === 'string' && q.src);
  if (!qualities.length) throw new Error('No compatible stream is available for this video.');

  let chosen = null;
  if (height !== undefined && height !== null) {
    const wanted = num(height);
    chosen = wanted === null ? null : qualities.find(q => q.height === wanted) || null;
    if (!chosen) throw new Error('That quality is not available.');
  } else {
    chosen = qualities.reduce((best, q) => (!best || q.height > best.height ? q : best), null);
  }

  let audio = null;
  if (chosen.separateAudio) {
    if (typeof info?.audio !== 'string' || !info.audio) {
      throw new Error('No audio stream is available for this video.');
    }
    const fallbacks = (Array.isArray(info.audioFallbacks) ? info.audioFallbacks : [])
      .filter(u => typeof u === 'string' && u);
    audio = { sources: [info.audio, ...fallbacks], size: num(info.audioSize) };
  }

  const videoSize = num(chosen.size);
  const expectedBytes = (videoSize || 0) + ((audio && audio.size) || 0);
  const estimateResult = await navigator.storage.estimate().catch(() => null);
  const usage = num(estimateResult?.usage) ?? 0;
  const quota = num(estimateResult?.quota) ?? 0;
  if (quota > 0 && usage + expectedBytes > quota * 0.95) {
    throw new Error('Not enough storage. Free up space and try again.');
  }

  const entry = {
    id,
    state: 'downloading',
    hasAudio: Boolean(audio),
    videoBytes: 0,
    audioBytes: 0,
    videoExpected: videoSize,
    audioExpected: audio ? audio.size : null,
    videoDone: false,
    audioDone: !audio,
    ext: null,
    label: `${chosen.height}p`,
    downloadedAt: null,
    error: undefined,
    startedAt: Date.now(),
    controller: new AbortController(),
  };
  downloads.set(id, entry);
  persistMeta(id, snapshotMeta(entry));

  const videoSources = [chosen.src];
  const audioSources = audio ? audio.sources : null;
  runDownload(entry, { videoSources, audioSources }).catch(() => {});
  return { state: 'downloading' };
}

async function stat(id) {
  assertId(id);
  if (standalone) return window.__dinosourNativeCall('download-stat', { id });

  const entry = downloads.get(id);
  if (!entry) {
    const videoFile = await findFile(`${id}.video`);
    if (!videoFile) return missingStat();
    // Files on disk but no metadata (e.g. localStorage was cleared): best effort.
    const audioFile = await findFile(`${id}.audio`);
    return {
      state: 'done',
      videoBytes: videoFile.size,
      audioBytes: audioFile?.size ?? 0,
      videoExpected: videoFile.size,
      audioExpected: audioFile?.size ?? null,
      videoDone: true,
      audioDone: true,
      progress: 1,
    };
  }

  if (entry.state === 'done') {
    // Verify against OPFS: a file deleted externally means there is no download.
    const videoFile = await findFile(`${id}.video`);
    const audioNeeded = expectsAudioFile(entry);
    const audioFile = audioNeeded ? await findFile(`${id}.audio`) : null;
    if (!videoFile || (audioNeeded && !audioFile)) {
      downloads.delete(id);
      dropStoredMeta(id);
      return missingStat();
    }
    entry.videoBytes = videoFile.size;
    if (audioFile) entry.audioBytes = audioFile.size;
  }
  return snapshotStat(entry);
}

async function cancel(id) {
  assertId(id);
  if (standalone) return window.__dinosourNativeCall('download-cancel', { id });

  const entry = downloads.get(id);
  if (entry?.state === 'done') return { state: 'done' };
  if (entry) {
    entry.state = 'cancelled';
    entry.error = undefined;
    entry.controller?.abort();
    entry.controller = null;
  } else {
    downloads.set(id, {
      id, state: 'cancelled', hasAudio: false, videoBytes: 0, audioBytes: 0,
      videoExpected: null, audioExpected: null, videoDone: false, audioDone: false,
      ext: null, label: null, downloadedAt: null, error: undefined,
      startedAt: Date.now(), controller: null,
    });
  }
  dropStoredMeta(id);
  await cleanupFiles(id);
  return { state: 'cancelled' };
}

async function deleteDownload(id) {
  assertId(id);
  if (standalone) return window.__dinosourNativeCall('download-delete', { id });

  const entry = downloads.get(id);
  if (entry) {
    entry.controller?.abort();
    downloads.delete(id);
  }
  dropStoredMeta(id);
  await cleanupFiles(id);
  return { state: 'missing' };
}

async function objectUrls(id /*, info */) {
  assertId(id);
  if (standalone) {
    try {
      const status = await window.__dinosourNativeCall('download-stat', { id });
      if (!status || status.state !== 'done') return { done: false };
    } catch { return { done: false }; }
    return { video: `/dl/${id}/video`, audio: `/dl/${id}/audio`, done: true };
  }

  const entry = downloads.get(id);
  if (entry?.state === 'downloading') return { done: false };
  const videoFile = await findFile(`${id}.video`);
  if (!videoFile) return { done: false };
  const audioFile = await findFile(`${id}.audio`);
  if (expectsAudioFile(entry) && !audioFile) return { done: false };
  return {
    video: URL.createObjectURL(videoFile),
    audio: audioFile ? URL.createObjectURL(audioFile) : null,
    done: true,
  };
}

async function estimate() {
  if (standalone) return { usage: 0, quota: 0 };
  try {
    const result = await navigator.storage.estimate();
    return { usage: Number(result?.usage) || 0, quota: Number(result?.quota) || 0 };
  } catch {
    throw new Error('Storage information is unavailable.');
  }
}

export const LocalDownloads = {
  supported,
  start,
  stat,
  cancel,
  delete: deleteDownload,
  objectUrls,
  estimate,
};

export default LocalDownloads;

// Hydrate metadata persisted by earlier sessions. Entries that were mid-flight
// when the page died are marked failed and their partial files removed.
if (!standalone) {
  try {
    const stored = readStore();
    for (const [id, meta] of Object.entries(stored)) {
      if (!ID_RE.test(id) || !meta || typeof meta !== 'object') continue;
      if (meta.state === 'downloading') {
        const interrupted = {
          id, state: 'failed',
          hasAudio: Boolean(meta.hasAudio),
          videoBytes: 0, audioBytes: 0,
          videoExpected: meta.videoExpected ?? null, audioExpected: meta.audioExpected ?? null,
          videoDone: false, audioDone: false,
          ext: meta.ext ?? null, label: meta.label ?? null, downloadedAt: null,
          error: 'The download was interrupted.',
          startedAt: meta.downloadedAt ?? Date.now(), controller: null,
        };
        downloads.set(id, interrupted);
        persistMeta(id, snapshotMeta(interrupted));
        cleanupFiles(id).catch(() => {});
        continue;
      }
      if (meta.state !== 'done' && meta.state !== 'failed' && meta.state !== 'cancelled') continue;
      downloads.set(id, {
        id,
        state: meta.state,
        hasAudio: Boolean(meta.hasAudio ?? (((meta.audioExpected ?? 0) > 0) || ((meta.audioBytes ?? 0) > 0))),
        videoBytes: Number(meta.videoBytes) || 0,
        audioBytes: Number(meta.audioBytes) || 0,
        videoExpected: meta.videoExpected ?? null,
        audioExpected: meta.audioExpected ?? null,
        videoDone: Boolean(meta.videoDone),
        audioDone: Boolean(meta.audioDone),
        ext: meta.ext ?? null,
        label: meta.label ?? null,
        downloadedAt: meta.downloadedAt ?? null,
        error: typeof meta.error === 'string' ? meta.error : undefined,
        startedAt: meta.downloadedAt ?? Date.now(),
        controller: null,
      });
    }
  } catch { /* storage unavailable; session-only tracking */ }
}
