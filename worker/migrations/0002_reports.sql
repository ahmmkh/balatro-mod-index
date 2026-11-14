-- In-app issue reports. Read with: wrangler d1 execute bmi --remote --command "SELECT ..."
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  day         TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,   -- salted SHA-256, rotates daily; used only for rate limiting
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  mm_version  TEXT NOT NULL,
  os          TEXT NOT NULL,
  arch        TEXT NOT NULL,
  cpu         TEXT NOT NULL,
  gpu         TEXT NOT NULL,
  ram         TEXT NOT NULL,
  log_filename TEXT NOT NULL,
  log_b64     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_ip_day ON reports(ip_hash, day);
