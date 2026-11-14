const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage } = require('electron');
const { fork, spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

let window, backend, tray, quitting = false, updateSpawned = false;
let mediaPlaying = false, trayHintShown = false;
const origin = 'http://127.0.0.1:43219';
const REPO = 'lexerprivate-sudo/dinosour-web';
// Keep this origin stable across upgrades so Chromium retains the user's library.
app.setName('Dinosour Web');
if (process.env.DINOSOUR_TEST_PROFILE) app.setPath('userData', process.env.DINOSOUR_TEST_PROFILE);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.whenReady().then(start).catch(fail);
}

function fail(error) {
  if (quitting) return;
  dialog.showErrorBox('Dinosour could not start', `${error.message}\n\nClose Dinosour and try opening it again.`);
  app.quit();
}

async function start() {
  const runtime = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(__dirname, 'runtime');
  const extractor = path.join(runtime, 'yt-dlp.exe');
  if (!fs.existsSync(extractor)) throw new Error('The bundled playback engine is missing. Reinstall Dinosour.');
  const log = fs.createWriteStream(path.join(app.getPath('userData'), 'desktop.log'), { flags: 'w' });
  backend = fork(path.join(__dirname, '..', 'server.js'), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1', PORT: '43219', MEDIA_PORT: '43220',
      PUBLIC_ORIGIN: '', MEDIA_ORIGIN: '', ACCESS_CODE: '',
      YTDLP_PATH: extractor, YTDLP_JS_RUNTIME: `node:${process.execPath}` },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  backend.stdout.pipe(log);
  backend.stderr.pipe(log);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local playback service did not start in time.')), 20000);
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.once('exit', code => {
      clearTimeout(timer);
      const error = new Error(`The playback service stopped (${code}). Another program may be using port 43219. See desktop.log in ${app.getPath('userData')}.`);
      reject(error);
      if (window && !quitting) fail(error);
    });
    backend.on('message', message => {
      if (message.type === 'ready' && message.url === origin) { clearTimeout(timer); resolve(); }
    });
  });
  window = new BrowserWindow({
    title: 'Dinosour', width: 1360, height: 900, minWidth: 800, minHeight: 600,
    backgroundColor: '#0f0f0f', show: false,
    icon: path.join(__dirname, '..', 'public', 'icons', 'icon-512.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); openExternal(url); }
  });
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'fullscreen');
  });
  // Background sound: poll media state once a second. Event counting drifts
  // (buffering pauses decrement without matching play events), so a poll is
  // the authoritative signal for "is anything actually playing". While media
  // is active, closing the window only hides it to the tray instead of quitting.
  setInterval(async () => {
    if (!window || window.isDestroyed()) return;
    try {
      mediaPlaying = await window.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('video,audio')).some(m => !m.ended && m.currentTime > 0 && (!m.paused || m.readyState < 3))"
      );
    } catch (error) { /* window is closing or blocked */ updateLog(`poll failed: ${error?.message || error}`); }
  }, 1000);
  window.on('close', event => {
    if (!quitting && mediaPlaying) {
      event.preventDefault();
      hideToTray();
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Dinosour', submenu: [
      { label: 'Home', click: () => window.loadURL(origin + '/#home') },
      { label: 'Check for desktop updates', click: () => checkForUpdates(false).catch(notifyUpdateError) },
      { label: 'About Dinosour', click: () => dialog.showMessageBox(window, {
        title: 'Dinosour Web', message: `Dinosour Web Desktop ${app.getVersion()}`,
        detail: 'Standalone Windows viewer. Playback tools are bundled.\nYour library is stored on this PC; updates install themselves.\n\nUse Settings → Export backup to move your library between devices.',
      }) },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
  window.once('ready-to-show', () => window.show());
  await window.loadURL(origin + '/#home');
  // Look for a newer desktop release shortly after startup; failures are
  // silent except for the log so a flaky network never disturbs the user.
  setTimeout(() => checkForUpdates(true).catch(error => updateLog(`update check failed: ${error.message}`)), 10000);
}

function hideToTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'public', 'icons', 'icon-512.png'));
  if (!tray) {
    tray = new Tray(icon);
    tray.setToolTip('Dinosour Web');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Dinosour', click: showWindow },
      { label: 'Quit Dinosour', click: () => app.quit() },
    ]));
    tray.on('double-click', showWindow);
  }
  window.hide();
  if (!trayHintShown) {
    trayHintShown = true;
    tray.displayBalloon?.({
      iconType: 'info',
      title: 'Dinosour is still playing',
      content: 'Sound keeps playing in the background. Click the tray icon to bring it back; use Quit to exit.',
    });
  }
}

function showWindow() {
  if (!window) return;
  window.show();
  window.focus();
}

// ---------------------------------------------------------------------------
// Desktop self-updater. Desktop releases use the desktop-vX.Y.Z tag prefix and
// ship DinosourWeb-Setup-<version>.exe with a "SHA-256: <hex>" line in the
// notes. The installer is downloaded and verified, then run silently the next
// time the app quits, so nothing ever lands on the user's Desktop.
// ---------------------------------------------------------------------------

const update = {
  pending: null,
  testMode: Boolean(process.env.DINOSOUR_UPDATE_TEST),
  running: false,
};

function updateLog(message) {
  try { fs.appendFile(path.join(app.getPath('userData'), 'desktop.log'), `[updater] ${message}\n`); }
  catch { /* logging must never break playback */ }
}

function notifyUpdateError(error) {
  dialog.showMessageBox(window, {
    type: 'warning', title: 'Update check failed',
    message: 'Dinosour could not check for updates.',
    detail: `${error.message}\n\nYou can try again later from the Dinosour menu, or check https://github.com/${REPO}/releases?q=desktop`,
  });
}

function parseTag(tag) {
  const match = /^desktop-v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(tag, current) {
  const next = parseTag(tag), base = parseTag(`desktop-v${current}`);
  if (!next || !base) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] !== base[i]) return next[i] > base[i];
  }
  return false;
}

async function fetchJson(url, init, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { 'User-Agent': 'Dinosour-Web-Desktop', Accept: 'application/vnd.github+json', ...(init?.headers || {}) },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function downloadVerified(asset, expectedSha) {
  const directory = path.join(app.getPath('userData'), 'updates');
  await fs.promises.mkdir(directory, { recursive: true });
  const target = path.join(directory, asset.name);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': 'Dinosour-Web-Desktop', Accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(600000),
      });
      if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`);
      const hash = createHash('sha256');
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) { hash.update(chunk); chunks.push(chunk); size += chunk.length; }
      const digest = hash.digest('hex').toLowerCase();
      if (digest !== expectedSha.toLowerCase()) throw new Error('The downloaded update did not match its published SHA-256 checksum.');
      if (size !== asset.size) throw new Error(`Downloaded update is ${size} bytes, expected ${asset.size}.`);
      await fs.promises.writeFile(target, Buffer.concat(chunks));
      return target;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 4000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function checkForUpdates(silent) {
  if (update.running) return;
  update.running = true;
  try {
    if (update.pending) {
      updateLog(`update ${update.pending.version} already downloaded`);
      if (!silent) offerRestart(update.pending.version);
      return;
    }
    const current = update.testMode ? process.env.DINOSOUR_UPDATE_TEST : app.getVersion();
    const releases = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`);
    const candidate = releases.find(release => release && !release.draft && !release.prerelease && isNewer(release.tag_name, current));
    if (!candidate) {
      updateLog(`no desktop update newer than ${current}`);
      if (!silent) dialog.showMessageBox(window, {
        type: 'info', title: 'Dinosour Web',
        message: `You are up to date.`,
        detail: `Dinosour Web Desktop ${app.getVersion()} is the newest desktop release.`,
      });
      return;
    }
    const version = candidate.tag_name.replace(/^desktop-v/, '');
    const checksum = /SHA-256:\s*([a-fA-F0-9]{64})/.exec(candidate.body || '');
    if (!checksum) throw new Error(`Release desktop-v${version} does not publish a SHA-256 checksum.`);
    const asset = (candidate.assets || []).find(item => item.name === `DinosourWeb-Setup-${version}.exe`);
    if (!asset) throw new Error(`Release desktop-v${version} has no DinosourWeb-Setup-${version}.exe attached.`);
    updateLog(`downloading desktop-v${version} (${asset.size} bytes)…`);
    const installer = await downloadVerified(asset, checksum[1]);
    update.pending = { version, installer };
    updateLog(`update ${version} downloaded${update.testMode ? '; test mode: would install, not spawning' : ''}`);
    if (!silent) offerRestart(version);
  } finally {
    update.running = false;
  }
}

function offerRestart(version) {
  if (update.testMode) {
    updateLog(`test mode: would offer restart to install ${version}`);
    return;
  }
  dialog.showMessageBox(window, {
    type: 'info', title: 'Update ready',
    message: `Dinosour ${version} is ready to install.`,
    detail: 'It installs itself when Dinosour closes. Your library and settings are kept.',
    buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) app.quit();
  });
}

function openExternal(url) {
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {}
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  quitting = true;
  if (update.pending && !updateSpawned && !update.testMode) {
    updateSpawned = true;
    try {
      updateLog(`launching installer for ${update.pending.version}`);
      spawn(update.pending.installer, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (error) {
      updateLog(`installer launch failed: ${error.message}`);
    }
    // Give the silent installer a moment, then finish quitting so it can
    // replace the files of the process that is about to exit.
    event.preventDefault();
    setTimeout(() => app.quit(), 2000);
    return;
  }
  if (backend?.pid && backend.exitCode === null) {
    // Also stop yt-dlp/JS-runtime children; no background service stays running.
    spawnSync('taskkill', ['/pid', String(backend.pid), '/t', '/f'], { windowsHide: true, timeout: 10000 });
  }
});
