# Dinosour architecture

Dinosour is one codebase shipping three shells: a PWA + Node backend (`server.js`),
a standalone Android app (WebView bundling the same `public/` UI), and an Electron
desktop app (`desktop/main.cjs`, fixed loopback origin 43219, auto-updater).
This document is the map a new contributor needs before touching any of it.

## Layout

- `server.js` — the only backend. Serves the SPA (`public/index.html` + `/app.js`),
  search/suggest/captions/stream proxies, media chunking (`media-chunks.js`), and the
  static `files` map. The service worker's `SHELL` in `public/sw.js` must reference
  every file present in that map and in `manifest.webmanifest` for offline use.
- `youtube-search.js` — anonymous YouTube access (InnerTube). Shared by `server.js`.
  No API key, account or cookie other than consent markers.
- `media-chunks.js` — bounded 1 MB chunked reads through the byte-range proxy with
  one chunk read-ahead and a 64 MB LRU. Suffix/signed range quirks live here; do not
  open-code ranges elsewhere.
- `audio-formats.js` — `selectAudioFormats`, `audioTrackGroups` — shared by Node
  and the Android WebView (assets include it as `native/audio-formats.js`). Media URLs
  carry an opaque 24-byte ticket issued by `server.js` (see "Request lifecycle").
- `public/app.js` — the single-page client and its router. No build step; plain ES
  modules. The entry bundle imports `public/playback-core.js` (shared playback
  kernel: DOM helpers, the stale-while-revalidate `shortInfo` metadata cache)
  statically and lazy-imports `public/reel.js` (the Shorts reel) on the first
  `#short=` visit. `public/startup.js` is a classic script: the parse-time theme
  bootstrap must stay ES5-compatible, and it paints a no-network fallback card
  when the main app never signals readiness. `public/native.js` /
  `public/native-api.js` shim the Android bridge.
- `public/downloads.js` — the offline download engine behind one `LocalDownloads`
  API (see "Offline downloads"). Independent of `app.js`; loaded by it.
- `desktop/main.cjs` — Electron main. Forks `server.js` as a child (`ELECTRON_RUN_AS_NODE=1`)
  on fixed ports 43219/43220. The tray icon is created lazily on a window close with
  media playing; the GitHub-releases-based updater lives in the same file.
- `android/` — APK builder. Copies `public/` into APK assets via `bundleWebAssets`
  (`android/app/build.gradle`). The APK declares INTERNET and related permissions;
  YouTube traffic goes through `NativeEngine.java` (youtubedl-android); offline
  downloads are native yt-dlp transfers in the same engine.

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

`media-chunks.js` serves `/api/stream/<ticket>` media as bounded 1 MB byte-range
windows against the upstream CDN (range-less requests fall back to the open
upstream path in `server.js`; the chunked path caps every read at 1 MB), with one
chunk of read-ahead per active track (at most two speculative requests total) and
a shared 64 MB LRU cache that holds only fully validated chunks. The bound is
deliberate: YouTube's CDN edges throttle open-ended downloads and extra concurrent
connections from one IP, so the proxy keeps its per-IP concurrency footprint small.
The same per-IP budget is the designed reason for the client-side yield during
playback: while the active video is starved (playing, not yet fully ready, under
10 s of buffer ahead), the warmed next-video pair sets `preload` to `none` instead
of competing with the current stream for CDN connections, and resumes once the
buffer recovers or playback pauses.

## Offline downloads

The watch page has a Download button (`#download-toggle` / `data-download-toggle`)
that opens a quality picker dialog with per-quality sizes. Video and audio are
always stored as separate files and played back together — the same split as
streamed playback. Two engines sit behind one API, `LocalDownloads` in
`public/downloads.js`:

- **Browser / desktop:** files live in the Origin Private File System under a
  `downloads/` directory as `<id>.video` / `<id>.audio`. Progress lives in a
  module-level map; a metadata mirror in `localStorage` (`dinosour.downloads.v1`)
  lets a reload report interrupted or completed downloads. Object URLs are
  disk-backed, so large files never enter memory.
- **Android (standalone app):** every `LocalDownloads` method is a passthrough to
  `window.__dinosourNativeCall('download' | 'download-stat' | 'download-cancel' |
  'download-delete', …)`. `NativeEngine.java` runs one yt-dlp transfer per track
  (video first, then audio) on a single-thread download pool with an eight-slot
  queue, writing to `noBackupFilesDir/downloads`. The files are served to the
  WebView at `/dl/<id>/video` and `/dl/<id>/audio` with byte-range support
  (`shouldInterceptRequest` in `MainActivity.java`, GET/HEAD only).

Download metadata lives in the library store (`dinosour.library.v1`, under
`.downloads`), is device-local, and is excluded from JSON backups. The Library
page shows a **Downloads** rail with the total bytes stored and a per-item
delete; the rail disappears when empty. Playback of a downloaded video uses local
media (`blob:` object URLs in the browser, `/dl/…` paths in the APK); if the
local copy is missing the app falls back to streamed playback. `npm run
test:downloads` covers the browser/OPFS path with local FFmpeg fixtures
(picker, sizes, offline playback, rail, delete, corrupt-entry sanitize). The
Android download path has no automated coverage; verify it on-device.

## Routing & focus

`route()` is the only route entry point (hash change / clicks / `route(true)`). It
aborts the previous generation and focuses `#main` (keyboard/AT users land on the
landmark). `#search` always mirrors the hash via `updateSearch()`. `el.search` is debounced 180 ms.
The sidebar's primary entries are Home, Shorts, History and Library (`#home`,
`#shorts`, `#history`, `#library`); Watch later and liked videos are sections
inside Library, not separate entries.

## Caches (all of them)

| Name | Where | TTL (fresh / stale) | Scope |
|---|---|---|---|
| `cached()` | `server.js` | varies per route (5/2/10/30 min) | server responses |
| `shortInfo` (`resolved` / `inflight`) | client `playback-core.js` | 2 min / 6 h stale (SWR) | `/api/video` responses; shared in-flight promise per id; cap 20; background revalidate |
| `shortMetaCache` | `youtube-search.js` | 30 min (Shorts grid) / 10 min (video-lite) / — | Shorts grid titles, channels, views; `/api/video-lite` header; FIFO at 400 |
| boot cache | client `app.js` | none (last first page) | feed tiles for instant paint |
| `dinosour.restart.*`, `dinosour.feed.v1:*` | client `app.js` | session / by hand | resume position / boot tiles |
| `dinosour.library.v1` | client `app.js` | none (device-local) | the library store, incl. `.downloads` download metadata (excluded from JSON backups) |
| `dinosour.downloads.v1` | client `downloads.js` | none (until delete) | OPFS download progress mirror |
| tickets (`tickets`, `captionTickets`) | `server.js` | FIFO eviction (stream 6h / caption 1h) | signed URLs |
| service worker shell (`dinosour-shell-vN`) | `public/sw.js` | network-first | PWA offline shell |

Rules of thumb: stale entries are safe only when re-validated on use — `shortInfo`
serves a stale entry immediately and revalidates in the background (a failed
refresh keeps the stale entry; an entry older than the stale window blocks on a
fresh fetch); client LRU eviction is insertion order with touch-on-access.

## Background audio (music mode)

- Android: 1.2.3+ — the app ships a lock-screen music session via
  `navigator.mediaSession` (WebView→OS bridge). `visibilitychange → hidden` pauses
  the **video** track and keeps the separate **audio** track playing
  (battery/background-limit hygiene); on visible it re-seeks and resumes. A
  foreground `BackgroundAudioService` (`mediaPlayback` FGS type) keeps the process
  alive when the app is backgrounded. `POST_NOTIFICATIONS` is requested at
  runtime on Android 13+.
- Desktop: closing the window with media active hides it to the tray
  (`hideToTray`). A 1 s `executeJavaScript` poll samples `#video,#audio`.
  `before-quit` resumes normal teardown, or spawns the pending update installer
  with `/S` if one is registered (`update.pending`).

## Security model

Anonymous visitors see only public YouTube data; playback URLs are opaque random
tickets (never raw `googlevideo` URLs) that the server resolves to signed media
handles at request time. Non-loopback requests require the invite cookie
(`allowRequest`) except the whitelisted health/download manifest `/api/ping`,
`/app-update.json`, `/download/DinosourWeb.apk`, favicon, manifest and icon
(`icons/favicon-32.png`). Nothing about YouTube is bypassed: no sign-in, no
paid content restrictions, no DRM work, no age-gate dodging.

## Build, test & release

- `npm run` lists every task. The default dev flow is `npm start`.
- `npm run test:*` runs one suite. Browser suites need the system Chrome (not
  bundled); most expect the development server on `127.0.0.1:3210` (start
  `node server.js` separately — some suites honor `TEST_URL` instead). `test:pwa`
  re-reads the shell cache name from `sw.js`. `docs/TESTING.md` lists every
  suite with its prerequisites (Chrome, FFmpeg, live network, Python, Android
  build, packaged desktop build).
- CI: pushing to `main` runs `npm run check` + `npm test` on a throwaway server
  at `:3210` (see `.github/workflows/ci.yml`). Browser suites are excluded
  because Chrome and YouTube are not reliably available to the sandbox runner.
- Android builds need the release keystore (`android/keystore.properties`,
  gitignored) and **fail hard** without it — never signs with debug keys for a
  release.
- Desktop builds: `npm run prepare:desktop` → `npm run build:desktop`.
- Android builds: `npm run build:android` (or `cd android && gradlew.bat
  assembleRelease`), signed by the same key as every prior release.
- `docs/RELEASE.md` — the publish runbook.

## Environment variables

| Name | What it does | Who sets it |
|---|---|---|
| `TUNNEL_PROVIDER` | Tunnel provider for `npm run share`: `auto` when unset, or `tailscale` / `cloudflared` / `none` (LAN only); the `--provider=` flag wins | Operator |
| `CLOUDFLARED_PATH` | Path to a `cloudflared` executable; when set, `share.mjs` uses it instead of the one it downloads into `tools/` | Operator |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token for a named Cloudflare tunnel; with a configured origin, `share.mjs` runs that named tunnel instead of a quick tunnel (`data/cloudflared-token.txt` is the fallback) | Operator |
| `YTDLP_JS_RUNTIME` | Passed to yt-dlp as `--js-runtimes` (defaults to `node`); `desktop/main.cjs` sets it to `node:<Electron execPath>` | Desktop child process / operator |
| `DINOSOUR_UPDATE_TEST` | Truthy value puts the desktop updater in test mode: the value is treated as the installed version and the downloaded installer is never spawned | Developer (updater dry-run) |
| `DINOSOUR_TEST_PROFILE` | Overrides Electron's `userData` path so the desktop app runs against an isolated profile | `tests/desktop.mjs` (mkdtemp) |
| `PYTHON_PATH` | Python interpreter used by `tests/native.mjs` to run the packaged yt-dlp | Operator / CI (defaults to `python` on PATH) |
| `DESKTOP_EXE` | Path to the packaged `Dinosour Web.exe` that `tests/desktop.mjs` launches | Operator / CI (defaults to `dist/win-unpacked/Dinosour Web.exe`) |
| `ACCESS_CODE` | Access code required for non-loopback requests; when set, `server.js` requires it and `share.mjs` passes it through to its server child (otherwise share generates/persists `data/access.json`) | Operator |

## Conventions

- No new dependencies without arguing for them — the app ships dependency-free UI
  (only Playwright/build tooling in `devDependencies`).
- Runtime JS is ES modules except the service worker (`public/sw.js`, classic
  worker) and CommonJS (`desktop/main.cjs`).
- `console.log` in `app.js` is for emergencies; tests assert on DOM and network
  behavior, not logs.
