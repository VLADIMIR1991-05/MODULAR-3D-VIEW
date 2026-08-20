CREATE TABLE IF NOT EXISTS license_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked')),
  expires_at TEXT NOT NULL,
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK(max_devices BETWEEN 1 AND 10),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES license_users(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  plugin_version TEXT,
  sketchup_version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(user_id, machine_id)
);

CREATE TABLE IF NOT EXISTS license_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  machine_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  filename TEXT NOT NULL UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  r2_key TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_users_email ON license_users(email);
CREATE INDEX IF NOT EXISTS idx_license_users_status_expires ON license_users(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_license_devices_user_active ON license_devices(user_id, active);
CREATE INDEX IF NOT EXISTS idx_license_audit_created ON license_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_license_releases_active ON license_releases(active, id DESC);
