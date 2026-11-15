# Dinosour architecture

Dinosour is one codebase shipping three shells: a PWA + Node backend (`server.js`),
a standalone Android app (WebView bundling the same `public/` UI), and an Electron
desktop app (`desktop/main.cjs`, fixed loopback origin 43219, auto-updater).
This document is the map a new contributor needs before touching any of it.

## Layout

- `server.js` — the only backend. Serves the SPA (`public/index.html` + `/app.js`),
  search/suggest/captions/stream proxies, and media chunking (`media-chunks.js`).
  Static routes are also declared in `server.js` (`staticFiles` map); **their count
  must stay in sync with `public/sw.js`'s `SHELL` and, for icons, `manifest.webmanifest`**.
- `youtube-search.js` — anonymous YouTube access (InnerTube). Shared by `server.js`.
  No API key, account or cookie other than consent markers.
- `media-chunks.js` — bounded 1 MB chunked reads through the byte-range proxy with
  one chunk read-ahead and a 64 MB LRU. Suffix/signed range quirks live here; do not
  open-code ranges elsewhere.
- `audio-formats.js` — `selectAudioFormats`, `audioTrackGroups`, `preferredAudio`
  — shared by Node and the Android WebView (assets include it as
  `native/audio-formats.js`). Signed media URLs carry an opaque 24-byte ticket
  issued by `server.js` (see "Request lifecycle").
- `public/app.js` — the single-page client. No build step; plain ES modules inline.
- `desktop/main.cjs` — Electron main. Forks `server.js` as a child (`ELECTRON_RUN_AS_NODE=1`)
  on fixed ports 43219/43220, starts the tray updater and (optionally) the background
  media session mode.
- `android/` — APK builder. Copies `public/` into APK assets via `bundleWebAssets`
  (`android/app/build.gradle`). Android needs no network permission to host its UI;
  YouTube traffic goes through `NativeEngine.java` (youtubedl-android).

## Request lifecycle (playback)

1. User navigates to `#watch=<id>` (or `#short=<id>`).
2. `app.js` `route()` runs, replacing `#main`. `generation` increments; stale async
   writes die because they check `current === generation`.
3. The lite path paints the header: `/api/video-lite` → InnerTube `player` (anonymous,
   ~150–500 ms) returns title/channel/views; the full yt-dlp path
   (`/api/video` → `getVideo`) resolves formats/captions afterwards and rewrites
   `#watch-info`.
4. Each media URL is an opaque ticket (`tickets`, a 24-byte random key stored
   server-side, 6 h TTL, FIFO at 600 entries). `/api/stream/<ticket>` proxies
   bytes; `media-chunks.js` decides between the chunk proxy and open-range
   upstream. The ticket proves no request shape; it's a random index-and-check,
   so it carries no information about the upstream URL.
5. Playback uses one `<video>` + one `<audio>`. The audio element is the loud one on
   watch pages (H.264 video + AAC audio tracks). The Shorts reel keeps two player
   pairs; the idle pair pre-buffers the next Short.
6. `cleanup()` unloads everything on route change; `AbortController` cancels
   in-flight fetches; `dispose` flips a flag every async callback re-checks.

## Routing & focus

`route()` is the only route entry point (hash change / clicks / `route(true)`). It
aborts the previous generation and focuses `#main` (keyboard/AT users land on the
landmark). `#search` always mirrors the hash via `updateSearch()`. `el.search` is debounced 180 ms.

## Caches (all of them)

| Name | Where | TTL (fresh / stale) | Scope |
|---|---|---|---|
| `cached()` | `server.js` | varies per route (5/2/10/30 min) | server responses |
| `infoCache` | client `app.js` | 2 min / — | `/api/video` responses (the whole page needs) |
| `shortInfo` in-flight dedupe | client `app.js` | — | shared promise per video id |
| `shortMetaCache` | `youtube-search.js` | 30 min / — | Shorts grid title/channel/views |
| boot cache | client `app.js` | none (last first page) | feed tiles for instant paint |
| `dinosour.restart.*`, `dinosour.feed.v1:*` | client `app.js` | session / by hand | resume position / boot tiles |
| tickets (`tickets`, `captionTickets`) | `server.js` | FIFO eviction (stream 6h / caption 1h) | signed URLs |
| service worker shell (`dinosour-shell-vN`) | `public/sw.js` | network-first | PWA offline shell |

Rules of thumb: stale entries are safe only when re-validated on use; `/api/video`
deliberately has no stale window because its tickets expire; client LRU eviction is
insertion order.

## Background audio (music mode)

- Android: 1.2.3+ — the app ships an **ACT Lock-Screen music session** via
  `navigator.mediaSession` (WebView→OS bridge). `visibilitychange → hidden` pauses
  the **video** track and keeps the separate **audio** track playing
  (battery/background-limit hygiene); on visible it re-seeks and resumes. A
  foreground `BackgroundAudioService` (`mediaPlayback` FGS type) keeps the process
  alive when the app is backgrounded. `POST_NOTIFICATIONS` is requested at
  runtime on Android 13+.
- Desktop: closing/minimize while media is active hides the window to the tray
  (`hideToTray`). A 1 s `executeJavaScript` poll samples `#video,#audio`.
  `before-quit` resumes normal teardown, or spawns the pending update installer
  with `/S` if one is registered (`update.pending`).

## Security model

Anonymous visitors see only public YouTube data; playback URLs are signed media
tickets (HMAC), never raw `googlevideo` URLs. Non-loopback requests require the
invite cookie (`allowRequest`) except the whitelisted health/download manifest
`/api/ping`, `/app-update.json`, `/download/DinosourWeb.apk`, favicon, manifest and
icons. Nothing about YouTube is bypassed: no sign-in, no paid content restrictions,
no DRM work, no age-gate dodging.

## Build, test & release

- `npm run` lists every task. The default dev flow is `npm start`.
- `npm run test:*` runs one suite. Browser suites (`test:browser`,
  `test:watch-prefetch`, `test:features`) need system Chrome and FFmpeg; live tests
  need network. `test:pwa` re-reads the shell cache name from `sw.js`.
- Android builds need the release keystore (`android/keystore.properties`,
  gitignored) and **fail hard** without it — never signs with debug keys for a
  release.
- Desktop builds: `npm run prepare:desktop` → `npm run build:desktop`.
- Android builds: `npm run build:android` (or `cd android && gradlew.bat
  assembleRelease`), signed by the same key as every prior release.
- `docs/RELEASE.md` — the publish runbook.

## Conventions

- No new dependencies without arguing for them — the app ships dependency-free UI
  (only Playwright/build tooling in `devDependencies`).
- Runtime JS stays ES modules. Shared JS lives in repo root as dual Node/import
  modules (e.g. `audio-formats.js`).
- `console.log` in `app.js` is for emergencies; tests assert on DOM and network
  behavior, not logs.
