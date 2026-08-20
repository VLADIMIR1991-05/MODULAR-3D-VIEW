import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('unified admin keeps one password and independent product periods', async () => {
  const source = await readFile(new URL('../src/license.js', import.meta.url), 'utf8');
  assert.match(source, /master\/users\/save/);
  assert.match(source, /UPDATE product_licenses SET credential_hash/);
  assert.match(source, /selection\.days/);
  assert.match(source, /ON CONFLICT\(user_id,product_id\) DO UPDATE/);
});

test('commercial catalog disables Validar Ingeniería without deleting history', async () => {
  const migration = await readFile(new URL('../migrations/0004_unified_users.sql', import.meta.url), 'utf8');
  assert.match(migration, /SET active=0/);
  assert.match(migration, /validar_ingenieria/);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
});

test('master UI edits users with multiple products', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /Productos y vigencia individual/);
  assert.match(script, /productEditor/);
  assert.match(script, /Liberar equipos/);
  assert.match(script, /Nueva clave/);
  assert.match(html, /change-password/);
  assert.match(html, /autocomplete="new-password" disabled/);
  assert.match(script, /master\/users\/change-password/);
});

test('product catalog distinguishes web applications and downloadable plugins', async () => {
  const [source, html, script, migration] = await Promise.all([
    readFile(new URL('../src/license.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0005_product_catalog.sql', import.meta.url), 'utf8')
  ]);
  assert.match(source, /master\/products\/save/);
  assert.match(source, /latestRelease/);
  assert.match(html, /product-dialog/);
  assert.match(script, /Descargar plugin completo/);
  assert.match(script, /Abrir aplicación/);
  assert.match(migration, /product_type/);
  assert.match(migration, /launch_url/);
  assert.match(migration, /download_url/);
});

test('QR Dinámico catalog points to its official repository', async () => {
  const migration = await readFile(new URL('../migrations/0006_qr_repository.sql', import.meta.url), 'utf8');
  assert.match(migration, /VLADIMIR1991-05\/QR_DINAMICO/);
  assert.match(migration, /qr_dinamico/);
});
