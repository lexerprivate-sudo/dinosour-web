# Release runbook

Two tracks, always the same order: build → verify → publish **release** → push
(so in-app/update checks can never see an APK URL before the release exists).

Version bump rules (all four must move together):

| Track | version source of truth | asset |
|---|---|---|
| Android | `android/app/build.gradle` `versionCode` / `versionName` | `DinosourWeb.apk` |
| Desktop | `package.json` `version` | `DinosourWeb-Setup-<v>.exe` + blockmap |
| Android updater | `public/app-update.json` `versionCode`/`versionName`/`apkUrl` | same |
| Docs | `README.md` (download link), `docs/ARCHITECTURE.md` if anything ships differently | — |

## Desktop (1.1.x line)

1. Bump `package.json` + `package-lock.json` (the only two), `public/sw.js` if
   assets changed (`dinosour-shell-vN+1` + `SHELL`).
2. `npm run test:desktop` (needs the packaged app built and internet).
3. `npm run build:desktop`.
4. Hash the installer:
   `Get-FileHash dist\DinosourWeb-Setup-<v>.exe -Algorithm SHA256`
5. Upload to a **draft** `desktop-v<version>` release with the exact asset name.
   The release notes must contain exactly one `SHA-256: <64 hex>` line — the
   updater regex requires it.
6. Patch the draft: `draft: true` → `draft: false, make_latest: false`.
   Android stays latest on GitHub.
7. Only after the release is live: `git push origin main` (main already committed).
8. Verify two URLs return matching bytes (PowerShell `Invoke-WebRequest` and compare
   hashes): the `releases/download/desktop-v<v>/…` URL and the `releases/latest/download`
   if you ever want latest to mean desktop (it should not).

## Android (1.2.x line)

1. Bump `android/app/build.gradle` (`versionCode` **and** `versionName`),
   `public/app-update.json` (`versionCode`, `versionName`, `apkUrl`, notes).
2. `cd android && gradlew.bat assembleRelease` — fails without `keystore.properties`.
3. Verify: `aapt dump badging` for `versionCode/versionName`,
   `apksigner verify --print-certs` against the previous release's certificate,
   and that `assets/app.js` contains the new JS (SW cache key, lite-player marker, etc.).
4. Hash the APK: `Get-FileHash … -Algorithm SHA256`.
5. Draft release `v<version>` with the APK asset named `DinosourWeb.apk` and a notes
   section containing the SHA-256 line.
6. Publish with `make_latest: true` (so `/releases/latest/download/DinosourWeb.apk`
   works).
7. `git push origin main` only after the release is live.
8. Update `releases/` local copies: `releases\DinosourWeb-<v>.apk`.

## Release notes checklist

- One `SHA-256: <64 hex>` line, lowercase or mixed hex is fine.
- No machine-specific paths (`C:\Users\Rave\…`), no local diary sentences.
- No tech preview claims that skip the verification checklists.
- Versioned asset name for desktop (`DinosourWeb-Setup-1.1.x.exe`); always
  `DinosourWeb.apk` for Android.
- Delete stale drafts after publishing the real release.

## Safety rails baked into the build

- Android `assembleRelease` refuses to compile without `keystore.properties` and
  now also validates all four keys before compiling.
- Desktop updater verifies SHA-256 from release notes before running the installer;
  a mismatch stops the install silently.
- `npm run build:*` output lands in `dist/` (gitignored); local copies live in
  `releases/` (gitignored).
