# Standalone Android runtime

The Android distribution and its bundled interface are distributed under
GNU GPL version 3. Source is available with every release in this repository.
See `COPYING` for the full license.

- youtubedl-android 0.18.1 — GPL-3.0:
  https://github.com/yausername/youtubedl-android
  Maven coordinate: `io.github.junkfood02.youtubedl-android:library:0.18.1`.
  Its source and build scripts include the bundled Python and QuickJS runtime.
- yt-dlp 2026.10.26 — Unlicense, with the additional notices for bundled components:
  https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE
  The official zipimport executable is downloaded and SHA-256 verified during
  the Gradle build. It includes the upstream EJS components and their notices.
- Python — Python Software Foundation License:
  https://docs.python.org/3/license.html
- QuickJS — MIT:
  https://bellard.org/quickjs/
- AndroidX, Kotlin and Jackson — Apache-2.0; Commons IO — Apache-2.0.

These libraries resolve through the declared Gradle dependencies. No FFmpeg,
Aria2, YouTube login credentials, or PC connection is required for playback.
