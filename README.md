# Dinosour

A local YouTube-style web app with live search and direct playback of public
YouTube videos. No app account, subscription system, or embedded ad player.

## Open it

Double-click **Start Dinosour.cmd**, or run:

```powershell
cd C:\Users\Rave\Desktop\dinosour
npm start
```

Open **http://localhost:3210**. Keep the terminal running while watching.
If it is already running, just open that address. Stop the server with Ctrl+C.

Requires Node.js 22+ and `yt-dlp` on PATH. Both were already available on this
computer. No npm runtime dependencies are needed. On another Windows computer:

```powershell
winget install OpenJS.NodeJS.LTS
winget install yt-dlp.yt-dlp
```

Restart the terminal after installing prerequisites. `YTDLP_PATH` can point to a
specific executable. `PORT` overrides 3210 and `MEDIA_PORT` overrides the media
port (3211).

The server binds to `127.0.0.1` by default. For a phone on the same Wi-Fi, start
it with `HOST=0.0.0.0` and open `http://<this-computer-ip>:3210` on the phone
(allow Node.js through the Windows firewall if prompted).
For a public HTTPS deployment, set `PUBLIC_ORIGIN` to the site origin (for
example `https://dinosour.example.com`) and put a TLS reverse proxy in front of
port 3210. `MEDIA_ORIGIN` optionally sends stream traffic to a second public
origin; when omitted, streams use `PUBLIC_ORIGIN`. The server builds each
playback URL from the request, so localhost, LAN and public access can share one
running process. PWA installation and the service worker require HTTPS (or
localhost); plain-HTTP LAN access still plays normally but cannot be installed.

```powershell
$env:HOST = '0.0.0.0'
$env:PUBLIC_ORIGIN = 'https://dinosour.example.com'
npm run serve
```

## Features

- Real YouTube search and automatic infinite scrolling, with no app-imposed page limit.
  More videos load as you approach the bottom, until YouTube runs out of results.
- Add your own topics using **+**. Topics are saved on this device and can be
  removed with the **×** on each chip. The sidebar shows your topics too.
- A dedicated **Shorts** page with the same **All** / topic / **+** bar. **All**
  uses YouTube's anonymous Shorts watch sequence, which changes between visits;
  each topic mixes several result pages and reorders them per visit, so the grid
  does not repeat the same first row forever.
- Opening a Short starts a full-height **doom-scroll reel**: wheel, swipe, arrow
  keys, or the on-screen arrows move to the next/previous Short, which starts
  playing immediately. Reaching the end of the loaded list fetches more Shorts.
  While the current Short plays, the next one is buffered into a second, hidden
  player pair; swiping promotes that pair without reloading its source, so the
  next video and audio start from frames already downloaded. On desktop the
  heart/save/share/sound rail sits to the right of the portrait video, like
  YouTube Shorts; on mobile it overlays the video.
- The reel uses its own clean overlay controls: play/pause, mute, fullscreen, a
  thin red scrub bar, and click-to-pause. There is no native control bar and no
  redundant “Shorts” badge or position counter. A small spinner appears only when
  the first frame takes longer than 0.7 s; it is hidden as soon as a frame exists
  so it never stacks on the browser’s own buffering feedback.
- Paste a YouTube URL, Shorts URL, or video ID directly into search. Shorts links
  open in the vertical reel.
- Click a video or Short and it starts playing automatically. No extra “Play video”
  step.
- Direct H.264 video and AAC audio playback, with available qualities up to 1080p
  (portrait Shorts use their shorter edge for the quality label, so 1080×1920 is
  shown as 1080p).
- Native playback controls, seeking, volume, fullscreen, and 0.5–2× speed on the
  watch page, plus an explicit volume slider and mute button in the Playback row.
  The slider controls the separate audio track too and is remembered on your device.
- Watch later, liked videos, and watch history with resume positions.
- Responsive desktop and mobile layouts, including safe-area padding for notches
  and gesture bars.
- Installable PWA: a web app manifest, maskable icons, and a network-first
  service worker. Chrome/Edge can install Dinosour from the address bar; iOS
  Safari can add it to the Home Screen.
- Signed Android app (`DinosourWeb.apk`) with native server settings, a gear menu,
  in-app update checks, and full-screen Shorts playback.
- Clean YouTube-style layout with a collapsible sidebar, compact search, and
  dark/light appearance (remembered on your device).
- Local library stored in your browser, without a login.

Space/K toggles playback; left/right arrows seek; F enters fullscreen; `/` focuses search.
Changing quality resumes playback automatically from the same position.

If your browser’s autoplay policy blocks the separate audio track, the video
continues silently and a **🔇 Unmute** button appears. One click enables audio;
it is not required before the video starts. In the rare case the browser blocks
the video element too, a normal **Play video** button is shown as a fallback.

## How it works

1. `youtube-search.js` calls YouTube's public web search endpoint and extracts
   video cards, Shorts cards (`shortsLockupViewModel`), and continuation tokens.
   Topics use the public Shorts search filter; several search pages are pooled
   so the topic grid can be reordered on each visit. The **All** grid and reel
   instead follow YouTube's anonymous Shorts watch sequence
   (`sequenceContinuation` / `reel/reel_watch_sequence`), which is not tied to a
   fixed query and changes between requests. No API key is needed.
2. `server.js` asks your installed yt-dlp for public playback metadata and signed
   media URLs. It does not ask for browser cookies or account credentials. It also
   serves portrait Shorts thumbnails, filters mixed continuation pages back to
   Shorts-only entries, and resolves titles for sequence items.
3. Short-lived, opaque local stream URLs proxy media byte ranges from Google's
   video CDN. Signed CDN requests that answer with a 302 are followed to the new
   `googlevideo.com` edge host before the proxy retries. Media is served from a
   second local origin (`127.0.0.1:3211` by default) so Chrome’s
   six-connections-per-origin limit is not consumed by yt-dlp metadata and search
   requests while the first frames are loading. The browser synchronizes the
   separate audio/video tracks.
4. `public/app.js` renders the interface and stores your library locally. The
   reel keeps two complete video/audio player pairs in the stage. The idle pair
   preloads the next Short at 720p (unless the browser reports a metered or very
   slow connection), and a swipe promotes it while the previous pair becomes the
   next prefetch target. At most two Shorts are buffered in memory at once.

Videos are streamed, not saved as downloaded files. Search/metadata/thumbnails
are cached in server memory. Requests still contact YouTube and its CDN; this is
not an anonymity service. The interface uses system fonts without external font requests.

## Playback limits

Public recorded videos and Shorts are supported when YouTube exposes compatible
streams. Private, paid, age-restricted, geographically restricted, or bot-blocked
videos may not play. Live streams are not supported in this version. There is no
bypass for access restrictions. Creator sponsorships baked into videos remain.

YouTube changes its endpoints and media delivery frequently; all-video or permanent
ad-free availability cannot be guaranteed. The first video lookup can take tens
of seconds. If a request times out, use Retry. Retry requests new playback metadata.
If extraction repeatedly fails, update yt-dlp using its original install method
(for this machine: `winget upgrade yt-dlp.yt-dlp`).

Media URLs can be interrupted mid-session. Dinosour first switches the separate
audio element to YouTube’s alternate AAC track when one is available. If every
track fails, it requests fresh playback metadata automatically and resumes near the
previous position; the full error screen only appears if the automatic recovery
also fails. Shorts use the same fallback and refresh behavior inside the reel.

Dinosour is an installable **web app/PWA** plus a signed **Android WebView
shell**. The mobile layout is verified at 390×844 in Chrome. The APK is built,
signed, and structurally verified, but it has not yet been installed on a
physical Android device.

## Android app and updates

### Playback improvements

- Hover, keyboard focus, or touch-down on a video prepares one upcoming video
  and its audio. Opening it reuses the buffered media elements.
- Speculative loading is skipped on Data Saver/2G connections, cancelled when
  leaving the page, and expires after 45 seconds.
- While playback starts, the thumbnail and a loading message replace the blank
  player. Later buffering uses a small indicator over the last video frame.
- Saved-position playback works with warmed players; playback controls wrap on
  narrow phone screens.

Run `npm run test:watch-prefetch` for the deterministic buffering/resume test.
It requires FFmpeg on PATH to generate small local media fixtures.
These are web-side changes: reopen the Android app to load them; no new APK is
required.

A signed Android shell is included:

- Download the latest APK:
  <https://github.com/lexerprivate-sudo/dinosour-web/releases/latest>
- Local copies: `C:\Users\Rave\Desktop\DinosourWeb.apk` and
  `C:\Users\Rave\Desktop\DinosourWeb-1.0.1.apk`
- Served by the backend at `/download/DinosourWeb.apk`
- Android 7.0+ (API 24), target API 34
- Launcher name **Dinosour Web**, package `com.dinosour.web`, version `1.0.1`

This app installs alongside the original Dinosour from the `tot` project.
It has its own Android package and GitHub repository.

The shell is a small WebView app. It opens the Dinosour server, so the interface
and features update on the web without a new APK. The Android shell only needs
rebuilding when native behavior changes.

A static APK cannot contain this app by itself. Search, yt-dlp metadata, ticket
handling, and the media proxy all need a running Node backend. GitHub Pages and
other static hosts cannot run it. On your home Wi-Fi, the PC running this folder
is the backend. To use the app away from home, host the Node process on a VPS
(or a home server with a public HTTPS tunnel) and keep `yt-dlp` updated there.

### Install on the phone

1. On the PC, double-click **Start Dinosour (LAN).cmd**. Keep its window open. It
   binds to `0.0.0.0` and prints the address(es) to use on the phone, for example
   `http://192.168.1.59:3210`. Allow Node.js through the Windows firewall if
   prompted. The address can change if you reconnect to Wi-Fi; the app's gear
   settings let you correct it without reinstalling.
2. Install `DinosourWeb.apk` from the [latest GitHub release](https://github.com/lexerprivate-sudo/dinosour-web/releases/latest)
   or from the Desktop copy. Android will ask to allow installs from that app
   or source.
3. Connect the phone to the same Wi-Fi, open Dinosour, and accept the prefilled
   server address. If the PC's address changed, tap the **gear icon** in the top
   bar and enter the address printed by the LAN script.
4. The library, topics, and history are stored on the phone. The gear icon also
   has **Check for updates**.

The gear icon appears only inside the Android shell; in a normal browser it stays
hidden.

### Rebuild the APK

```powershell
cd C:\Users\Rave\Desktop\dinosour
build-apk.cmd
```

Or:

```powershell
cd android
.\gradlew.bat assembleRelease
```

The build needs JDK 17+ and Android SDK 35. `android/local.properties` points at
the SDK on this computer. `build-apk.cmd` copies the result to the Desktop and to
`public/download/DinosourWeb.apk`, which is what `/download/DinosourWeb.apk` serves.

Version bumps go in **two** places:

- `android/app/build.gradle`: increase `versionCode` and set `versionName`.
- `public/app-update.json`: set the same `versionCode`/`versionName`, and point
  `apkUrl` at the new APK.

Keep `versionCode` increasing. Android refuses to update to an APK with a lower
version code.

### Updates

The app fetches `<server>/app-update.json` when you tap **Check for updates**.
`apkUrl` can be an absolute URL or a path relative to the server. The app
downloads it with Android's DownloadManager and opens the system package
installer. Android always asks for confirmation and requires **Install unknown
apps** permission for Dinosour; GitHub/APKs cannot update silently like the Play
Store.

For GitHub distribution, this project is published at
<https://github.com/lexerprivate-sudo/dinosour-web>. The `v1.0.1` release hosts
`DinosourWeb.apk`, and `public/app-update.json` points `apkUrl` at the stable
`/releases/latest/download/DinosourWeb.apk` URL, which always serves the newest
release asset with that name.

To publish a new Android version:

1. Increase `versionCode` and `versionName` in `android/app/build.gradle`.
2. Run `build-apk.cmd` to build and sign the APK.
3. Set the same `versionCode`/`versionName` in `public/app-update.json`. Leave
   `apkUrl` unchanged; the `latest/download` link follows new releases.
4. Create a GitHub Release tagged `vX.Y.Z` and attach the built APK with the
   exact name `DinosourWeb.apk`.
5. Commit and push the updated `public/app-update.json` so update checks report
   the new version.

The separate `lexerprivate-sudo/dinosour` repository contains an older native
Android app with its own updater. This project intentionally does not modify it.

[Obtainium](https://github.com/ImranR98/Obtainium) is an alternative that watches
GitHub Releases itself.

### Hosting checklist

1. Install Node.js 22+ and `yt-dlp` on the server, then copy this folder and run
   `npm install --omit=dev` if you only need runtime files.
2. Set `HOST=0.0.0.0`, `PUBLIC_ORIGIN=https://your.domain`, and run
   `npm run serve` under a process manager or systemd service.
3. Put HTTPS in front of port 3210. A minimal Caddy site is:

   ```caddyfile
   your.domain {
     reverse_proxy 127.0.0.1:3210
   }
   ```

   Keep `MEDIA_ORIGIN` unset for this single-domain setup, so streams also go
   through the proxy. The proxy must pass byte-range requests through; Caddy
   does this by default.
4. Confirm `https://your.domain/manifest.webmanifest`, `/sw.js`, and playback all
   work. Chrome should offer **Install Dinosour**.
5. Enter the HTTPS address in the Android app's gear settings.

### Signing key

The APK is signed with `android/keystore/dinosour-release.jks` and
`android/keystore.properties` (both gitignored). **Back them up.** Every future
APK installed over this one must use the same key, so losing the keystore means
users must uninstall and reinstall.

The included shell is a WebView app. A Trusted Web Activity (Bubblewrap) or
Capacitor app are alternatives if you later want Chrome-backed rendering or
native plugins; both still require the hosted backend.

## Studying YouTube

The original REA capture is in `rea-youtube-evidence.json`. See
`REA-FINDINGS.md` for observed facts, limitations, and the implementation decisions.
The reel layout was measured from the live YouTube Shorts page with the same
CDP/REA approach: the 9:16 video, the 48px action buttons outside it, the top
overlay controls, and the bottom metadata gradient. Reference frames are saved as
`test-results/youtube-shorts-reference-2.png` and `youtube-shorts-reference-dark.png`.

Ghidra 12.2 from the official National Security Agency repository is installed at
`C:\Users\Rave\Tools\ghidra_12.2_PUBLIC`. The release ZIP’s SHA-256 was verified
against the official digest before extraction. Launch the GUI with:

```powershell
C:\Users\Rave\Tools\ghidra_12.2_PUBLIC\ghidraRun.bat
```

Or double-click `C:\Users\Rave\Tools\Open Ghidra.cmd`. The verified headless
analysis logs are `ghidra-ytdlp-analysis.log` and `ghidra-ytdlp-report.log`.

Ghidra is a native-code reverse-engineering tool. It can examine local compiled
programs such as `yt-dlp.exe` and browser executables, but it cannot decompile
YouTube’s server-side code or run on a remote website. YouTube’s browser client
is minified JavaScript and is better studied with browser DevTools, CDP, and REA.
See `GHIDRA-FINDINGS.md` for the installation check and the native-artifact study.

## Verification

With the app running:

```powershell
npm run check
npm test
npm install
npm run test:feed
npm run test:recovery
npm run test:shorts
npm run test:prefetch
npm run test:browser
npm run test:pwa
```

`npm test` also checks the PWA manifest, icon dimensions and MIME types, the
uncached service worker, `viewport-fit=cover`, and the safe-area CSS.
`npm run test:pwa` registers the service worker in Chrome, verifies that the
manifest has no errors, and reloads the page offline to confirm the cached shell.
The browser test requires installed Google Chrome and internet access. It opens a
video and expects playback to start with no extra click, then tests real search, a
real Blender Foundation YouTube video, audio synchronization, the volume/mute
controls, the absence of a duplicate loading overlay, seeking, quality/speed
controls, saved/liked videos, history persistence, and mobile overflow.
Screenshots are saved under `test-results/`. `npm run test:feed` uses mocked search
pages to verify custom topics, automatic infinite scrolling past the old five-page
limit, deduplication, retry, and end-of-results handling. `npm run test:shorts`
checks the Shorts bar/topics with mocked pages, then verifies live feed variety
(All and topic feeds change between requests), performs a live Shorts search,
verifies Shorts-only continuation pages, opens the full-height reel, checks the
external action rail, custom play/pause controls, absence of redundant badges and
native controls, progress bar and volume sync, wheel-navigates to the next Short,
and plays a real Short with synchronized video and audio. `npm run test:prefetch`
uses a fixed three-item reel with real media metadata: it waits for the idle player
to buffer the next Short, swipes twice, and verifies that the promoted video/audio
kept their preloaded sources, both player pairs alternate, playback starts without
a loading spinner, and the switch stays within a seamless-latency budget.

Independent project, not affiliated with YouTube. Titles, thumbnails, and videos
belong to their respective creators.
