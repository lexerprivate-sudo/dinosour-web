import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const swPath = path.join(publicDir, 'sw.js');
const swSource = readFileSync(swPath, 'utf8');

// Extract `const CACHE = '...'` without executing the worker.
function extractCache(source) {
  const match = source.match(/const\s+CACHE\s*=\s*'([^']+)'/);
  return match ? match[1] : null;
}

// Extract the `const SHELL = [ ... ]` array and read its quoted entries.
function extractShell(source) {
  const match = source.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

const CACHE = extractCache(swSource);
const SHELL = extractShell(swSource);

test('sw.js declares a versioned dinosour-shell CACHE name', () => {
  assert.ok(CACHE, 'could not find `const CACHE = \'...\'` in public/sw.js');
  assert.match(CACHE, /^dinosour-shell-v\d+$/,
    `CACHE must match /^dinosour-shell-v\\d+$/ but got "${CACHE}"`);
});

test('sw.js declares a parseable SHELL precache list', () => {
  assert.ok(Array.isArray(SHELL), 'could not find `const SHELL = [ ... ]` in public/sw.js');
  assert.ok(SHELL.length > 0, 'SHELL must list at least one precached entry');
});

test('every SHELL entry resolves to a real file under public/', () => {
  assert.ok(Array.isArray(SHELL) && SHELL.length > 0, 'SHELL could not be parsed from public/sw.js');
  const missing = [];
  for (const entry of SHELL) {
    // '/' is served from public/index.html; other entries map onto public/<entry>.
    const relative = entry === '/' ? 'index.html' : entry.replace(/^\/+/, '');
    const resolved = path.join(publicDir, relative);
    // Guard against entries escaping public/ via .. segments.
    if (!resolved.startsWith(publicDir) || !existsSync(resolved) || !statSync(resolved).isFile()) {
      missing.push(entry);
    }
  }
  assert.deepEqual(missing, [],
    `SHELL lists entries that do not resolve to a file under public/:\n  ${missing.join('\n  ')}\n` +
    'Fix the path in public/sw.js or add the missing asset under public/.');
});

test('SHELL precaches the boot assets (/startup.js and /app.js)', () => {
  assert.ok(Array.isArray(SHELL), 'SHELL could not be parsed from public/sw.js');
  for (const required of ['/startup.js', '/app.js']) {
    assert.ok(SHELL.includes(required),
      `SHELL is missing required boot asset "${required}"; the offline shell cannot boot without it.`);
  }
});
