# Windows desktop distribution

- Electron 45.3.2 — MIT; includes Chromium, Node.js and their dependencies.
  Electron's LICENSE and LICENSES.chromium.html are shipped beside the application.
  https://github.com/electron/electron
- yt-dlp 2026.10.26 official Windows x64 executable, with bundled Python,
  PyInstaller, EJS and other upstream components. The Windows executable is
  distributed under GPL-3.0 due to its bundled components; upstream notices and
  corresponding source/build instructions:
  https://github.com/yt-dlp/yt-dlp/tree/2026.10.26
  https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/THIRD_PARTY_LICENSES.txt
  SHA-256: f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d

The desktop distribution is GPL-3.0. See `LICENSE` at the repository root for
the full license text. Dinosour desktop source and build instructions are
published at:
https://github.com/lexerprivate-sudo/dinosour-web

The installer bundles the playback runtime at build time. No FFmpeg binary is
bundled; the interface plays separate video and audio tracks directly.
