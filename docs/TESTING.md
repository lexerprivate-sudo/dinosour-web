# Testing

What each suite does and what it needs. `npm run` lists every task; every suite
below maps to one `npm run test:*` script (or `check`). Versions: Node 22+ and
`npm ci` are assumed throughout.

## Shared prerequisites

- **Server on `http://127.0.0.1:3210`** for most browser/API suites. Start
  `node server.js` in a second terminal. Suites honor `TEST_URL` where noted;
  the rest hardcode `127.0.0.1:3210` (`test:prefetch` defaults to
  `localhost:3210`).
- **System Chrome** (not bundled) for every browser suite, driven via Playwright.
- **FFmpeg** on PATH for watch-prefetch, playback-features, features, downloads.
- **Live network + `yt-dlp`** on PATH for browser, recovery, shorts, prefetch
  (playback reaches YouTube); the server needs yt-dlp for metadata anyway.
- **Android build output** for test:native; **a packaged desktop build** for
  test:desktop.
- CI (`.github/workflows/ci.yml`) runs only `npm run check` + `npm test` on
  push to `main`; browser suites are not run there. Browser suites save
  screenshots under `test-results/`.

## Suites

| Command | Needs | Covers |
|---|---|---|
| `npm run check` | deps (eslint) | `eslint public/`; `node --check` on server and client modules; incl. `check:sw` |
| `npm run check:sw` | nothing extra | `node --test tests/sw-consistency.mjs`: `CACHE` format in `sw.js`; every `SHELL` entry resolves to a real file under `public/` |
| `npm test` | server (api/pwa only) | `node --test tests/*.test.js`: access (spawns its own isolated server; invite links, cookies, open-redirect), api + pwa (need the server; honor `TEST_URL`), audio-formats, media-chunks, metadata-cache, metadata-swr |
| `npm run test:feed` | Chrome, server | Mocked search pages: topics, infinite scroll past the old five-page limit, dedupe, retry, end-of-results |
| `npm run test:shorts` | Chrome, server, live network + yt-dlp | Mocked grid/topics portion, then live Shorts search/feed variety, reel navigation and real Shorts playback |
| `npm run test:prefetch` | Chrome, server (`TEST_URL`, default `localhost:3210`), live network + yt-dlp | Shorts idle-player prefetch; swipe promotes the buffered pair; seamless handover |
| `npm run test:watch-prefetch` | Chrome, server (`TEST_URL`), FFmpeg | Watch-page prefetch with local FFmpeg fixtures; buffer-yield behavior; mocked endpoints |
| `npm run test:playback-features` | Chrome, server, FFmpeg | Auto quality, audio language/captions, recovery, mini-player, queue/autoplay, mobile layout; local fixtures |
| `npm run test:features` | Chrome, server (`TEST_URL`), FFmpeg | Continue watching, filters/sort/recent, backup export/merge/replace, share dialog, diagnostics, double-tap seek, corrupt storage, re-unlock |
| `npm run test:downloads` | Chrome, server (`TEST_URL`), FFmpeg | Offline downloads: quality picker and sizes, OPFS engine (video/audio separate), offline playback with metadata endpoints dead, Library Downloads rail, per-item delete, corrupt-entry sanitize |
| `npm run test:library` | Chrome, server (`TEST_URL`) | Library tab with mocked pages/media: no separate Saved/Liked sidebar entries, collections, Save to picker, Play all queueing, armed-confirm delete, library sanitize |
| `npm run test:browser` | Chrome, server (hardcoded), live network + yt-dlp | Full walkthrough: home, search, playback (Big Buck Bunny), save/like, library, mobile overflow |
| `npm run test:pwa` | Chrome, server (`TEST_URL`) | Service worker activation, manifest installability, offline shell reload; re-reads the shell cache name from `sw.js` |
| `npm run test:startup` | Chrome only | Android-origin simulation (no server/network): stalled-network readiness, syntax/missing-module/late-init failure notifications |
| `npm run test:native` | Android build first (`android/app/build/playbackEngine/yt-dlp`), Python 3.11+, Chrome, live network; no server | Bundled UI through the Android boundary with a desktop-emulated native engine: live search, playback, storage backup, no PC/tunnel requests. Not a device test |
| `npm run test:desktop` | packaged build (`DESKTOP_EXE` or `dist/win-unpacked/Dinosour Web.exe`), Electron, live internet | Packaged app boots against an isolated profile (`DINOSOUR_TEST_PROFILE`, auto-mkdtemp); feed renders; watch page plays; save works; renderer exposes no Node |

## Running the suite

From the repository root, with the server already running where required:

```powershell
npm test                 # unit/API suites only; no browser
npm run test:downloads   # one suite at a time; each takes its own prerequisites
```

`npm test` never launches a browser. The browser suites are not part of
`npm test` and not in CI; run them locally before a release. Most suites that
hit YouTube are slow (page timeouts of 30–120 s) and will fail rather than
skip when the network or yt-dlp is missing. Suites that generate FFmpeg
fixtures write them to `test-results/`. To point a suite at another server,
set `TEST_URL`:

```powershell
$env:TEST_URL = 'http://localhost:4000'; npm run test:downloads
```

## Not covered automatically

- The Android native download path (yt-dlp transfers in `NativeEngine.java`)
  has no automated coverage; verify offline downloads on a physical device.
- Playback on real Android WebViews/hardware needs an on-device smoke test;
  test:native only emulates the native boundary on desktop.
