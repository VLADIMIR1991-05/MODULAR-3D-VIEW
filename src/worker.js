import { buildTrimbleAuthorizeUrl, json, oauthStateCookie, parseCookies, safeEqual, sessionCookie, trimbleApiBase, TRIMBLE_ID_BASE } from './core.js';
import { licenseApi, validateLicenseKey } from './license.js';
import { temporaryMigration } from './temporary-migration.js';

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
  if (env.DB) return validateLicenseKey(body.email, body.licenseKey, env);
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

function safeModelPath(value) {
  const decoded = decodeURIComponent(value || '').replace(/\\/g, '/');
  if (!decoded || decoded.includes('..') || decoded.startsWith('/')) return null;
  return decoded.split('/').filter(Boolean).map(part => part.replace(/[^0-9A-Za-z._ -]/g, '_')).join('/');
}
function normalizedProjectKey(value) {
  return String(value || 'Proyecto').trim().toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-').replace(/^-|-$/g, '').slice(0, 100) || 'proyecto';
}

const FREE_BYTES = 10 * 1024 ** 3;
const WARNING_BYTES = 8 * 1024 ** 3;
const SAFE_LIMIT_BYTES = 9 * 1024 ** 3;
function ownerModelsKey(email) { return `models:owner:${encodeURIComponent(String(email || '').toLowerCase())}`; }
async function getOwnerModelIds(email, env) {
  if (!env.SESSIONS) return [];
  return (await env.SESSIONS.get(ownerModelsKey(email), 'json')) || [];
}
async function putOwnerModelIds(email, ids, env) {
  return env.SESSIONS.put(ownerModelsKey(email), JSON.stringify([...new Set(ids)].slice(-500)));
}
async function listModelObjects(modelId, env) {
  if (!env.MODELS?.list) return [];
  const objects = [];
  let cursor;
  do {
    const page = await env.MODELS.list({ prefix: `models/${modelId}/`, ...(cursor ? { cursor } : {}), limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return objects;
}
async function getOwnedModels(email, env) {
  let ids = await getOwnerModelIds(email, env);
  if (!ids.length && env.SESSIONS?.list) {
    const listed = await env.SESSIONS.list({ prefix: 'model:', limit: 1000 });
    const legacyModels = (await Promise.all(listed.keys.map(item => env.SESSIONS.get(item.name, 'json')))).filter(model => String(model?.owner).toLowerCase() === String(email).toLowerCase());
    ids = legacyModels.map(model => model.id);
    if (ids.length) await putOwnerModelIds(email, ids, env);
  }
  const models = (await Promise.all(ids.map(modelId => env.SESSIONS.get(`model:${modelId}`, 'json')))).filter(model => String(model?.owner).toLowerCase() === String(email).toLowerCase());
  await Promise.all(models.map(async model => {
    if (model.sizeBytes || !env.MODELS) return;
    model.sizeBytes = (await listModelObjects(model.id, env)).reduce((total, object) => total + Number(object.size || 0), 0);
    await env.SESSIONS.put(`model:${model.id}`, JSON.stringify(model));
  }));
  return models.sort((a, b) => b.createdAt - a.createdAt);
}
async function bucketUsedBytes(env) {
  if (!env.MODELS?.list) return 0;
  let total = 0;
  let cursor;
  do {
    const page = await env.MODELS.list({ prefix: 'models/', ...(cursor ? { cursor } : {}), limit: 1000 });
    total += page.objects.reduce((sum, object) => sum + Number(object.size || 0), 0);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return total;
}
function storageSummary(models, actualUsedBytes = null) {
  const usedBytes = actualUsedBytes ?? models.reduce((total, model) => total + Number(model.sizeBytes || 0), 0);
  return { usedBytes, freeBytes: FREE_BYTES, warningBytes: WARNING_BYTES, safeLimitBytes: SAFE_LIMIT_BYTES, percent: Math.min(100, usedBytes / FREE_BYTES * 100), warning: usedBytes >= WARNING_BYTES };
}
async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function sharedAccessAllowed(metadata, request, env) {
  const url = new URL(request.url);
  if (!metadata || metadata.active === false || (metadata.expiresAt && metadata.expiresAt < Date.now()) || !safeEqual(metadata.shareToken, url.searchParams.get('token'))) return false;
  if (!metadata.passwordHash) return true;
  const accessId = parseCookies(request.headers.get('cookie')).m3d_share_access;
  if (!accessId || !env.SESSIONS) return false;
  const access = await env.SESSIONS.get(`share-access:${accessId}`, 'json');
  return Boolean(access && access.modelId === metadata.id && access.expiresAt > Date.now());
}
function shareAccessCookie(value, maxAge, secure) {
  return `m3d_share_access=${value}; Path=/api/shared/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function clientAddress(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}
function isAdmin(session, env) {
  return Boolean(session?.email && env.MASTER_EMAIL && String(session.email).toLowerCase() === String(env.MASTER_EMAIL).toLowerCase());
}

async function api(request, env) {
  const url = new URL(request.url);
  const licenseResponse = await licenseApi(request, env);
  if (licenseResponse) return licenseResponse;
  if (url.pathname === '/api/health') return json({ ok: true, service: 'MODULAR-3D VIEW' });
  if (url.pathname === '/api/config') return json({ trimbleConfigured: configured(env), demoEnabled: env.ALLOW_DEMO_LICENSE === 'true' });
  if (url.pathname === '/api/license/validate' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const result = await validateLicense(body, env);
    if (!result.valid) return json(result, 401);
    const sessionId = id(); await putSession(sessionId, { email: body.email, licensed: true, createdAt: Date.now() }, env);
    return json(result, 200, { 'set-cookie': sessionCookie(sessionId, 3600, useSecureCookies(request)) });
  }
  if (url.pathname === '/api/models' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session?.licensed) return json({ error: 'license_required' }, 401);
    const models = await getOwnedModels(session.email, env);
    const actualUsedBytes = await bucketUsedBytes(env);
    return json({
      models: models.map(model => ({ id: model.id, name: model.name, version: model.version || 1, projectKey: model.projectKey || normalizedProjectKey(model.name), sizeBytes: model.sizeBytes || 0, createdAt: model.createdAt, expiresAt: model.expiresAt || null, active: model.active !== false && (!model.expiresAt || model.expiresAt > Date.now()), url: `${env.APP_BASE_URL || url.origin}/view/${model.id}?token=${model.shareToken}` })),
      storage: storageSummary(models, actualUsedBytes)
    }, 200, { 'cache-control': 'no-store' });
  }
  if (url.pathname === '/api/admin/summary' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!isAdmin(session, env)) return json({ error: 'forbidden' }, 403);
    const listed = await env.SESSIONS.list({ prefix: 'model:', limit: 1000 });
    const models = (await Promise.all(listed.keys.map(item => env.SESSIONS.get(item.name, 'json')))).filter(Boolean);
    const byOwner = new Map();
    models.forEach(item => {
      const owner = String(item.owner || 'sin propietario').toLowerCase();
      const current = byOwner.get(owner) || { owner, projects: 0, bytes: 0 };
      current.projects += 1;
      current.bytes += Number(item.sizeBytes || 0);
      byOwner.set(owner, current);
    });
    return json({ projects: models.length, usedBytes: await bucketUsedBytes(env), owners: [...byOwner.values()].sort((a, b) => b.bytes - a.bytes) }, 200, { 'cache-control': 'no-store' });
  }
  if (url.pathname === '/api/models/init' && request.method === 'POST') {
    const session = await getSession(request, env);
    if (!session?.licensed) return json({ error: 'license_required' }, 401);
    if (!env.MODELS) return json({ error: 'r2_not_configured', message: 'El almacenamiento para celulares todavía no está conectado.' }, 503);
    const body = await request.json().catch(() => ({}));
    const requestedBytes = Math.max(0, Number(body.totalSize || 0));
    const ownedModels = await getOwnedModels(session.email, env);
    const storage = storageSummary(ownedModels, await bucketUsedBytes(env));
    if (requestedBytes > 1024 ** 3) return json({ error: 'model_too_large', message: 'El proyecto supera el límite de seguridad de 1 GB.' }, 413);
    if (storage.usedBytes + requestedBytes > SAFE_LIMIT_BYTES) return json({ error: 'storage_limit', message: 'La publicación superaría el límite preventivo de 9 GB. Elimina proyectos antiguos antes de continuar.' }, 413);
    const modelId = id();
    const shareToken = id().replace(/-/g, '') + id().replace(/-/g, '');
    const name = String(body.name || 'Proyecto').slice(0, 120);
    const projectKey = normalizedProjectKey(name);
    const version = Math.max(0, ...ownedModels.filter(model => (model.projectKey || normalizedProjectKey(model.name)) === projectKey).map(model => Number(model.version || 1))) + 1;
    const metadata = {
      id: modelId,
      name,
      projectKey,
      version,
      owner: session.email,
      shareToken,
      files: [],
      sizeBytes: requestedBytes,
      active: true,
      passwordHash: body.password ? await sha256Hex(String(body.password).slice(0, 64)) : null,
      permission: ['view', 'measure', 'download'].includes(body.permission) ? body.permission : 'measure',
      expiresAt: Date.now() + Math.min(Math.max(Number(body.expiresDays || 30), 1), 365) * 86400000,
      createdAt: Date.now()
    };
    await env.SESSIONS.put(`model:${modelId}`, JSON.stringify(metadata));
    await putOwnerModelIds(session.email, [...await getOwnerModelIds(session.email, env), modelId], env);
    return json({ id: modelId, version, storage: { ...storage, projectedBytes: storage.usedBytes + requestedBytes } });
  }
  const uploadMatch = url.pathname.match(/^\/api\/models\/([^/]+)\/files\/(.+)$/);
  if (uploadMatch && request.method === 'PUT') {
    const session = await getSession(request, env);
    const metadata = env.SESSIONS ? await env.SESSIONS.get(`model:${uploadMatch[1]}`, 'json') : null;
    if (!session?.licensed || !metadata || metadata.owner !== session.email) return json({ error: 'forbidden' }, 403);
    if (!env.MODELS) return json({ error: 'r2_not_configured' }, 503);
    const path = safeModelPath(uploadMatch[2]);
    if (!path) return json({ error: 'invalid_path' }, 400);
    await env.MODELS.put(`models/${metadata.id}/${path}`, request.body, {
      httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' }
    });
    return json({ ok: true, path });
  }
  const finalizeMatch = url.pathname.match(/^\/api\/models\/([^/]+)\/finalize$/);
  if (finalizeMatch && request.method === 'POST') {
    const session = await getSession(request, env);
    const key = `model:${finalizeMatch[1]}`;
    const metadata = env.SESSIONS ? await env.SESSIONS.get(key, 'json') : null;
    if (!session?.licensed || !metadata || metadata.owner !== session.email) return json({ error: 'forbidden' }, 403);
    const body = await request.json().catch(() => ({}));
    metadata.files = Array.isArray(body.files) ? body.files.map(file => safeModelPath(typeof file === 'string' ? file : file.path)).filter(Boolean).slice(0, 500) : [];
    if (Array.isArray(body.files)) metadata.sizeBytes = body.files.reduce((total, file) => total + Math.max(0, Number(typeof file === 'object' ? file.size : 0)), 0) || metadata.sizeBytes;
    metadata.entry = metadata.files.find(file => /\.(glb|gltf|dae)$/i.test(file)) || null;
    if (!metadata.entry) return json({ error: 'model_required', message: 'No se encontró un archivo GLB, GLTF o DAE válido.' }, 400);
    await env.SESSIONS.put(key, JSON.stringify(metadata));
    return json({ url: `${env.APP_BASE_URL || url.origin}/view/${metadata.id}?token=${metadata.shareToken}` });
  }
  const manageMatch = url.pathname.match(/^\/api\/models\/([^/]+)$/);
  if (manageMatch && ['PATCH', 'DELETE'].includes(request.method)) {
    const session = await getSession(request, env);
    const key = `model:${manageMatch[1]}`;
    const metadata = env.SESSIONS ? await env.SESSIONS.get(key, 'json') : null;
    if (!session?.licensed || !metadata || metadata.owner !== session.email) return json({ error: 'forbidden' }, 403);
    if (request.method === 'DELETE') {
      if (env.MODELS) {
        const objects = await listModelObjects(metadata.id, env);
        if (objects.length) await env.MODELS.delete(objects.map(object => object.key));
      }
      await env.SESSIONS.delete(key);
      await putOwnerModelIds(session.email, (await getOwnerModelIds(session.email, env)).filter(modelId => modelId !== metadata.id), env);
      return json({ ok: true });
    }
    const body = await request.json().catch(() => ({}));
    if (body.name) metadata.name = String(body.name).slice(0, 120);
    if (typeof body.active === 'boolean') metadata.active = body.active;
    if (body.regenerateToken) {
      metadata.shareToken = id().replace(/-/g, '') + id().replace(/-/g, '');
      metadata.expiresAt = Date.now() + 30 * 86400000;
    }
    if (body.expiresDays) metadata.expiresAt = Date.now() + Math.min(Math.max(Number(body.expiresDays), 1), 365) * 86400000;
    await env.SESSIONS.put(key, JSON.stringify(metadata));
    return json({ ok: true, url: `${env.APP_BASE_URL || url.origin}/view/${metadata.id}?token=${metadata.shareToken}` });
  }
  const manifestMatch = url.pathname.match(/^\/api\/shared\/([^/]+)\/manifest$/);
  if (manifestMatch && request.method === 'GET') {
    const metadata = env.SESSIONS ? await env.SESSIONS.get(`model:${manifestMatch[1]}`, 'json') : null;
    if (!await sharedAccessAllowed(metadata, request, env)) {
      if (metadata?.passwordHash && safeEqual(metadata.shareToken, url.searchParams.get('token'))) return json({ error: 'password_required', message: 'Este proyecto requiere contraseña.' }, 401);
      return json({ error: 'not_found', message: 'El enlace no existe, fue desactivado o venció.' }, 404);
    }
    return json({ id: metadata.id, name: metadata.name, version: metadata.version || 1, files: metadata.files, entry: metadata.entry, permission: metadata.permission || 'measure' }, 200, { 'cache-control': 'no-store' });
  }
  const unlockMatch = url.pathname.match(/^\/api\/shared\/([^/]+)\/unlock$/);
  if (unlockMatch && request.method === 'POST') {
    const metadata = env.SESSIONS ? await env.SESSIONS.get(`model:${unlockMatch[1]}`, 'json') : null;
    const body = await request.json().catch(() => ({}));
    if (!metadata || metadata.active === false || !safeEqual(metadata.shareToken, body.token)) return json({ error: 'not_found' }, 404);
    const attemptKey = `share-attempt:${metadata.id}:${clientAddress(request)}`;
    const attempts = Number(await env.SESSIONS.get(attemptKey) || 0);
    if (attempts >= 8) return json({ error: 'rate_limited', message: 'Demasiados intentos. Espera 15 minutos.' }, 429, { 'retry-after': '900' });
    if (!metadata.passwordHash || !safeEqual(metadata.passwordHash, await sha256Hex(body.password))) {
      await env.SESSIONS.put(attemptKey, String(attempts + 1), { expirationTtl: 900 });
      return json({ error: 'invalid_password', message: 'Contraseña incorrecta.' }, 401);
    }
    await env.SESSIONS.delete(attemptKey);
    const accessId = id().replace(/-/g, '') + id().replace(/-/g, '');
    await env.SESSIONS.put(`share-access:${accessId}`, JSON.stringify({ modelId: metadata.id, expiresAt: Date.now() + 3600000 }), { expirationTtl: 3600 });
    return json({ ok: true }, 200, { 'set-cookie': shareAccessCookie(accessId, 3600, useSecureCookies(request)), 'cache-control': 'no-store' });
  }
  const sharedFileMatch = url.pathname.match(/^\/api\/shared\/([^/]+)\/file\/(.+)$/);
  if (sharedFileMatch && request.method === 'GET') {
    const metadata = env.SESSIONS ? await env.SESSIONS.get(`model:${sharedFileMatch[1]}`, 'json') : null;
    if (!await sharedAccessAllowed(metadata, request, env) || !env.MODELS) return json({ error: 'not_found' }, 404);
    const path = safeModelPath(sharedFileMatch[2]);
    if (!path || !metadata.files.includes(path)) return json({ error: 'not_found' }, 404);
    const object = await env.MODELS.get(`models/${metadata.id}/${path}`);
    if (!object) return json({ error: 'not_found' }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'private, max-age=3600');
    return new Response(object.body, { headers });
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
    return json({ licensed: Boolean(session?.licensed), trimbleConnected: Boolean(session?.accessToken), email: session?.email || null, isAdmin: isAdmin(session, env) });
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const currentSessionId = sessionId(request); await deleteSession(currentSessionId, env);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0, useSecureCookies(request)) });
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    const migrationResponse = await temporaryMigration(request, env);
    if (migrationResponse) return migrationResponse;
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env);
    return env.ASSETS.fetch(request);
  }
};
