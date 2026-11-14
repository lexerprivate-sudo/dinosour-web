import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const toolsDir = path.join(root, 'tools');
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || '0.0.0.0';
const args = process.argv.slice(2);
const providerArg = (args.find(value => value.startsWith('--provider='))?.split('=')[1] || process.env.TUNNEL_PROVIDER || 'auto').toLowerCase();
const rotate = args.includes('--rotate');
const accessFile = path.join(dataDir, 'access.json');
const publicFile = path.join(dataDir, 'public-url.json');
const tunnelLog = path.join(dataDir, 'tunnel.log');

let serverChild = null;
let tunnelChild = null;
let shuttingDown = false;
let currentUrl = '';
let stable = false;

const cleanCode = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const grouped = value => value.length > 5 ? `${value.slice(0, 5)}-${value.slice(5)}` : value;
// 32 unambiguous characters, so each random byte maps exactly and the code is
// always ten characters long.
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateCode = () => Array.from(randomBytes(10), byte => codeAlphabet[byte % codeAlphabet.length]).join('');

async function ensureDirs() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(toolsDir, { recursive: true });
}

async function accessCode(force = rotate) {
  if (process.env.ACCESS_CODE) return cleanCode(process.env.ACCESS_CODE);
  if (!force) {
    try {
      const existing = cleanCode(JSON.parse(await readFile(accessFile, 'utf8')).code);
      if (existing.length >= 8) return existing;
    } catch { /* First public run. */ }
  }
  const code = generateCode();
  await writeFile(accessFile, JSON.stringify({ code, createdAt: new Date().toISOString() }, null, 2));
  return code;
}

async function writePublic(url, provider) {
  currentUrl = url;
  stable = provider === 'tailscale' || provider === 'configured-cloudflare';
  await writeFile(publicFile, JSON.stringify({
    url, provider, stable, startedAt: new Date().toISOString(), pid: process.pid,
  }, null, 2));
}

async function clearPublic() {
  currentUrl = '';
  await rm(publicFile, { force: true });
}

async function ping() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch { return false; }
}

async function ensureServer() {
  if (await ping()) {
    console.log(`Using the Dinosour server already running on port ${port}.`);
    return;
  }
  console.log('Starting the Dinosour server...');
  serverChild = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, HOST: host, PORT: String(port) }, stdio: 'inherit', windowsHide: true,
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 400));
    if (await ping()) return;
    if (serverChild.exitCode != null) break;
  }
  throw new Error(`The server did not start on port ${port}.`);
}

function usableCloudflared(executable) {
  try {
    execFileSync(executable, ['--version'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    return true;
  } catch { return false; }
}

async function downloadCloudflared(executable) {
  const asset = process.platform === 'win32' ? 'cloudflared-windows-amd64.exe'
    : process.platform === 'darwin' ? 'cloudflared-darwin-amd64.tgz' : 'cloudflared-linux-amd64';
  console.log('Downloading the Cloudflare tunnel client (one time, about 55 MB)...');
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Cloudflared download failed (HTTP ${response.status}).`);
  if (asset.endsWith('.tgz')) {
    const archive = path.join(toolsDir, asset);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    execFileSync('tar', ['-xzf', archive, '-C', toolsDir]);
  } else {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(executable));
  }
  if (process.platform !== 'win32') await chmod(executable, 0o755).catch(() => {});
  if (!usableCloudflared(executable)) {
    await rm(executable, { force: true });
    throw new Error('The tunnel download was incomplete. Check your connection and try again.');
  }
}

async function ensureCloudflared() {
  const executable = process.env.CLOUDFLARED_PATH || path.join(toolsDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  try {
    await access(executable);
    if (usableCloudflared(executable)) return executable;
    await rm(executable, { force: true });
  } catch { /* Download the standalone tunnel client. */ }
  await downloadCloudflared(executable);
  return executable;
}

function commandExists(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function tailscaleUrl() {
  const raw = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', windowsHide: true });
  const status = JSON.parse(raw);
  const name = String(status.Self?.DNSName || '').replace(/\.$/, '');
  if (!name) throw new Error('Tailscale is installed but this computer is not signed in yet. Run "tailscale up" and sign in once.');
  execFileSync('tailscale', ['funnel', '--bg', String(port)], { stdio: 'inherit', windowsHide: true });
  return `https://${name}`;
}

async function startCloudflaredQuick() {
  const executable = await ensureCloudflared();
  return new Promise((resolve, reject) => {
    let settled = false, output = '', timer;
    const child = spawn(executable, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--loglevel', 'info'], {
      windowsHide: true,
    });
    tunnelChild = child;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(value);
    };
    const onOutput = chunk => {
      const text = chunk.toString();
      output = (output + text).slice(-8000);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) settle(resolve, match[0]);
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('error', error => settle(reject, error));
    child.on('exit', code => {
      settle(reject, new Error(`Cloudflare tunnel exited (${code}). ${output.trim().slice(-400)}`));
    });
    timer = setTimeout(() => {
      if (settled) return;
      settle(reject, new Error('The Cloudflare tunnel did not return an address. Check data/tunnel.log or your network/firewall.'));
      child.kill();
    }, 45000);
  });
}

async function startCloudflaredNamed(token, publicOrigin) {
  const executable = await ensureCloudflared();
  tunnelChild = spawn(executable, ['tunnel', '--no-autoupdate', 'run', '--token', token], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(tunnelLog, { flags: 'a' });
  tunnelChild.stdout.pipe(log);
  tunnelChild.stderr.pipe(log);
  return publicOrigin;
}

function monitorTunnel(label, restart) {
  if (!tunnelChild) return;
  tunnelChild.on('exit', code => {
    if (shuttingDown) return;
    console.error(`\n${label} stopped (${code}). Reconnecting in 4 seconds...`);
    clearPublic().catch(() => {});
    setTimeout(restart, 4000);
  });
}

async function startQuickLoop() {
  const connect = async () => {
    if (shuttingDown) return;
    try {
      const url = await startCloudflaredQuick();
      await writePublic(url, 'cloudflare-quick');
      printShare(url);
      monitorTunnel('The public tunnel', connect);
    } catch (error) {
      if (shuttingDown) return;
      console.error(error.message);
      setTimeout(connect, 5000);
    }
  };
  await connect();
}

function printShare(url, lanOnly = false) {
  console.log('');
  if (lanOnly) {
    console.log('  Dinosour is available on your local network:');
    console.log(`  LAN link:     ${url}`);
    console.log('');
    console.log('  Devices on the same Wi-Fi do not need an access code.');
    console.log('  This command does not start a public tunnel. Run "npm run share" for a link to another country.');
    console.log('');
    return;
  }
  console.log('  Dinosour is available outside your Wi-Fi:');
  console.log(`  Public link:  ${url}`);
  console.log(`  Access code:  ${grouped(code)}`);
  console.log(`  Invite link:  ${url}/unlock?code=${encodeURIComponent(code)}&next=/`);
  console.log('');
  console.log(stable
    ? '  This address stays the same while the server runs.'
    : '  This quick-tunnel address changes if the tunnel restarts. Keep this window open.');
  console.log('  Send the invite link to your friend. They enter the code once.');
  console.log('  Press Ctrl+C to stop public access.');
  console.log('');
}

let code = '';
let serverStarted = false;

async function main() {
  await ensureDirs();
  if (args.includes('--rotate-code')) {
    const next = await accessCode(true);
    console.log(`New access code: ${grouped(next)}`);
    console.log('Public links stay the same. Refresh the Share screen or send a new invite link.');
    return;
  }
  code = await accessCode();
  if (code.length < 8) throw new Error('ACCESS_CODE must be at least 8 characters.');
  await ensureServer();
  serverStarted = true;

  if (providerArg === 'none' || args.includes('--lan-only')) {
    const lan = Object.values((await import('node:os')).networkInterfaces()).flat()
      .filter(address => address && address.family === 'IPv4' && !address.internal)
      .map(address => `http://${address.address}:${port}`);
    console.log(`\nLAN access: ${lan.join(', ')}\n`);
    printShare(lan[0] || `http://localhost:${port}`, true);
    return;
  }

  const cloudflareToken = process.env.CLOUDFLARE_TUNNEL_TOKEN ||
    (await readFile(path.join(dataDir, 'cloudflared-token.txt'), 'utf8').catch(() => '')).trim();
  const configuredOrigin = (process.env.PUBLIC_ORIGIN ||
    (await readFile(path.join(dataDir, 'public-origin.txt'), 'utf8').catch(() => '')).trim()).replace(/\/+$/, '');

  if (providerArg === 'tailscale' || (providerArg === 'auto' && !cloudflareToken && commandExists('tailscale') && args.includes('--stable'))) {
    console.log('Enabling Tailscale Funnel...');
    const url = tailscaleUrl();
    await writePublic(url, 'tailscale');
    printShare(url);
    return;
  }
  if (cloudflareToken && configuredOrigin) {
    console.log(`Starting the stable Cloudflare tunnel for ${configuredOrigin}...`);
    await startCloudflaredNamed(cloudflareToken, configuredOrigin);
    await writePublic(configuredOrigin, 'configured-cloudflare');
    printShare(configuredOrigin);
    monitorTunnel('The Cloudflare tunnel', () => startCloudflaredNamed(cloudflareToken, configuredOrigin)
      .then(() => writePublic(configuredOrigin, 'configured-cloudflare')).catch(error => console.error(error.message)));
    return;
  }
  if (providerArg === 'cloudflared' && cloudflareToken && !configuredOrigin) {
    throw new Error('Add data/public-origin.txt with your hostname (for example https://dinosour.example.com) before using a named Cloudflare tunnel.');
  }
  await startQuickLoop();
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nStopping public access (${signal ?? 'exit'})...`);
  if (currentUrl) await clearPublic().catch(() => {});
  if (tunnelChild && tunnelChild.exitCode == null) tunnelChild.kill();
  if (serverStarted && serverChild && serverChild.exitCode == null) serverChild.kill();
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', error => {
  console.error(error.stack || error.message);
  shutdown('error', 1);
});

main().catch(error => {
  console.error(error.message);
  shutdown('error', 1);
});
