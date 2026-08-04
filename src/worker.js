import { buildTrimbleAuthorizeUrl, json, oauthStateCookie, parseCookies, safeEqual, sessionCookie, trimbleApiBase, TRIMBLE_ID_BASE } from './core.js';

const sessions = new Map();
const oauthStates = new Map();

function id() { return crypto.randomUUID(); }
function configured(env) { return Boolean(env.TRIMBLE_CLIENT_ID && env.TRIMBLE_APP_NAME && env.TRIMBLE_CALLBACK_URL); }
function getSession(request) { return sessions.get(parseCookies(request.headers.get('cookie')).m3d_session); }

async function validateLicense(body, env) {
  if (!body.email || !body.licenseKey) return { valid: false, message: 'Correo y licencia son obligatorios.' };
  if (env.LICENSE_SERVER_URL) {
    const response = await fetch(env.LICENSE_SERVER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(env.LICENSE_SERVER_TOKEN ? { authorization: `Bearer ${env.LICENSE_SERVER_TOKEN}` } : {}) },
      body: JSON.stringify({ email: body.email, license_key: body.licenseKey, product: 'MODURAL-3D VIEW' })
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
  if (url.pathname === '/api/health') return json({ ok: true, service: 'MODURAL-3D VIEW' });
  if (url.pathname === '/api/config') return json({ trimbleConfigured: configured(env), demoEnabled: env.ALLOW_DEMO_LICENSE === 'true' });
  if (url.pathname === '/api/license/validate' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const result = await validateLicense(body, env);
    if (!result.valid) return json(result, 401);
    const sessionId = id(); sessions.set(sessionId, { email: body.email, licensed: true, createdAt: Date.now() });
    return json(result, 200, { 'set-cookie': sessionCookie(sessionId) });
  }
  if (url.pathname === '/api/trimble/login') {
    const session = getSession(request);
    if (!session?.licensed) return Response.redirect(new URL('/?error=license_required', url), 302);
    if (!configured(env)) return Response.redirect(new URL('/?error=trimble_not_configured', url), 302);
    const state = id(); oauthStates.set(state, { session, createdAt: Date.now() });
    return new Response(null, { status: 302, headers: { location: buildTrimbleAuthorizeUrl(env, state, url.searchParams.get('prompt') || 'login'), 'set-cookie': oauthStateCookie(state) } });
  }
  if (url.pathname === '/api/trimble/callback') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const cookies = parseCookies(request.headers.get('cookie'));
    if (!state || !code || !safeEqual(state, cookies.m3d_oauth_state) || !oauthStates.has(state)) return Response.redirect(new URL('/?error=oauth_state', url), 302);
    const credentials = btoa(`${env.TRIMBLE_CLIENT_ID}:${env.TRIMBLE_CLIENT_SECRET}`);
    const tokenResponse = await fetch(`${TRIMBLE_ID_BASE}/oauth/token`, { method: 'POST', headers: { authorization: `Basic ${credentials}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: env.TRIMBLE_CLIENT_ID, redirect_uri: env.TRIMBLE_CALLBACK_URL }) });
    if (!tokenResponse.ok) return Response.redirect(new URL('/?error=oauth_token', url), 302);
    const tokens = await tokenResponse.json();
    const sessionId = id(); sessions.set(sessionId, { ...oauthStates.get(state).session, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token }); oauthStates.delete(state);
    return new Response(null, { status: 302, headers: { location: '/?connected=1', 'set-cookie': sessionCookie(sessionId, 86400) } });
  }
  if (url.pathname === '/api/projects') {
    const session = getSession(request);
    if (!session?.accessToken) return json({ error: 'trimble_required' }, 401);
    const response = await fetch(`${trimbleApiBase(env.TRIMBLE_REGION)}/tc/api/2.0/projects?fullyLoaded=false`, { headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' } });
    if (!response.ok) return json({ error: 'trimble_projects', status: response.status }, 502);
    return json(await response.json());
  }
  if (url.pathname === '/api/session') {
    const session = getSession(request);
    return json({ licensed: Boolean(session?.licensed), trimbleConnected: Boolean(session?.accessToken), email: session?.email || null });
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const sessionId = parseCookies(request.headers.get('cookie')).m3d_session; sessions.delete(sessionId);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
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
