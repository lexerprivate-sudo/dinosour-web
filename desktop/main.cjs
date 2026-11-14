const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { fork, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

let window, backend, quitting = false;
const origin = 'http://127.0.0.1:43219';
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Dinosour', submenu: [
      { label: 'Home', click: () => window.loadURL(origin + '/#home') },
      { label: 'Check for desktop updates', click: () => shell.openExternal('https://github.com/lexerprivate-sudo/dinosour-web/releases?q=desktop') },
      { label: 'About Dinosour', click: () => dialog.showMessageBox(window, {
        title: 'Dinosour Web', message: `Dinosour Web Desktop ${app.getVersion()}`,
        detail: 'Standalone Windows viewer. Playback tools are bundled.\nYour library is stored on this PC.\n\nUse Settings → Export backup to move your library between devices.',
      }) },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
  window.once('ready-to-show', () => window.show());
  await window.loadURL(origin + '/#home');
}

function openExternal(url) {
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {}
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  if (backend?.pid && backend.exitCode === null) {
    // Also stop yt-dlp/JS-runtime children; no background service stays running.
    spawnSync('taskkill', ['/pid', String(backend.pid), '/t', '/f'], { windowsHide: true, timeout: 10000 });
  }
});
