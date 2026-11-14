import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('access code protects public clients while loopback and health checks stay open', async t => {
  const port = await freePort();
  const mediaPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const media = `http://127.0.0.1:${mediaPort}`;
  const publicHeaders = {
    'x-forwarded-host': 'public.example.com',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.9',
  };
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), MEDIA_PORT: String(mediaPort),
      ACCESS_CODE: 'TESTCODE12', PUBLIC_ORIGIN: 'https://public.example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(() => { if (child.exitCode == null) child.kill(); });

  let up = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode != null) break;
    try {
      if ((await fetch(base + '/api/ping')).ok) { up = true; break; }
    } catch { /* Still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(up, true, `test server did not start:\n${logs}`);

  // Loopback (localhost and Wi-Fi/LAN clients by extension) never needs the code.
  const local = await fetch(base + '/', { headers: { accept: 'text/html' } });
  assert.equal(local.status, 200);
  assert.match(await local.text(), /Dinosour/);
  const localNetwork = await fetch(base + '/api/network');
  assert.equal(localNetwork.status, 200);
  const localInfo = await localNetwork.json();
  assert.equal(localInfo.accessRequired, true);
  assert.equal(localInfo.accessCode, 'TESTCODE12');
  assert.equal(localInfo.publicUrl, 'https://public.example.com');
  assert.equal(localInfo.inviteUrl, 'https://public.example.com/unlock?code=TESTCODE12&next=/');

  // Tunneled requests are public, so the app and APIs require the code.
  const remoteRoot = await fetch(base + '/', { headers: { ...publicHeaders, accept: 'text/html' } });
  assert.equal(remoteRoot.status, 401);
  assert.match(await remoteRoot.text(), /Enter access code/);
  const remoteApi = await fetch(base + '/api/network', { headers: publicHeaders });
  assert.equal(remoteApi.status, 401);
  assert.match(await remoteApi.json().then(body => body.error), /access code/i);
  assert.equal((await fetch(base + '/api/ping', { headers: publicHeaders })).status, 200);
  assert.equal((await fetch(base + '/icon.svg', { headers: publicHeaders })).status, 200);
  assert.equal((await fetch(base + '/app-update.json', { headers: publicHeaders })).status, 200);

  // Wrong, missing and malformed invites stay locked.
  assert.equal((await fetch(base + '/unlock', { headers: publicHeaders })).status, 401);
  const wrong = await fetch(base + '/unlock?code=NOPE', { headers: { ...publicHeaders, accept: 'text/html' } });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /not correct/);

  // A grouped/lowercase code is normalized, sets a persistent secure cookie,
  // and refuses an open redirect.
  const unlock = await fetch(base + '/unlock?code=test-code-12&next=%2F%3Fx%3D1', { headers: publicHeaders, redirect: 'manual' });
  assert.equal(unlock.status, 303);
  assert.equal(unlock.headers.get('location'), '/?x=1');
  const setCookie = unlock.headers.get('set-cookie') || '';
  assert.match(setCookie, /dinosour_access=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await fetch(base + '/', { headers: { ...publicHeaders, cookie } })).status, 200);
  const remoteNetwork = await fetch(base + '/api/network', { headers: { ...publicHeaders, cookie } });
  assert.equal(remoteNetwork.status, 200);
  const remoteInfo = await remoteNetwork.json();
  assert.equal(remoteInfo.accessRequired, true);
  assert.equal(remoteInfo.publicStable, true);

  const redirect = await fetch(base + '/unlock?code=TESTCODE12&next=//evil.example', { headers: publicHeaders, redirect: 'manual' });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get('location'), '/');

  // Media has the same gate; a tunneled request cannot stream without the
  // unlock cookie even though the media listener is local.
  assert.equal((await fetch(media + '/api/stream/invalid', { headers: publicHeaders })).status, 401);
  assert.equal((await fetch(media + '/api/stream/invalid', { headers: { ...publicHeaders, cookie } })).status, 410);
});
