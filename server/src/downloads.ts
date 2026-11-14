import type { Database } from "bun:sqlite";
import { ZERO_DOWNLOADS, type Downloads } from "./catalog";
import { utcDay } from "./db";

const KEEP_DAILY_DAYS = 35;
const SNAPSHOT_TTL_MS = 2_000;

function daysAgo(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Download counters. Increments apply to memory immediately (so reads are always fresh) and are
 * written to SQLite in batches. De-duplicated to one count per (visitor, mod, UTC day).
 */
export class DownloadCounter {
  private totals = new Map<string, number>();
  private daily = new Map<string, Map<string, number>>();
  private seen = new Set<string>();
  private pendingKeys: { key: string; day: string }[] = [];
  private pendingDeltas = new Map<string, { modId: string; day: string; n: number }>();
  private snapshotCache: { at: number; value: Record<string, Downloads> } | null = null;
  private lastPruneDay = "";
  private seenDay = "";

  constructor(
    private readonly db: Database,
    private readonly secret: string,
    private readonly today: () => string = utcDay,
  ) {
    for (const r of db.query("SELECT mod_id, total FROM dl_total").all() as { mod_id: string; total: number }[]) {
      this.totals.set(r.mod_id, r.total);
    }
    const since = daysAgo(this.today(), 7);
    for (const r of db.query("SELECT mod_id, day, n FROM dl_daily WHERE day >= ?").all(since) as {
      mod_id: string;
      day: string;
      n: number;
    }[]) {
      this.bucket(r.mod_id).set(r.day, r.n);
    }
    this.seenDay = this.today();
    for (const r of db.query("SELECT key FROM dl_seen WHERE day = ?").all(this.today()) as { key: string }[]) {
      this.seen.add(r.key);
    }
  }

  hash(...parts: string[]): string {
    return new Bun.CryptoHasher("sha256").update([this.secret, ...parts].join("|")).digest("hex");
  }

  /** Returns true if this call was counted (false = same visitor already counted today). */
  record(modId: string, ip: string): boolean {
    const day = this.today();
    if (day !== this.seenDay) {
      this.seen.clear(); // keys embed the day, so yesterday's can never match again
      this.seenDay = day;
    }
    const key = this.hash(day, ip, modId);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.pendingKeys.push({ key, day });
    this.totals.set(modId, (this.totals.get(modId) ?? 0) + 1);
    const b = this.bucket(modId);
    b.set(day, (b.get(day) ?? 0) + 1);
    const dk = `${modId}|${day}`;
    const d = this.pendingDeltas.get(dk) ?? { modId, day, n: 0 };
    d.n++;
    this.pendingDeltas.set(dk, d);
    this.snapshotCache = null;
    return true;
  }

  snapshot(): Record<string, Downloads> {
    const now = Date.now();
    if (this.snapshotCache && now - this.snapshotCache.at < SNAPSHOT_TTL_MS) return this.snapshotCache.value;
    const today = this.today();
    const weekStart = daysAgo(today, 6);
    const out: Record<string, Downloads> = {};
    for (const [id, total] of this.totals) {
      let week = 0;
      for (const [day, n] of this.bucket(id)) if (day >= weekStart) week += n;
      out[id] = { total, today: this.bucket(id).get(today) ?? 0, week };
    }
    this.snapshotCache = { at: now, value: out };
    return out;
  }

  get(modId: string): Downloads {
    return this.snapshot()[modId] ?? ZERO_DOWNLOADS;
  }

  /** Persist pending increments in one transaction. Safe to call repeatedly. */
  flush(): number {
    if (this.pendingKeys.length === 0) return 0;
    const keys = this.pendingKeys;
    const deltas = [...this.pendingDeltas.values()];
    this.pendingKeys = [];
    this.pendingDeltas.clear();
    try {
      this.db.transaction(() => {
        const seen = this.db.query("INSERT OR IGNORE INTO dl_seen (key, day) VALUES (?, ?)");
        for (const k of keys) seen.run(k.key, k.day);
        const total = this.db.query(
          "INSERT INTO dl_total (mod_id, total) VALUES (?1, ?2) ON CONFLICT(mod_id) DO UPDATE SET total = total + ?2",
        );
        const daily = this.db.query(
          "INSERT INTO dl_daily (mod_id, day, n) VALUES (?1, ?2, ?3) ON CONFLICT(mod_id, day) DO UPDATE SET n = n + ?3",
        );
        for (const d of deltas) {
          total.run(d.modId, d.n);
          daily.run(d.modId, d.day, d.n);
        }
      })();
    } catch (err) {
      // Put the batch back so a transient SQLite error doesn't lose counts.
      this.pendingKeys = keys.concat(this.pendingKeys);
      for (const d of deltas) {
        const dk = `${d.modId}|${d.day}`;
        const cur = this.pendingDeltas.get(dk);
        if (cur) cur.n += d.n;
        else this.pendingDeltas.set(dk, d);
      }
      throw err;
    }
    this.pruneIfNewDay();
    return keys.length;
  }

  private pruneIfNewDay(): void {
    const today = this.today();
    if (today === this.lastPruneDay) return;
    this.lastPruneDay = today;
    this.db.query("DELETE FROM dl_seen WHERE day < ?").run(today);
    this.db.query("DELETE FROM dl_daily WHERE day < ?").run(daysAgo(today, KEEP_DAILY_DAYS));
  }

  private bucket(modId: string): Map<string, number> {
    let b = this.daily.get(modId);
    if (!b) this.daily.set(modId, (b = new Map()));
    return b;
  }
}
