// Endpoint temporal de una sola migracion. Se elimina al finalizar.
const TOKEN_SHA256 = 'f6efab50bf02da06a261b6c99829a5486d114fd9a1949209d1a2f46f924e481c';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function authorized(request) {
  const token = request.headers.get('x-migration-token') || '';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return hash === TOKEN_SHA256;
}

export async function temporaryMigration(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/internal/migration/')) return null;
  if (!await authorized(request)) return json({ ok: false }, 404);

  if (url.pathname.endsWith('/sql') && request.method === 'POST') {
    const sql = await request.text();
    if (!sql || sql.length > 1_000_000) return json({ ok: false, error: 'invalid_sql' }, 413);
    try {
      const statements = sql.split(/;\s*(?:\r?\n|$)/).map(value => value.trim()).filter(value => value && !/^(PRAGMA|BEGIN|COMMIT)/i.test(value));
      for (let index = 0; index < statements.length; index += 40) {
        await env.DB.batch(statements.slice(index, index + 40).map(statement => env.DB.prepare(statement)));
      }
      await env.DB.prepare(`INSERT OR IGNORE INTO product_licenses(user_id,product_id,credential_hash,plan,status,expires_at,max_devices,created_at,updated_at)
        SELECT u.id,p.id,u.password_hash,'legacy',u.status,u.expires_at,u.max_devices,u.created_at,u.updated_at
        FROM license_users u JOIN platform_products p ON p.code='modular3d_plugin'`).run();
      return json({ ok: true, statements: statements.length });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 500);
    }
  }

  if (url.pathname.endsWith('/release') && request.method === 'PUT') {
    const filename = (url.searchParams.get('filename') || '').split(/[\\/]/).pop();
    if (!filename || !filename.toLowerCase().endsWith('.rbz') || !request.body) return json({ ok: false }, 400);
    await env.MODELS.put(`license-releases/${filename}`, request.body, { httpMetadata: { contentType: 'application/octet-stream' } });
    return json({ ok: true, filename });
  }

  if (url.pathname.endsWith('/status') && request.method === 'GET') {
    try {
      const users = await env.DB.prepare('SELECT COUNT(*) count FROM license_users').first();
      const devices = await env.DB.prepare('SELECT COUNT(*) count FROM license_devices').first();
      const audits = await env.DB.prepare('SELECT COUNT(*) count FROM license_audit_logs').first();
      const licenses = await env.DB.prepare('SELECT COUNT(*) count FROM product_licenses').first();
      const releases = await env.DB.prepare('SELECT COUNT(*) count FROM license_releases').first();
      return json({ ok: true, users: users.count, devices: devices.count, audits: audits.count, licenses: licenses.count, releases: releases.count });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 500);
    }
  }
  return json({ ok: false }, 404);
}
