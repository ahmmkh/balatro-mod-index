import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { Hono, type Context } from "hono";
import { join } from "node:path";
import { changedSince, paginate, parseCursor, parseLimit, parseSort, sortMods, withDownloads } from "./catalog";
import type { Config } from "./config";
import { nowSec } from "./db";
import type { DownloadCounter } from "./downloads";
import { checkAllLinks, deadIds } from "./links";
import type { RateLimiter } from "./ratelimit";
import type { CatalogStore } from "./store";
import type { IndexSync } from "./sync";

export interface Services {
  cfg: Config;
  db: Database;
  store: CatalogStore;
  downloads: DownloadCounter;
  limiter: RateLimiter;
  sync: IndexSync | null;
  fetchFn?: typeof fetch;
  counters: Record<string, number>;
}

type Env = { Bindings: { ip?: string } };

const REPORT_MAX_BYTES = 1_000_000; // matches the client's MAX_LOG_BYTES (400 KB log -> ~533 KB base64)
const FIELD_MAX = 20_000;

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function readTextCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createApp(svc: Services): Hono<Env> {
  const { cfg, db, store, downloads, limiter } = svc;
  const app = new Hono<Env>();
  const count = (k: string) => (svc.counters[k] = (svc.counters[k] ?? 0) + 1);

  const clientIp = (c: Context<Env>): string => {
    if (cfg.trustProxy) {
      const cf = c.req.header("cf-connecting-ip");
      if (cf) return cf;
      const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (xff) return xff;
    }
    return c.env?.ip ?? "unknown";
  };
  const limited = (c: Context<Env>, cls: string, perMinute: number, burst?: number) =>
    !limiter.allow(cls, clientIp(c), perMinute, burst);

  const banned = new Set((db.query("SELECT hash FROM banned").all() as { hash: string }[]).map((r) => r.hash));

  app.use("*", async (c, next) => {
    if (c.req.path !== "/healthz" && banned.has(downloads.hash("ban", clientIp(c)))) {
      count("blocked");
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
    count(`http_${Math.floor(c.res.status / 100)}xx`);
  });

  app.onError((err, c) => {
    console.error(JSON.stringify({ event: "unhandled", path: c.req.path, error: String(err) }));
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/healthz", (c) => {
    try {
      db.query("SELECT 1").get();
    } catch {
      return c.text("db unavailable", 503);
    }
    return store.ready ? c.text("ok") : c.text("catalog not loaded", 503);
  });

  app.get("/thumbnails/:file", async (c) => {
    if (limited(c, "read", 600)) return c.json({ error: "rate limited" }, 429);
    const file = c.req.param("file");
    if (!/^[^/\\]+\.webp$/.test(file) || file.includes("..") || !store.dir) return c.json({ error: "not found" }, 404);
    const path = join(store.dir, "thumbnails", file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return c.json({ error: "not found" }, 404);
    const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`;
    const headers = { etag, "cache-control": "public, max-age=86400", "content-type": "image/webp" };
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(Bun.file(path), { headers });
  });

  const list = (changedOnly: boolean) => (c: Context<Env>) => {
    if (limited(c, "read", 120)) return c.json({ error: "rate limited" }, 429);
    const offset = parseCursor(c.req.query("cursor") ?? null);
    if (offset === null) return c.json({ error: "bad cursor" }, 400);
    const since = c.req.query("since");
    if (changedOnly && !since) return c.json({ error: "since is required" }, 400);

    const counts = downloads.snapshot();
    const source = changedOnly ? changedSince(store.mods, since!) : store.mods;
    const sorted = sortMods(source, parseSort(c.req.query("sort") ?? null), counts);
    const page = paginate(sorted, offset, parseLimit(c.req.query("limit") ?? null));
    const items: unknown[] = page.items.map((m) => withDownloads(m, counts));
    // Removed/hidden mods are reported once, on the first page of a "changed" listing.
    if (changedOnly && offset === 0) items.push(...store.tombstonesSince(since!));
    return c.json({ items, next_cursor: page.nextCursor });
  };
  app.get("/mods/changed", list(true));
  app.get("/mods", list(false));

  app.get("/mods/:id", (c) => {
    if (limited(c, "read", 120)) return c.json({ error: "rate limited" }, 429);
    const mod = store.get(c.req.param("id"));
    return mod ? c.json(withDownloads(mod, downloads.snapshot())) : c.json({ error: "mod not found" }, 404);
  });

  app.post("/mods/:id/download", (c) => {
    if (limited(c, "download", 60)) return c.json({ error: "rate limited" }, 429);
    const mod = store.get(c.req.param("id"));
    const url = mod?.meta.downloadURL;
    if (!mod || !url) return c.json({ error: "mod not found" }, 404);
    if (downloads.record(mod.id, clientIp(c))) count("downloads_counted");
    return c.json({ download_url: url });
  });

  app.post("/report", async (c) => {
    if (limited(c, "report", 5 / 60, 5)) return c.json({ error: "too many reports" }, 429); // 5/hour, burst 5
    const raw = await readTextCapped(c.req.raw, REPORT_MAX_BYTES);
    if (raw === null) return c.json({ error: "report too large" }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const str = (k: string, max = FIELD_MAX) => (typeof body[k] === "string" ? (body[k] as string).slice(0, max) : "");
    const title = str("title", 300);
    if (!title.trim() || typeof body.description !== "string") return c.json({ error: "title and description are required" }, 400);
    db.query(
      `INSERT INTO reports (created_at, title, description, mm_version, os, arch, cpu, gpu, ram, log_filename, log_b64)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(nowSec(), title, str("description"), str("mm_version", 64), str("os", 200), str("arch", 64), str("cpu", 200), str("gpu", 200), str("ram", 64), str("log_filename", 200), str("log_b64", REPORT_MAX_BYTES));
    count("reports");
    if (cfg.discordWebhookUrl) {
      const content = `**New BMM report:** ${title}\n${str("description", 1200)}\n_v${str("mm_version", 32)} · ${str("os", 80)}_`;
      void (svc.fetchFn ?? fetch)(cfg.discordWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(5000),
      }).catch((e) => console.error(JSON.stringify({ event: "discord_forward_failed", error: String(e) })));
    }
    return c.json({ ok: true }, 201);
  });

  // ---- admin (bearer token) -------------------------------------------------------------
  const admin = new Hono<Env>();
  admin.use("*", async (c, next) => {
    if (!cfg.adminToken) return c.json({ error: "not found" }, 404);
    const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (limited(c, "admin", 30)) return c.json({ error: "rate limited" }, 429);
    if (!timingSafeEqual(given, cfg.adminToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  admin.get("/stats", (c) => {
    const snap = downloads.snapshot();
    const top = Object.entries(snap).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
    return c.json({
      mods: store.mods.length,
      catalogLoadedAt: store.loadedAt,
      sync: svc.sync?.status ?? null,
      totalDownloads: Object.values(snap).reduce((n, d) => n + d.total, 0),
      downloadsToday: Object.values(snap).reduce((n, d) => n + d.today, 0),
      top,
      deadLinks: deadIds(db).size,
      reports: (db.query("SELECT count(*) AS n FROM reports").get() as { n: number }).n,
    });
  });
  // Both jobs outlive any sane HTTP timeout, so they run in the background; poll /admin/stats.
  let linkCheckRunning = false;
  admin.post("/reload", (c) => {
    if (!svc.sync || svc.sync.status.running) return c.json({ started: false, sync: svc.sync?.status ?? null }, svc.sync ? 409 : 400);
    void svc.sync.syncOnce(true);
    return c.json({ started: true }, 202);
  });
  admin.post("/links/check", (c) => {
    if (linkCheckRunning) return c.json({ started: false }, 409);
    linkCheckRunning = true;
    void checkAllLinks(db, store, { fetchFn: svc.fetchFn })
      .catch((e) => console.error(JSON.stringify({ event: "link_check_failed", error: String(e) })))
      .finally(() => (linkCheckRunning = false));
    return c.json({ started: true }, 202);
  });
  admin.get("/links", (c) =>
    c.json(db.query("SELECT mod_id, url, status, fails, checked_at FROM link_health WHERE fails > 0 ORDER BY fails DESC").all()),
  );
  admin.post("/mods/:id/hide", (c) => (store.setHidden(c.req.param("id"), true) ? c.json({ ok: true }) : c.json({ error: "unknown mod" }, 404)));
  admin.delete("/mods/:id/hide", (c) => (store.setHidden(c.req.param("id"), false) ? c.json({ ok: true }) : c.json({ error: "unknown mod" }, 404)));
  admin.get("/reports", (c) =>
    c.json(db.query("SELECT id, created_at, title, description, mm_version, os, arch FROM reports ORDER BY id DESC LIMIT 50").all()),
  );
  admin.get("/reports/:id/log", (c) => {
    const row = db.query("SELECT log_filename, log_b64 FROM reports WHERE id = ?").get(c.req.param("id")) as { log_filename: string; log_b64: string } | null;
    return row ? c.text(Buffer.from(row.log_b64, "base64").toString("utf8")) : c.json({ error: "not found" }, 404);
  });
  admin.post("/ban", async (c) => {
    const ip = ((await c.req.json().catch(() => ({}))) as { ip?: string }).ip;
    if (!ip) return c.json({ error: "ip required" }, 400);
    const hash = downloads.hash("ban", ip);
    db.query("INSERT OR IGNORE INTO banned (hash, reason, created_at) VALUES (?, 'admin', ?)").run(hash, nowSec());
    banned.add(hash);
    return c.json({ ok: true });
  });
  app.route("/admin", admin);

  app.get("/metrics", (c) => {
    if (!cfg.adminToken) return c.json({ error: "not found" }, 404);
    const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (!timingSafeEqual(given, cfg.adminToken)) return c.json({ error: "unauthorized" }, 401);
    const snap = downloads.snapshot();
    const lines = [
      "# TYPE bmi_mods gauge", `bmi_mods ${store.mods.length}`,
      "# TYPE bmi_downloads_total counter", `bmi_downloads_total ${Object.values(snap).reduce((n, d) => n + d.total, 0)}`,
      "# TYPE bmi_dead_links gauge", `bmi_dead_links ${deadIds(db).size}`,
      "# TYPE bmi_catalog_loaded_timestamp gauge", `bmi_catalog_loaded_timestamp ${store.loadedAt}`,
      "# TYPE bmi_sync_ok gauge", `bmi_sync_ok ${svc.sync?.status.lastError ? 0 : 1}`,
      "# TYPE bmi_requests_total counter",
      ...Object.entries(svc.counters).map(([k, v]) => `bmi_requests_total{kind="${k}"} ${v}`),
    ];
    return c.text(lines.join("\n") + "\n");
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
