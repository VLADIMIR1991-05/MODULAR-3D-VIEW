import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { licenseInternals, validateLicenseKey } from '../src/license.js';

test('validates legacy Python PBKDF2 password hashes', async () => {
  const password = 'Clave-segura-2026';
  const salt = Buffer.from('0123456789abcdef');
  const digest = pbkdf2Sync(password, salt, 210000, 32, 'sha256');
  const encoded = `pbkdf2_sha256$210000$${salt.toString('base64url')}$${digest.toString('base64url')}`;
  assert.equal(await licenseInternals.verifyPassword(password, encoded), true);
  assert.equal(await licenseInternals.verifyPassword('incorrecta', encoded), false);
});

test('validates a migrated D1 license without an HTTP subrequest', async () => {
  const password = 'Licencia-M3D-2026';
  const passwordHash = await licenseInternals.hashPassword(password);
  const user = {
    id: 7,
    email: 'cliente@example.com',
    password_hash: passwordHash,
    status: 'active',
    expires_at: new Date(Date.now() + 86400000).toISOString()
  };
  const env = {
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async first() { return user; }
        };
      }
    }
  };
  assert.equal((await validateLicenseKey(user.email, password, env)).valid, true);
  assert.equal((await validateLicenseKey(user.email, 'incorrecta', env)).valid, false);
});
