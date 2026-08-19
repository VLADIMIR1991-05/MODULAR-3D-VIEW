CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  share_token TEXT NOT NULL UNIQUE,
  entry_path TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  permission TEXT NOT NULL DEFAULT 'measure',
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_owner_created ON models(owner, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_models_expires ON models(expires_at);

CREATE TABLE IF NOT EXISTS model_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  author TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(model_id, object_id, author),
  FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE
);
