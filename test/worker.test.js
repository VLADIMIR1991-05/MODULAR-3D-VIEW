import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const env = {
  ALLOW_DEMO_LICENSE: 'true',
  DEMO_LICENSE_KEY: 'M3D-VIEW-2026-DEMO',
  ASSETS: { fetch: () => new Response('asset') }
};

test('health endpoint responds', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/health'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'MODULAR-3D VIEW' });
});

test('validates demo license and creates session', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/license/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', licenseKey: 'M3D-VIEW-2026-DEMO' })
  }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /m3d_session=/);
  assert.equal((await response.json()).valid, true);
});

test('rejects invalid license', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/license/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', licenseKey: 'INVALID' })
  }), env);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).valid, false);
});

test('protects Trimble projects without a session', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/projects'), env);
  assert.equal(response.status, 401);
});

test('publishes, accounts for, and deletes an R2 model', async () => {
  const values = new Map();
  const objects = new Map();
  const testEnv = {
    ...env,
    APP_BASE_URL: 'https://example.com',
    SESSIONS: {
      async get(key, type) { const value = values.get(key); return type === 'json' && value ? JSON.parse(value) : value || null; },
      async put(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
      async list({ prefix }) { return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), truncated: false }; }
    },
    MODELS: {
      async put(key, body) { const buffer = await new Response(body).arrayBuffer(); objects.set(key, { key, size: buffer.byteLength }); },
      async list({ prefix }) { return { objects: [...objects.values()].filter(object => object.key.startsWith(prefix)), truncated: false }; },
      async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }
    }
  };
  const login = await worker.fetch(new Request('https://example.com/api/license/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', licenseKey: 'M3D-VIEW-2026-DEMO' }) }), testEnv);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const init = await worker.fetch(new Request('https://example.com/api/models/init', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Prueba', totalSize: 4, expiresDays: 30, password: 'secreto', permission: 'measure' }) }), testEnv);
  assert.equal(init.status, 200);
  const { id, version } = await init.json();
  assert.equal(version, 1);
  const upload = await worker.fetch(new Request(`https://example.com/api/models/${id}/files/model.glb`, { method: 'PUT', headers: { cookie, 'content-type': 'model/gltf-binary' }, body: 'test' }), testEnv);
  assert.equal(upload.status, 200);
  const finalize = await worker.fetch(new Request(`https://example.com/api/models/${id}/finalize`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ path: 'model.glb', size: 4 }] }) }), testEnv);
  assert.equal(finalize.status, 200);
  const sharedUrl = new URL((await finalize.clone().json()).url);
  const token = sharedUrl.searchParams.get('token');
  const locked = await worker.fetch(new Request(`https://example.com/api/shared/${id}/manifest?token=${token}`), testEnv);
  assert.equal(locked.status, 401);
  const unlock = await worker.fetch(new Request(`https://example.com/api/shared/${id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: 'secreto' }) }), testEnv);
  assert.equal(unlock.status, 200);
  const shareCookie = unlock.headers.get('set-cookie').split(';')[0];
  const manifest = await worker.fetch(new Request(`https://example.com/api/shared/${id}/manifest?token=${token}`, { headers: { cookie: shareCookie } }), testEnv);
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).entry, 'model.glb');
  const listing = await worker.fetch(new Request('https://example.com/api/models', { headers: { cookie } }), testEnv);
  const listed = await listing.json();
  assert.equal(listed.models[0].sizeBytes, 4);
  assert.equal(listed.models[0].version, 1);
  const secondInit = await worker.fetch(new Request('https://example.com/api/models/init', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Prueba', totalSize: 0 }) }), testEnv);
  assert.equal(secondInit.status, 200);
  const second = await secondInit.json();
  assert.equal(second.version, 2);
  const removeSecond = await worker.fetch(new Request(`https://example.com/api/models/${second.id}`, { method: 'DELETE', headers: { cookie } }), testEnv);
  assert.equal(removeSecond.status, 200);
  const removed = await worker.fetch(new Request(`https://example.com/api/models/${id}`, { method: 'DELETE', headers: { cookie } }), testEnv);
  assert.equal(removed.status, 200);
  assert.equal(objects.size, 0);
});
