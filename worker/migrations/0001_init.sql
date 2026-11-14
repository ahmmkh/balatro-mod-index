-- Lifetime download totals, one row per mod.
CREATE TABLE IF NOT EXISTS mod_totals (
  mod_id TEXT PRIMARY KEY,
  total  INTEGER NOT NULL DEFAULT 0
);

-- Per-UTC-day counts, used for the "today" figure.
CREATE TABLE IF NOT EXISTS mod_daily (
  mod_id TEXT NOT NULL,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mod_id, day)
);

-- De-duplication of retries/spam: one counted download per (visitor, mod, UTC day).
-- `key` is a salted SHA-256, so no IP address is ever stored. Pruned daily.
CREATE TABLE IF NOT EXISTS dl_seen (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dl_seen_day ON dl_seen(day);
