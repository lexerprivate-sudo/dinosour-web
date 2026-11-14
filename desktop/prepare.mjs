import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const version = '2026.10.26';
const expected = 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d';
const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/`;
const directory = new URL('./runtime/', import.meta.url);
await mkdir(directory, { recursive: true });
async function download(name) {
  const response = await fetch(base + name, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download ${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const target = new URL('yt-dlp.exe', directory);
let binary;
try { binary = await readFile(target); } catch {}
const hash = value => createHash('sha256').update(value).digest('hex');
if (!binary || hash(binary) !== expected) binary = await download('yt-dlp.exe');
if (hash(binary) !== expected) throw new Error('Playback engine checksum mismatch');
await writeFile(target, binary);
await writeFile(new URL('version.json', directory), JSON.stringify({ version, sha256: expected }, null, 2));
console.log(`Verified yt-dlp ${version}: ${expected}`);
