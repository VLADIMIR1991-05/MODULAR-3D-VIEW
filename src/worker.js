import { buildTrimbleAuthorizeUrl, json, oauthStateCookie, parseCookies, safeEqual, sessionCookie, trimbleApiBase, TRIMBLE_ID_BASE } from './core.js';

const sessions = new Map();
const oauthStates = new Map();

function id() { return crypto.randomUUID(); }
function configured(env) { return Boolean(env.TRIMBLE_CLIENT_ID && env.TRIMBLE_APP_NAME && env.TRIMBLE_CALLBACK_URL); }
function sessionId(request) { return parseCookies(request.headers.get('cookie')).m3d_session; }
function useSecureCookies(request) { return new URL(request.url).protocol === 'https:'; }
async function getSession(request, env) {
  const currentSessionId = sessionId(request);
  if (!currentSessionId) return null;
  if (env.SESSIONS) return env.SESSIONS.get(`session:${currentSessionId}`, 'json');
  return sessions.get(currentSessionId) || null;
}
async function putSession(sessionId, value, env, ttl = 86400) {
  if (env.SESSIONS) return env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(value), { expirationTtl: ttl });
  sessions.set(sessionId, value);
}
async function deleteSession(sessionId, env) {
  if (!sessionId) return;
  if (env.SESSIONS) return env.SESSIONS.delete(`session:${sessionId}`);
  sessions.delete(sessionId);
}
async function putOauthState(state, value, env) {
  if (env.SESSIONS) return env.SESSIONS.put(`oauth:${state}`, JSON.stringify(value), { expirationTtl: 600 });
  oauthStates.set(state, value);
}
async function getOauthState(state, env) {
  if (env.SESSIONS) return env.SESSIONS.get(`oauth:${state}`, 'json');
  return oauthStates.get(state) || null;
}
async function deleteOauthState(state, env) {
  if (env.SESSIONS) return env.SESSIONS.delete(`oauth:${state}`);
  oauthStates.delete(state);
}

async function refreshTrimbleSession(request, session, env) {
  if (!session?.refreshToken || !env.TRIMBLE_CLIENT_SECRET) return session;
  if (session.expiresAt && session.expiresAt > Date.now() + 120000) return session;
  const credentials = btoa(`${env.TRIMBLE_CLIENT_ID}:${env.TRIMBLE_CLIENT_SECRET}`);
  const response = await fetch(`${TRIMBLE_ID_BASE}/oauth/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${credentials}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
  });
  if (!response.ok) return null;
  const tokens = await response.json();
  Object.assign(session, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || session.refreshToken,
    expiresIn: Number(tokens.expires_in || 3600),
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000
  });
  await putSession(sessionId(request), session, env);
  return session;
}

async function validateLicense(body, env) {
  if (!body.email || !body.licenseKey) return { valid: false, message: 'Correo y licencia son obligatorios.' };
  if (env.LICENSE_SERVER_URL) {
    const response = await fetch(env.LICENSE_SERVER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(env.LICENSE_SERVER_TOKEN ? { authorization: `Bearer ${env.LICENSE_SERVER_TOKEN}` } : {}) },
      body: JSON.stringify({ email: body.email, license_key: body.licenseKey, product: 'MODULAR-3D VIEW' })
    });
    if (!response.ok) return { valid: false, message: 'La licencia no pudo validarse.' };
    const result = await response.json();
    return { valid: Boolean(result.valid ?? result.active), message: result.message || '' };
  }
  const demo = env.ALLOW_DEMO_LICENSE === 'true' && safeEqual(body.licenseKey, env.DEMO_LICENSE_KEY || 'M3D-VIEW-2026-DEMO');
  return { valid: demo, message: demo ? 'Licencia demostrativa activa.' : 'Servidor de licencias pendiente de configurar.' };
}

async function api(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') return json({ ok: true, service: 'MODULAR-3D VIEW' });
  if (url.pathname === '/api/config') return json({ trimbleConfigured: configured(env), demoEnabled: env.ALLOW_DEMO_LICENSE === 'true' });
  if (url.pathname === '/api/license/validate' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const result = await validateLicense(body, env);
    if (!result.valid) return json(result, 401);
    const sessionId = id(); await putSession(sessionId, { email: body.email, licensed: true, createdAt: Date.now() }, env);
    return json(result, 200, { 'set-cookie': sessionCookie(sessionId, 3600, useSecureCookies(request)) });
  }
  if (url.pathname === '/api/trimble/login') {
    const session = await getSession(request, env);
    if (!session?.licensed) return Response.redirect(new URL('/?error=license_required', url), 302);
    if (!configured(env)) return Response.redirect(new URL('/?error=trimble_not_configured', url), 302);
    const state = id(); await putOauthState(state, { session, createdAt: Date.now() }, env);
    return new Response(null, { status: 302, headers: { location: buildTrimbleAuthorizeUrl(env, state, url.searchParams.get('prompt') || 'login'), 'set-cookie': oauthStateCookie(state, useSecureCookies(request)) } });
  }
  if (url.pathname === '/api/trimble/callback') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const cookies = parseCookies(request.headers.get('cookie'));
    const oauthState = state ? await getOauthState(state, env) : null;
    if (!state || !code || !safeEqual(state, cookies.m3d_oauth_state) || !oauthState) return Response.redirect(new URL('/?error=oauth_state', url), 302);
    const credentials = btoa(`${env.TRIMBLE_CLIENT_ID}:${env.TRIMBLE_CLIENT_SECRET}`);
    const tokenResponse = await fetch(`${TRIMBLE_ID_BASE}/oauth/token`, { method: 'POST', headers: { authorization: `Basic ${credentials}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: env.TRIMBLE_CLIENT_ID, redirect_uri: env.TRIMBLE_CALLBACK_URL }) });
    if (!tokenResponse.ok) return Response.redirect(new URL('/?error=oauth_token', url), 302);
    const tokens = await tokenResponse.json();
    const expiresIn = Number(tokens.expires_in || 3600);
    const sessionId = id(); await putSession(sessionId, { ...oauthState.session, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, expiresIn, expiresAt: Date.now() + expiresIn * 1000 }, env); await deleteOauthState(state, env);
    return new Response(null, { status: 302, headers: { location: '/?connected=1', 'set-cookie': sessionCookie(sessionId, 86400, useSecureCookies(request)) } });
  }
  if (url.pathname === '/api/projects') {
    const session = await refreshTrimbleSession(request, await getSession(request, env), env);
    if (!session?.accessToken) return json({ error: 'trimble_required' }, 401);
    const response = await fetch(`${trimbleApiBase(env.TRIMBLE_REGION)}/tc/api/2.0/projects?fullyLoaded=false`, { headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' } });
    if (!response.ok) return json({ error: 'trimble_projects', status: response.status }, 502);
    return json(await response.json());
  }
  if (url.pathname === '/api/trimble/embed-session') {
    const session = await refreshTrimbleSession(request, await getSession(request, env), env);
    if (!session?.accessToken) return json({ error: 'trimble_required' }, 401);
    return json({ accessToken: session.accessToken, expiresIn: session.expiresIn || 3600, region: env.TRIMBLE_REGION || 'us' }, 200, { 'cache-control': 'no-store' });
  }
  if (url.pathname === '/api/session') {
    const session = await getSession(request, env);
    return json({ licensed: Boolean(session?.licensed), trimbleConnected: Boolean(session?.accessToken), email: session?.email || null });
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const currentSessionId = sessionId(request); await deleteSession(currentSessionId, env);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0, useSecureCookies(request)) });
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env);
    return env.ASSETS.fetch(request);
  }
};
