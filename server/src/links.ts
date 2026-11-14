import type { Database } from "bun:sqlite";
import { nowSec } from "./db";
import type { CatalogStore } from "./store";

const DEAD_AFTER_FAILS = 3;
const TIMEOUT_MS = 10_000;
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[.*\])/i;

/** Only public https URLs; the index is PR-reviewed, but never let it aim the server at internal hosts. */
export function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !PRIVATE_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

export async function probe(url: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const attempt = async (init: RequestInit) =>
    (await fetchFn(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) })).status;
  try {
    const head = await attempt({ method: "HEAD" });
    if (![403, 405, 501].includes(head)) return head;
    return await attempt({ method: "GET", headers: { range: "bytes=0-0" } });
  } catch {
    return 0;
  }
}

export interface LinkSummary {
  checked: number;
  dead: number;
}

export async function checkAllLinks(
  db: Database,
  store: CatalogStore,
  opts: { concurrency?: number; fetchFn?: typeof fetch } = {},
): Promise<LinkSummary> {
  const jobs = store.mods
    .map((m) => ({ id: m.id, url: (m.meta.downloadURL as string | null | undefined) ?? null }))
    .filter((j): j is { id: string; url: string } => !!j.url);
  const prev = new Map(
    (db.query("SELECT mod_id, fails FROM link_health").all() as { mod_id: string; fails: number }[]).map((r) => [r.mod_id, r.fails]),
  );
  const upsert = db.query(
    `INSERT INTO link_health (mod_id, url, status, fails, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(mod_id) DO UPDATE SET url = ?2, status = ?3, fails = ?4, checked_at = ?5`,
  );
  let next = 0;
  const worker = async () => {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      const status = isSafeUrl(job.url) ? await probe(job.url, opts.fetchFn) : 0;
      const ok = status >= 200 && status < 400;
      upsert.run(job.id, job.url, status, ok ? 0 : (prev.get(job.id) ?? 0) + 1, nowSec());
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  const dead = deadIds(db);
  store.markUnavailable(dead);
  return { checked: jobs.length, dead: dead.size };
}

export function deadIds(db: Database): Set<string> {
  return new Set(
    (db.query("SELECT mod_id FROM link_health WHERE fails >= ?").all(DEAD_AFTER_FAILS) as { mod_id: string }[]).map((r) => r.mod_id),
  );
}
