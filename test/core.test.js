import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrimbleAuthorizeUrl, parseCookies, safeEqual, trimbleApiBase } from '../src/core.js';

test('safeEqual compares complete values', () => {
  assert.equal(safeEqual('M3D-123', 'M3D-123'), true);
  assert.equal(safeEqual('M3D-123', 'M3D-124'), false);
  assert.equal(safeEqual('short', 'longer'), false);
});

test('parses cookies', () => assert.deepEqual(parseCookies('a=1; m3d_session=abc'), { a: '1', m3d_session: 'abc' }));

test('builds the Trimble authorization request', () => {
  const url = new URL(buildTrimbleAuthorizeUrl({ TRIMBLE_CLIENT_ID: 'client', TRIMBLE_APP_NAME: 'modular3d', TRIMBLE_CALLBACK_URL: 'https://example.com/api/trimble/callback' }, 'state'));
  assert.equal(url.origin, 'https://id.trimble.com');
  assert.equal(url.searchParams.get('client_id'), 'client');
  assert.equal(url.searchParams.get('scope'), 'openid modular3d');
  assert.equal(url.searchParams.get('state'), 'state');
});

test('selects a safe Connect region', () => {
  assert.match(trimbleApiBase('eu'), /app21/);
  assert.equal(trimbleApiBase('unknown'), trimbleApiBase('us'));
});
