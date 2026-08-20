-- Plataforma central de licencias MODULAR-3D.
-- Conserva las tablas de la migracion 0002 para no romper clientes existentes.

CREATE TABLE IF NOT EXISTS platform_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','admin','support','viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES license_users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES platform_products(id) ON DELETE RESTRICT,
  credential_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked','cancelled')),
  expires_at TEXT NOT NULL,
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK(max_devices BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS license_entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES product_licenses(id) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  limit_value INTEGER,
  config_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(license_id, feature_code)
);

CREATE TABLE IF NOT EXISTS tenant_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES product_licenses(id) ON DELETE CASCADE,
  external_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  storage_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(license_id, storage_prefix)
);

INSERT OR IGNORE INTO platform_products(code,name,description) VALUES
  ('modular3d_plugin','MODULAR-3D para SketchUp','Plugin y herramientas para SketchUp/Layout'),
  ('modular3d_view','MODULAR-3D VIEW','Visualizador web y movil de modelos 3D'),
  ('qr_dinamico','QR DINAMICO','Creacion y administracion de codigos QR'),
  ('validar_ingenieria','VALIDAR INGENIERIA','Comparador tecnico TXT-XLS');

INSERT OR IGNORE INTO product_licenses(
  user_id,product_id,credential_hash,plan,status,expires_at,max_devices,created_at,updated_at
)
SELECT u.id,p.id,u.password_hash,'legacy',u.status,u.expires_at,u.max_devices,u.created_at,u.updated_at
FROM license_users u
JOIN platform_products p ON p.code='modular3d_plugin';

CREATE INDEX IF NOT EXISTS idx_product_licenses_product_status
  ON product_licenses(product_id,status,expires_at);
CREATE INDEX IF NOT EXISTS idx_product_licenses_user
  ON product_licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_license
  ON license_entitlements(license_id);
CREATE INDEX IF NOT EXISTS idx_tenant_projects_license
  ON tenant_projects(license_id,status);
