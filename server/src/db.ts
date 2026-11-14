import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Lifecycle of every mod id we've ever served. Lets /mods/changed emit tombstones for removed mods.
CREATE TABLE IF NOT EXISTS mod_state (
  id         TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,           -- effective change time (unix s)
  deleted    INTEGER NOT NULL DEFAULT 0, -- removed from the index
  hidden     INTEGER NOT NULL DEFAULT 0  -- hidden by an admin
);

CREATE TABLE IF NOT EXISTS dl_total (mod_id TEXT PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS dl_daily (
  mod_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mod_id, day)
);
-- One counted download per (visitor, mod, UTC day). key = salted SHA-256; no IPs stored.
CREATE TABLE IF NOT EXISTS dl_seen (key TEXT PRIMARY KEY, day TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS dl_seen_day ON dl_seen(day);

CREATE TABLE IF NOT EXISTS link_health (
  mod_id     TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  status     INTEGER NOT NULL,     -- HTTP status, 0 = network error/timeout
  fails      INTEGER NOT NULL DEFAULT 0, -- consecutive failures
  checked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL,
  mm_version TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL,
  cpu TEXT NOT NULL, gpu TEXT NOT NULL, ram TEXT NOT NULL,
  log_filename TEXT NOT NULL, log_b64 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS banned (hash TEXT PRIMARY KEY, reason TEXT, created_at INTEGER NOT NULL);
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/** Persistent random secret used to salt visitor hashes; created on first run. */
export function getSecret(db: Database): string {
  const row = db.query("SELECT value FROM meta WHERE key = 'salt'").get() as { value: string } | null;
  if (row) return row.value;
  const value = crypto.randomUUID() + crypto.randomUUID();
  db.query("INSERT INTO meta (key, value) VALUES ('salt', ?)").run(value);
  return value;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
export const utcDay = (d = new Date()): string => d.toISOString().slice(0, 10);
