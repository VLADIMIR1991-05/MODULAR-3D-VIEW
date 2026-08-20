import { readFile, writeFile } from 'node:fs/promises';

const databaseId = process.env.D1_DATABASE_ID;
if (!databaseId) throw new Error('Falta D1_DATABASE_ID.');

const source = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
source.d1_databases = [{
  binding: 'DB',
  database_name: process.env.D1_DATABASE_NAME || 'modular-3d-platform',
  database_id: databaseId,
  migrations_dir: 'migrations'
}];

await writeFile('wrangler.ci.json', `${JSON.stringify(source, null, 2)}\n`);
