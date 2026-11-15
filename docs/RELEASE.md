# Release runbook

Two tracks, always the same order: **build → verify/test → publish releases →
then push** (so in-app/update checks can never see an APK URL before the
release exists). Desktop-only bumps do not touch the Android version
constants and vice versa.

Version bump rules:

| Track | Files to bump | Asset |
|---|---|---|
| Desktop | `package.json` + `package-lock.json` `version` | `DinosourWeb-Setup-<v>.exe` (+ `.blockmap`) |
| Android | `android/app/build.gradle` `versionCode` + `versionName` | `DinosourWeb.apk` |
| Android updater | `public/app-update.json` `versionCode`/`versionName`/`apkUrl`/`notes` | same |
| Docs | `README.md` (update the desktop download link + "What you need"), `docs/ARCHITECTURE.md` if anything ships differently, `public/sw.js` `CACHE` when `public/` assets changed, `npm test` + `npm run test:pwa` to confirm | — |

## Desktop (1.1.x line)

1. Bump `package.json` + `package-lock.json` only.
2. `npm run build:desktop` (needs `npm run prepare:desktop` first if `desktop/runtime/` is empty; that happens automatically).
3. `npm run test:desktop` — verifies the packaged build.
4. Hash the installer: `Get-FileHash dist\DinosourWeb-Setup-<v>.exe -Algorithm SHA256`.
5. Upload to a **draft** `desktop-v<version>` release with the exact asset name.
   The release notes must contain at least one `SHA-256: <64 hex>` line —
   `desktop/main.cjs` parses the first one.
6. Publish: patch `draft: true` → `draft: false, make_latest: false`.
   Android stays latest on GitHub.
7. Only after the release is live: `git push origin main`.
8. Verify the download produces the same bytes: compare SHA-256 of the asset URL
   with the one you just hashed (PowerShell `Invoke-WebRequest`).

## Android (1.2.x line)

1. Bump `android/app/build.gradle` (`versionCode` **and** `versionName`);
   bump `public/app-update.json` (`versionCode`, `versionName`, `apkUrl`, `notes`).
2. `cd android && gradlew.bat assembleRelease` — refuses to build without
   `keystore.properties`; debug signing is never used.
3. Verify: `aapt dump badging` for `versionCode/versionName`,
   `apksigner verify --print-certs` against the previous release's certificate,
   and that `assets/app.js` contains the new markers (e.g. the `liteDetails`
   `/api/video-lite` string) and does **not** contain `sw.js`.
4. Hash the APK: `Get-FileHash … -Algorithm SHA256`.
5. Draft release `v<version>` with the APK asset named `DinosourWeb.apk` and a
   SHA-256 line in the body.
6. Publish with `make_latest: true` (so `/releases/latest/download/DinosourWeb.apk` works).
7. `git push origin main` only after the release is live.
8. Also update `.release-assets/DinosourWeb-<v>.apk` if present and the
   `public/download/DinosourWeb.apk` copy.

## Release notes checklist

- At least one `SHA-256: <64 hex>` line.
- No machine-specific paths, no local diary sentences.
- No claims that skip hardware verification; if Android was not installed on a
  phone, say so.
- Versioned asset name for desktop; always `DinosourWeb.apk` for Android.
- Delete stale drafts after publishing the real release.
