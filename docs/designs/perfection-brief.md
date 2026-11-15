# Dinosour perfection brief — target for a fresh-context review

Date: 2026-11-15. Repo: `C:\Users\Rave\Projects\dinosour`.
Role: All reviewers audit the **current** codebase (not a proposal). You are a
fresh team member who just joined the project. Strictly read-only.

## What Dinosour is

Dinosour is a YouTube-style viewer shipped three ways:

- `web/` (repo root): PWA + Node backend (`server.js`), public UI in `public/`.
- `android/`: standalone Android app (WebView + ytdl-android), package
  `com.dinosour.web`. Bundles the same `public/` UI.
- `desktop/`: Electron 45 app (`desktop/main.cjs`), bundled yt-dlp, fixed
  loopback origin 43219, tray mode, self-updater from GitHub releases.

## The user's mandate (verbatim intent)

"Fix the bugs, glitches, the loading, the animations."

## Constraints that already exist (context, not findings)

- Public videos only: live search + direct streams; no account, no ads.
- Desktop updates itself from GitHub `desktop-vX.Y.Z` releases (SHA-256-verified);
  nothing lands on the Desktop.
- Android stays `1.2.3`/`1.2.x`; APK updates download from `vX.Y.Z` releases.
- Auth model: access-code cookie for non-local requests of the hosted server.
- Media path: bounded 1 MB chunks via local proxy with read-ahead (media-chunks.js).
- No test may hit the production project (`C:\Users\Rave\Desktop\tot`).
- All heavy flows are live-tested (playback, shorts, tray, startup, SW, PWA,
  features/recovery/prefetch) via `tests/*.mjs` suites.

## Current known state

- 1.2.3 Android + 1.1.3 Desktop released and published.
- Accessibility baseline: combobox search role, single-name landmarks, sequential
  headings; axe-core audit outstanding for final verification.
- Feed paints from a localStorage boot cache; server feeds use SWR caching;
  the watch page paints title/channel/views from a lite player response while
  yt-dlp resolves streams; background music mode holds audio while the video
  track pauses (MediaSession + foreground service).

## What to audit — ranked

1. Correctness: logic bugs, races, leaks, bad error handling, XSS, bad ranges,
   stale tickets, caption path, prefetch/abort/cleanup ordering.
2. UX/UI glitches: loading states, empty states, focus rings, contrast, motion,
   mobile layout, skeletons, animation consistency, reduced-motion.
3. Accessibility: aria correctness, landmarks, heading order, names, roles.
4. Performance: paint path, feed rendering, image handling, main-thread blocks.
5. Structure: module boundaries, dead code, duplication, naming, review burden.

## Output contract (all reviewers)

Findings as: `Severity [Blocker|Major|Nit] — file:line — one-line finding —
one-line fix direction.` Do not write files, do not fix, do not run tests.
No repetition of what the brief already states as known-good.
