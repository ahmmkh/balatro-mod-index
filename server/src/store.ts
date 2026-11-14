import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogMod, Tombstone } from "./catalog";
import { nowSec } from "./db";

export interface LoadStats {
  total: number;
  added: number;
  removed: number;
  reappeared: number;
}

interface StateRow {
  id: string;
  updated_at: number;
  deleted: number;
  hidden: number;
}

/**
 * The served catalog: parsed index.json overlaid with per-mod lifecycle state.
 * Lifecycle (added / removed / hidden) is what lets /mods/changed tell clients to drop mods.
 */
export class CatalogStore {
  mods: CatalogMod[] = [];
  private byId = new Map<string, CatalogMod>();
  private tombstones: Tombstone[] = [];
  /** Directory the current catalog (index.json + thumbnails/) was loaded from. */
  dir: string | null = null;
  loadedAt = 0;

  constructor(private readonly db: Database) {}

  get(id: string): CatalogMod | undefined {
    return this.byId.get(id);
  }

  get ready(): boolean {
    return this.mods.length > 0;
  }

  /** Tombstones (removed or hidden mods) newer than `since`. */
  tombstonesSince(since: string): Tombstone[] {
    const cutoff = Number(since);
    if (!Number.isFinite(cutoff)) return this.tombstones;
    return this.tombstones.filter((t) => Number(t.updated_at) > cutoff);
  }

  load(dir: string, now = nowSec()): LoadStats {
    const parsed = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { mods: CatalogMod[] };
    if (!Array.isArray(parsed.mods) || parsed.mods.length === 0) throw new Error("index.json has no mods");

    const state = new Map<string, StateRow>(
      (this.db.query("SELECT id, updated_at, deleted, hidden FROM mod_state").all() as StateRow[]).map((r) => [r.id, r]),
    );
    const seen = new Set<string>();
    const stats: LoadStats = { total: parsed.mods.length, added: 0, removed: 0, reappeared: 0 };
    const upsert = this.db.query(
      `INSERT INTO mod_state (id, updated_at, deleted, hidden) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET updated_at = ?2, deleted = ?3, hidden = ?4`,
    );

    const visible: CatalogMod[] = [];
    this.db.transaction(() => {
      for (const mod of parsed.mods) {
        seen.add(mod.id);
        const prev = state.get(mod.id);
        const fromIndex = Number(mod.updated_at) || 0;
        let updated: number;
        let hidden = 0;
        if (!prev) {
          updated = now; // first sight: guarantee incremental clients pick it up
          stats.added++;
          upsert.run(mod.id, updated, 0, 0);
        } else if (prev.deleted) {
          updated = now;
          stats.reappeared++;
          hidden = prev.hidden;
          upsert.run(mod.id, updated, 0, hidden);
        } else {
          updated = Math.max(prev.updated_at, fromIndex);
          hidden = prev.hidden;
          if (updated !== prev.updated_at) upsert.run(mod.id, updated, 0, hidden);
        }
        if (!hidden) visible.push({ ...mod, updated_at: String(updated) });
      }
      for (const row of state.values()) {
        if (!seen.has(row.id) && !row.deleted) {
          upsert.run(row.id, now, 1, row.hidden);
          stats.removed++;
        }
      }
    })();

    this.mods = visible;
    this.byId = new Map(visible.map((m) => [m.id, m]));
    this.dir = dir;
    this.loadedAt = now;
    this.refreshTombstones();
    return stats;
  }

  setHidden(id: string, hidden: boolean, now = nowSec()): boolean {
    const row = this.db.query("SELECT id FROM mod_state WHERE id = ?").get(id);
    if (!row) return false;
    this.db.query("UPDATE mod_state SET hidden = ?, updated_at = ? WHERE id = ?").run(hidden ? 1 : 0, now, id);
    if (this.dir) this.load(this.dir, now);
    return true;
  }

  /** Flag mods whose download links are failing so clients/admins can see them. */
  markUnavailable(ids: ReadonlySet<string>): void {
    for (const mod of this.mods) {
      if (ids.has(mod.id)) mod.unavailable = true;
      else delete mod.unavailable;
    }
  }

  private refreshTombstones(): void {
    const rows = this.db
      .query("SELECT id, updated_at FROM mod_state WHERE deleted = 1 OR hidden = 1")
      .all() as { id: string; updated_at: number }[];
    this.tombstones = rows.map((r) => ({ id: r.id, deleted: true, updated_at: String(r.updated_at) }));
  }
}
