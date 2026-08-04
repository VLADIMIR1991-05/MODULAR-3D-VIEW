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
