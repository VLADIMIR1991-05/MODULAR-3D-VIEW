const encoder = new TextEncoder();

function response(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers
    }
  });
}

function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'); }
function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function unbase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}
async function verifyPassword(password, encoded) {
  try {
    const [algorithm, iterationText, saltText, digestText] = String(encoded).split('$');
    if (algorithm !== 'pbkdf2_sha256') return false;
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unbase64Url(saltText), iterations: Number(iterationText) }, key, 256);
    return constantTimeEqual(base64Url(new Uint8Array(bits)), base64Url(unbase64Url(digestText)));
  } catch { return false; }
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const digest = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210000 }, key, 256));
  return `pbkdf2_sha256$210000$${base64Url(salt)}$${base64Url(digest)}`;
}
async function issueToken(user, machineId, env, license = null) {
  const payload = { uid: user.id, email: user.email, device: machineId, license_id: license?.license_id || null, product: license?.product_code || 'modular3d_plugin', exp: Math.floor(Date.now() / 1000) + 3600, jti: crypto.randomUUID() };
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(body, env.MODULAR3D_TOKEN_SECRET)}`;
}
async function verifyToken(token, env) {
  try {
    const [body, signature] = token.split('.', 2);
    if (!constantTimeEqual(signature, await hmac(body, env.MODULAR3D_TOKEN_SECRET))) return [null, 'INVALID_TOKEN'];
    const payload = JSON.parse(new TextDecoder().decode(unbase64Url(body)));
    if (Number(payload.exp) <= Math.floor(Date.now() / 1000)) return [null, 'TOKEN_EXPIRED'];
    return [payload, null];
  } catch { return [null, 'INVALID_TOKEN']; }
}
function userState(user) {
  if (user.status !== 'active') return [false, 'LICENSE_BLOCKED', 'La licencia está bloqueada.'];
  if (!Number.isFinite(Date.parse(user.expires_at)) || Date.parse(user.expires_at) <= Date.now()) return [false, 'LICENSE_EXPIRED', 'La suscripción está vencida.'];
  return [true, null, null];
}
function licenseState(license) {
  if (!license) return [false, 'LICENSE_NOT_FOUND', 'Licencia no encontrada para este producto.'];
  if (license.license_status !== 'active' || Number(license.product_active) !== 1) return [false, 'LICENSE_BLOCKED', 'La licencia o el producto estan bloqueados.'];
  if (!Number.isFinite(Date.parse(license.license_expires_at)) || Date.parse(license.license_expires_at) <= Date.now()) return [false, 'LICENSE_EXPIRED', 'La suscripcion esta vencida.'];
  return [true, null, null];
}
async function audit(env, action, detail = {}, userId = null, machineId = null) {
  try {
    await env.DB.prepare('INSERT INTO license_audit_logs(user_id,action,machine_id,detail,created_at) VALUES(?1,?2,?3,?4,?5)')
      .bind(userId, action, machineId, JSON.stringify(detail), nowIso()).run();
  } catch { /* El registro de auditoría no debe bloquear una validación. */ }
}
function adminAllowed(request, env) {
  return Boolean(env.MODULAR3D_ADMIN_KEY && constantTimeEqual(request.headers.get('x-admin-key') || '', env.MODULAR3D_ADMIN_KEY));
}
function cookieValue(request, name) {
  const cookies = String(request.headers.get('cookie') || '').split(';');
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return '';
}
function masterCookie(value, maxAge, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `m3d_master=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
async function masterSession(request, env) {
  const sessionId = cookieValue(request, 'm3d_master');
  if (!sessionId || !env.SESSIONS) return null;
  const session = await env.SESSIONS.get(`master:${sessionId}`, 'json');
  if (!session || Number(session.expiresAt) <= Date.now()) return null;
  const admin = await env.DB.prepare('SELECT id,email,name,role,active FROM platform_admins WHERE id=?1 AND active=1').bind(session.adminId).first();
  return admin || null;
}
async function masterAllowed(request, env) {
  return adminAllowed(request, env) || Boolean(await masterSession(request, env));
}
async function jsonBody(request) {
  if (Number(request.headers.get('content-length') || 0) > 64000) throw new Error('REQUEST_TOO_LARGE');
  return request.json();
}
async function findUserByEmail(env, email) {
  return env.DB.prepare('SELECT * FROM license_users WHERE email=?1 COLLATE NOCASE LIMIT 1').bind(email).first();
}
async function findProductLicense(env, email, productCode = 'modular3d_plugin') {
  try {
    const result = await env.DB.prepare(`SELECT u.*,pl.id license_id,pl.credential_hash,pl.status license_status,
      pl.expires_at license_expires_at,pl.max_devices license_max_devices,pl.plan,
      p.code product_code,p.name product_name,p.active product_active
      FROM license_users u
      JOIN product_licenses pl ON pl.user_id=u.id
      JOIN platform_products p ON p.id=pl.product_id
      WHERE u.email=?1 COLLATE NOCASE AND p.code=?2 COLLATE NOCASE LIMIT 1`)
      .bind(email, productCode).first();
    if (!result) return null;
    return result.credential_hash ? result : { ...result, license_id: null,
      credential_hash: result.password_hash, license_status: result.status,
      license_expires_at: result.expires_at, license_max_devices: result.max_devices || 1,
      plan: 'legacy', product_code: 'modular3d_plugin',
      product_name: 'MODULAR-3D para SketchUp', product_active: 1 };
  } catch {
    // Compatibilidad durante el despliegue escalonado de la migracion 0003.
    if (productCode !== 'modular3d_plugin') return null;
    const legacy = await findUserByEmail(env, email);
    return legacy ? { ...legacy, license_id: null, credential_hash: legacy.password_hash,
      license_status: legacy.status, license_expires_at: legacy.expires_at,
      license_max_devices: legacy.max_devices, plan: 'legacy',
      product_code: 'modular3d_plugin', product_name: 'MODULAR-3D para SketchUp', product_active: 1 } : null;
  }
}
async function rateLimited(env, key, limit, windowSeconds = 900) {
  if (!env.SESSIONS) return false;
  const storageKey = `license-rate:${key}`;
  const attempts = Number(await env.SESSIONS.get(storageKey) || 0);
  if (attempts >= limit) return true;
  await env.SESSIONS.put(storageKey, String(attempts + 1), { expirationTtl: windowSeconds });
  return false;
}
async function clearRateLimit(env, key) {
  if (env.SESSIONS) await env.SESSIONS.delete(`license-rate:${key}`);
}
async function login(request, env) {
  const body = await jsonBody(request).catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const productCode = String(body.product_code || 'modular3d_plugin').trim().toLowerCase();
  const machineId = String(body.machine_id || '').trim();
  if (!email || !body.password || machineId.length < 20) return response({ ok: false, code: 'MISSING_FIELDS' }, 400);
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  if (await rateLimited(env, `login-ip:${clientIp}`, 10) || await rateLimited(env, `login-account:${email}`, 5)) {
    return response({ ok: false, code: 'TOO_MANY_ATTEMPTS', message: 'Demasiados intentos. Intenta nuevamente más tarde.' }, 429, { 'retry-after': '900' });
  }
  const user = await findProductLicense(env, email, productCode);
  if (!user || !await verifyPassword(String(body.password), user.credential_hash)) {
    await audit(env, 'login_failed', { email }, user?.id, machineId);
    return response({ ok: false, code: 'INVALID_CREDENTIALS' }, 401);
  }
  const [identityValid, identityCode, identityMessage] = userState(user);
  if (!identityValid) return response({ ok: false, code: identityCode, message: identityMessage }, 403);
  const [valid, code, message] = licenseState(user);
  if (!valid) return response({ ok: false, code, message }, 403);
  await clearRateLimit(env, `login-account:${email}`);
  const existing = await env.DB.prepare('SELECT id FROM license_devices WHERE user_id=?1 AND machine_id=?2').bind(user.id, machineId).first();
  const active = await env.DB.prepare('SELECT COUNT(*) count FROM license_devices WHERE user_id=?1 AND active=1').bind(user.id).first();
  if (!existing && Number(active.count) >= Number(user.license_max_devices)) {
    if (body.force_transfer === true) await env.DB.prepare('UPDATE license_devices SET active=0 WHERE user_id=?1').bind(user.id).run();
    else return response({ ok: false, code: 'DEVICE_CONFLICT', message: 'La licencia está activa en otra computadora.' }, 409);
  }
  const timestamp = nowIso();
  await env.DB.prepare(`INSERT INTO license_devices(user_id,machine_id,active,plugin_version,sketchup_version,first_seen_at,last_seen_at)
    VALUES(?1,?2,1,?3,?4,?5,?5) ON CONFLICT(user_id,machine_id) DO UPDATE SET active=1,plugin_version=excluded.plugin_version,sketchup_version=excluded.sketchup_version,last_seen_at=excluded.last_seen_at`)
    .bind(user.id, machineId, String(body.plugin_version || ''), String(body.sketchup_version || ''), timestamp).run();
  await audit(env, 'login', {}, user.id, machineId);
  return response({ ok: true, token: await issueToken(user, machineId, env, user), email: user.email, name: user.name, product: user.product_code, product_name: user.product_name, plan: user.plan, expires_at: user.license_expires_at, ttl_seconds: 3600 });
}
async function validateSession(request, env) {
  const body = await jsonBody(request).catch(() => ({}));
  const [token, error] = await verifyToken(String(body.token || ''), env);
  if (error) return response({ ok: false, code: error }, 401);
  const machineId = String(body.machine_id || '');
  if (machineId !== token.device) return response({ ok: false, code: 'DEVICE_MISMATCH' }, 403);
  const user = await env.DB.prepare('SELECT * FROM license_users WHERE id=?1').bind(token.uid).first();
  const device = await env.DB.prepare('SELECT * FROM license_devices WHERE user_id=?1 AND machine_id=?2 AND active=1').bind(token.uid, machineId).first();
  if (!user || !device) return response({ ok: false, code: 'DEVICE_REVOKED' }, 403);
  const [valid, code, message] = userState(user);
  if (!valid) return response({ ok: false, code, message }, 403);
  await env.DB.prepare('UPDATE license_devices SET last_seen_at=?1 WHERE id=?2').bind(nowIso(), device.id).run();
  return response({ ok: true, email: user.email, name: user.name, expires_at: user.expires_at, ttl_seconds: Math.min(3600, token.exp - Math.floor(Date.now() / 1000)) });
}
async function checkKey(request, env) {
  if (!env.LICENSE_SERVER_TOKEN || !constantTimeEqual((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), env.LICENSE_SERVER_TOKEN)) return response({ valid: false }, 401);
  const body = await jsonBody(request).catch(() => ({}));
  const result = await validateLicenseKey(String(body.email || ''), String(body.license_key || ''), env);
  return response(result, result.valid ? 200 : 401);
}
export async function validateLicenseKey(email, licenseKey, env) {
  if (!env.DB) return { valid: false, active: false, message: 'Base de licencias no configurada.' };
  const user = await findProductLicense(env, String(email || '').trim().toLowerCase(), 'modular3d_plugin');
  const [valid, , message] = user ? licenseState(user) : [false, null, 'Licencia no encontrada.'];
  const passwordValid = user && await verifyPassword(String(licenseKey || ''), user.credential_hash);
  return { valid: Boolean(valid && passwordValid), active: Boolean(valid && passwordValid), message: valid && passwordValid ? 'Licencia activa.' : message || 'Licencia inválida.' };
}
async function adminUsers(request, env) {
  if (!await masterAllowed(request, env)) return response({ ok: false, code: 'ADMIN_UNAUTHORIZED' }, 401);
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT u.id,u.email,u.name,u.status,u.expires_at,u.max_devices,u.created_at,
      SUM(CASE WHEN d.active=1 THEN 1 ELSE 0 END) active_devices,MAX(d.last_seen_at) last_seen_at
      FROM license_users u LEFT JOIN license_devices d ON d.user_id=u.id GROUP BY u.id ORDER BY u.id DESC`).all();
    return response(results);
  }
  const body = await jsonBody(request).catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email.includes('@') || password.length < 10) return response({ ok: false, message: 'Correo inválido o contraseña menor a 10 caracteres.' }, 400);
  const timestamp = nowIso();
  const expires = new Date(Date.now() + Math.min(Math.max(Number(body.days || 30), 1), 3650) * 86400000).toISOString();
  try {
    const created = await env.DB.prepare(`INSERT INTO license_users(email,name,password_hash,status,expires_at,max_devices,created_at,updated_at)
      VALUES(?1,?2,?3,'active',?4,?5,?6,?6) RETURNING id`).bind(email, String(body.name || '').trim(), await hashPassword(password), expires, Math.min(Math.max(Number(body.max_devices || 1), 1), 10), timestamp).first();
    return response({ ok: true, id: created.id }, 201);
  } catch { return response({ ok: false, message: 'Ese correo ya existe.' }, 409); }
}
async function adminAction(path, request, env) {
  if (!await masterAllowed(request, env)) return response({ ok: false, code: 'ADMIN_UNAUTHORIZED' }, 401);
  const body = await jsonBody(request).catch(() => ({}));
  const user = await env.DB.prepare('SELECT * FROM license_users WHERE id=?1').bind(Number(body.id || 0)).first();
  if (!user) return response({ ok: false, code: 'USER_NOT_FOUND' }, 404);
  if (path.endsWith('/devices/release')) await env.DB.prepare('UPDATE license_devices SET active=0 WHERE user_id=?1').bind(user.id).run();
  else if (path.endsWith('/users/delete')) await env.DB.prepare('DELETE FROM license_users WHERE id=?1').bind(user.id).run();
  else if (path.endsWith('/users/reset-password')) {
    const temporary = `M3D-${base64Url(crypto.getRandomValues(new Uint8Array(9)))}`;
    await env.DB.batch([
      env.DB.prepare('UPDATE license_users SET password_hash=?1,updated_at=?2 WHERE id=?3').bind(await hashPassword(temporary), nowIso(), user.id),
      env.DB.prepare('UPDATE license_devices SET active=0 WHERE user_id=?1').bind(user.id)
    ]);
    return response({ ok: true, temporary_password: temporary });
  } else {
    let expires = new Date(user.expires_at);
    if ('remaining_days' in body) expires = new Date(Date.now() + Math.min(Math.max(Number(body.remaining_days), 0), 3650) * 86400000);
    else if (body.extend_days) expires = new Date(Math.max(expires.getTime(), Date.now()) + Math.min(Math.max(Number(body.extend_days), -3650), 3650) * 86400000);
    await env.DB.prepare('UPDATE license_users SET email=?1,name=?2,status=?3,expires_at=?4,max_devices=?5,updated_at=?6 WHERE id=?7')
      .bind(String(body.email ?? user.email).trim().toLowerCase(), String(body.name ?? user.name).trim(), body.status ? (body.status === 'active' ? 'active' : 'blocked') : user.status, expires.toISOString(), Math.min(Math.max(Number(body.max_devices ?? user.max_devices), 1), 10), nowIso(), user.id).run();
  }
  return response({ ok: true });
}
async function releases(path, request, env, url) {
  if (path === '/latest.json') {
    const row = await env.DB.prepare('SELECT * FROM license_releases WHERE active=1 ORDER BY id DESC LIMIT 1').first();
    if (!row) return response({ ok: false, code: 'NO_RELEASE' }, 404);
    return response({ version: row.version, rbz_url: `${url.origin}/releases/${encodeURIComponent(row.filename)}`, notes: row.notes, required: Boolean(row.required), file_size: row.file_size, published_at: row.created_at });
  }
  if (path.startsWith('/releases/')) {
    const filename = decodeURIComponent(path.slice('/releases/'.length));
    const row = await env.DB.prepare('SELECT * FROM license_releases WHERE filename=?1 AND active=1 ORDER BY id DESC LIMIT 1').bind(filename).first();
    if (!row) return response({ ok: false, code: 'RELEASE_NOT_FOUND' }, 404);
    const object = await env.MODELS.get(row.r2_key);
    if (!object) return response({ ok: false, code: 'RELEASE_NOT_FOUND' }, 404);
    return new Response(object.body, { headers: { 'content-type': row.content_type, 'content-disposition': `attachment; filename="${row.filename.replace(/["\\]/g, '_')}"`, etag: object.httpEtag } });
  }
  if (path === '/api/admin/releases' && request.method === 'GET') {
    if (!await masterAllowed(request, env)) return response({ ok: false, code: 'ADMIN_UNAUTHORIZED' }, 401);
    const { results } = await env.DB.prepare('SELECT id,version,filename,notes,required,file_size,active,created_at FROM license_releases ORDER BY id DESC LIMIT 25').all();
    return response({ sign_url: 'https://extensions.sketchup.com/extension/sign', latest_url: `${url.origin}/latest.json`, releases: results.map(item => ({ ...item, required: Boolean(item.required), active: Boolean(item.active), rbz_url: `${url.origin}/releases/${encodeURIComponent(item.filename)}` })) });
  }
  if (path === '/api/admin/releases/upload' && request.method === 'PUT') {
    if (!await masterAllowed(request, env)) return response({ ok: false, code: 'ADMIN_UNAUTHORIZED' }, 401);
    const size = Number(request.headers.get('content-length') || 0);
    if (!request.body || size <= 0 || size > 30 * 1024 * 1024) return response({ ok: false, message: 'El RBZ está vacío o supera 30 MB.' }, 413);
    const version = String(url.searchParams.get('version') || '').trim().slice(0, 64);
    if (!version) return response({ ok: false, message: 'Falta la versión.' }, 400);
    const requestedName = String(url.searchParams.get('filename') || `Modular_3D_${version}_SIGNED.rbz`);
    const filename = requestedName.split(/[\\/]/).pop().replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 160);
    if (!filename.toLowerCase().endsWith('.rbz')) return response({ ok: false, message: 'El archivo debe ser .rbz.' }, 400);
    const r2Key = `license-releases/${filename}`;
    await env.MODELS.put(r2Key, request.body, { httpMetadata: { contentType: 'application/octet-stream' } });
    const timestamp = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE license_releases SET active=0'),
      env.DB.prepare('DELETE FROM license_releases WHERE filename=?1').bind(filename),
      env.DB.prepare(`INSERT INTO license_releases(version,filename,notes,required,content_type,r2_key,file_size,active,created_at)
        VALUES(?1,?2,?3,?4,'application/octet-stream',?5,?6,1,?7)`)
        .bind(version, filename, String(url.searchParams.get('notes') || '').slice(0, 4000), /^(1|true|yes|si)$/i.test(url.searchParams.get('required') || ''), r2Key, size, timestamp)
    ]);
    return response({ ok: true, version, filename, rbz_url: `${url.origin}/releases/${encodeURIComponent(filename)}`, latest_url: `${url.origin}/latest.json` }, 201);
  }
  return null;
}

async function masterLogin(request, env) {
  if (!env.SESSIONS) return response({ ok: false, message: 'Almacenamiento de sesiones no configurado.' }, 503);
  const body = await jsonBody(request).catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  if (await rateLimited(env, `master-ip:${clientIp}`, 10) || await rateLimited(env, `master:${email}`, 5)) {
    return response({ ok: false, message: 'Demasiados intentos. Espera 15 minutos.' }, 429, { 'retry-after': '900' });
  }
  const user = await findUserByEmail(env, email);
  const suppliedPassword = String(body.password || '');
  const databasePasswordValid = Boolean(user && await verifyPassword(suppliedPassword, user.password_hash));
  const masterSecretValid = Boolean(
    env.MASTER_PANEL_PASSWORD &&
    env.MASTER_EMAIL &&
    email === String(env.MASTER_EMAIL).toLowerCase() &&
    constantTimeEqual(suppliedPassword, String(env.MASTER_PANEL_PASSWORD))
  );
  if (!databasePasswordValid && !masterSecretValid) {
    await audit(env, 'master_login_failed', { email }, user?.id);
    return response({ ok: false, message: 'Correo o contraseña incorrectos.' }, 401);
  }
  let admin = await env.DB.prepare('SELECT id,email,name,role,active FROM platform_admins WHERE email=?1 COLLATE NOCASE').bind(email).first();
  if (!admin && env.MASTER_EMAIL && email === String(env.MASTER_EMAIL).toLowerCase()) {
    await env.DB.prepare(`INSERT OR IGNORE INTO platform_admins(email,name,role,active,created_at,updated_at)
      VALUES(?1,?2,'owner',1,?3,?3)`).bind(email, user?.name || 'Lenin Vladimir Peñafiel Buestán', nowIso()).run();
    admin = await env.DB.prepare('SELECT id,email,name,role,active FROM platform_admins WHERE email=?1 COLLATE NOCASE').bind(email).first();
  }
  if (!admin || Number(admin.active) !== 1) return response({ ok: false, message: 'Esta cuenta no tiene acceso administrativo.' }, 403);
  const sessionId = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  const expiresAt = Date.now() + 8 * 3600000;
  await env.SESSIONS.put(`master:${sessionId}`, JSON.stringify({ adminId: admin.id, expiresAt }), { expirationTtl: 28800 });
  await clearRateLimit(env, `master:${email}`);
  await clearRateLimit(env, `master-ip:${clientIp}`);
  await audit(env, 'master_login', { role: admin.role }, user?.id || null);
  return response({ ok: true, admin }, 200, { 'set-cookie': masterCookie(sessionId, 28800, request) });
}

async function masterApi(path, request, env) {
  if (path === '/api/master/login' && request.method === 'POST') return masterLogin(request, env);
  if (path === '/api/master/logout' && request.method === 'POST') {
    const sessionId = cookieValue(request, 'm3d_master');
    if (sessionId && env.SESSIONS) await env.SESSIONS.delete(`master:${sessionId}`);
    return response({ ok: true }, 200, { 'set-cookie': masterCookie('', 0, request) });
  }
  const admin = await masterSession(request, env);
  if (!admin) return response({ ok: false, code: 'MASTER_UNAUTHORIZED' }, 401);
  if (path === '/api/master/session' && request.method === 'GET') return response({ ok: true, admin });
  if (path === '/api/master/dashboard' && request.method === 'GET') {
    const [users, licenses, devices, projects, products, audits] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) total FROM license_users').first(),
      env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='active' AND expires_at>CURRENT_TIMESTAMP THEN 1 ELSE 0 END) active FROM product_licenses").first(),
      env.DB.prepare('SELECT COUNT(*) total,SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) active FROM license_devices').first(),
      env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active FROM tenant_projects").first(),
      env.DB.prepare('SELECT COUNT(*) total,SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) active FROM platform_products').first(),
      env.DB.prepare("SELECT COUNT(*) total FROM license_audit_logs WHERE created_at>=datetime('now','-24 hours')").first()
    ]);
    return response({ users, licenses, devices, projects, products, audits24h: Number(audits?.total || 0) });
  }
  if (path === '/api/master/products' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT p.*,COUNT(pl.id) licenses,
      SUM(CASE WHEN pl.status='active' AND pl.expires_at>CURRENT_TIMESTAMP THEN 1 ELSE 0 END) active_licenses
      FROM platform_products p LEFT JOIN product_licenses pl ON pl.product_id=p.id GROUP BY p.id ORDER BY p.id`).all();
    return response(results);
  }
  if (path === '/api/master/licenses' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT pl.id,u.email,u.name,p.code product_code,p.name product_name,
      pl.plan,pl.status,pl.expires_at,pl.max_devices,pl.created_at,
      (SELECT COUNT(*) FROM license_devices d WHERE d.user_id=u.id AND d.active=1) active_devices
      FROM product_licenses pl JOIN license_users u ON u.id=pl.user_id
      JOIN platform_products p ON p.id=pl.product_id ORDER BY pl.id DESC LIMIT 500`).all();
    return response(results);
  }
  if (path === '/api/master/licenses' && request.method === 'POST') {
    const body = await jsonBody(request).catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const productCode = String(body.product_code || '').trim().toLowerCase();
    if (!email.includes('@') || password.length < 10 || !productCode) return response({ ok: false, message: 'Completa correo, producto y una clave de mínimo 10 caracteres.' }, 400);
    const product = await env.DB.prepare('SELECT id FROM platform_products WHERE code=?1 COLLATE NOCASE AND active=1').bind(productCode).first();
    if (!product) return response({ ok: false, message: 'Producto no válido.' }, 400);
    const timestamp = nowIso();
    const days = Math.min(Math.max(Number(body.days || 30), 1), 3650);
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    let user = await findUserByEmail(env, email);
    if (!user) {
      const created = await env.DB.prepare(`INSERT INTO license_users(email,name,password_hash,status,expires_at,max_devices,created_at,updated_at)
        VALUES(?1,?2,?3,'active',?4,?5,?6,?6) RETURNING id`).bind(email, String(body.name || '').trim(), await hashPassword(password), expiresAt, Math.min(Math.max(Number(body.max_devices || 1), 1), 10), timestamp).first();
      user = { id: created.id };
    }
    try {
      const created = await env.DB.prepare(`INSERT INTO product_licenses(user_id,product_id,credential_hash,plan,status,expires_at,max_devices,created_at,updated_at)
        VALUES(?1,?2,?3,?4,'active',?5,?6,?7,?7) RETURNING id`).bind(user.id, product.id, await hashPassword(password), String(body.plan || 'standard').slice(0, 40), expiresAt, Math.min(Math.max(Number(body.max_devices || 1), 1), 100), timestamp).first();
      await audit(env, 'master_license_created', { licenseId: created.id, productCode, admin: admin.email }, user.id);
      return response({ ok: true, id: created.id }, 201);
    } catch { return response({ ok: false, message: 'Ese usuario ya tiene licencia para este producto.' }, 409); }
  }
  if (path === '/api/master/licenses/update' && request.method === 'POST') {
    const body = await jsonBody(request).catch(() => ({}));
    const id = Number(body.id || 0);
    const current = await env.DB.prepare('SELECT * FROM product_licenses WHERE id=?1').bind(id).first();
    if (!current) return response({ ok: false, message: 'Licencia no encontrada.' }, 404);
    const status = ['active', 'blocked', 'cancelled'].includes(body.status) ? body.status : current.status;
    const expiresAt = body.days == null ? current.expires_at : new Date(Date.now() + Math.min(Math.max(Number(body.days), 0), 3650) * 86400000).toISOString();
    await env.DB.prepare('UPDATE product_licenses SET status=?1,expires_at=?2,max_devices=?3,plan=?4,updated_at=?5 WHERE id=?6')
      .bind(status, expiresAt, Math.min(Math.max(Number(body.max_devices ?? current.max_devices), 1), 100), String(body.plan ?? current.plan).slice(0, 40), nowIso(), id).run();
    await audit(env, 'master_license_updated', { licenseId: id, status, admin: admin.email });
    return response({ ok: true });
  }
  if (path === '/api/master/projects' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT tp.id,tp.external_id,tp.name,tp.status,tp.storage_prefix,tp.created_at,tp.updated_at,
      u.email,p.code product_code,p.name product_name FROM tenant_projects tp
      JOIN product_licenses pl ON pl.id=tp.license_id JOIN license_users u ON u.id=pl.user_id
      JOIN platform_products p ON p.id=pl.product_id ORDER BY tp.id DESC LIMIT 500`).all();
    return response(results);
  }
  if (path === '/api/master/devices' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT d.id,d.machine_id,d.active,d.plugin_version,d.sketchup_version,d.first_seen_at,d.last_seen_at,u.email,u.name
      FROM license_devices d JOIN license_users u ON u.id=d.user_id ORDER BY d.last_seen_at DESC LIMIT 500`).all();
    return response(results);
  }
  if (path === '/api/master/audit' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT a.id,a.action,a.machine_id,a.detail,a.created_at,u.email
      FROM license_audit_logs a LEFT JOIN license_users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200`).all();
    return response(results);
  }
  return response({ ok: false, code: 'NOT_FOUND' }, 404);
}

export async function licenseApi(request, env) {
  if (!env.DB || !env.MODULAR3D_TOKEN_SECRET) return null;
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith('/api/master/')) return masterApi(path, request, env);
  if (path === '/api/v1/auth/login' && request.method === 'POST') return login(request, env);
  if ((path === '/api/v1/license/validate' || path === '/api/v1/license/heartbeat') && request.method === 'POST') return validateSession(request, env);
  if (path === '/api/v1/license/check-key' && request.method === 'POST') return checkKey(request, env);
  if (path === '/api/v1/auth/logout' && request.method === 'POST') return response({ ok: true });
  if (path === '/api/admin/users' && ['GET', 'POST'].includes(request.method)) return adminUsers(request, env);
  if (/^\/api\/admin\/(users\/(update|reset-password|delete)|devices\/release)$/.test(path) && request.method === 'POST') return adminAction(path, request, env);
  if (path === '/latest.json' || path.startsWith('/releases/') || path === '/api/admin/releases' || path === '/api/admin/releases/upload') return releases(path, request, env, url);
  return null;
}

export const licenseInternals = { base64Url, unbase64Url, constantTimeEqual, hashPassword, verifyPassword, userState };
