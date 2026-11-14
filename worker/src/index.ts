import {
  type CatalogMod,
  type Downloads,
  changedSince,
  paginate,
  parseCursor,
  parseLimit,
  parseSort,
  sortMods,
  withDownloads,
} from "./catalog";

const COUNTS_CACHE_KEY = "https://bmi.internal/counts/v1";
const COUNTS_TTL_SECONDS = 60;

// The catalog is an immutable build artifact (changes only on deploy), so caching the parsed
// copy for the life of the isolate is safe. It holds no per-request state.
let catalogPromise: Promise<CatalogMod[]> | null = null;

function loadCatalog(env: Env, origin: string): Promise<CatalogMod[]> {
  catalogPromise ??= (async () => {
    const res = await env.ASSETS.fetch(new Request(new URL("/index.json", origin)));
    if (!res.ok) throw new Error(`index.json unavailable: ${res.status}`);
    const body = (await res.json()) as { mods: CatalogMod[] };
    return body.mods;
  })().catch((err) => {
    catalogPromise = null; // don't cache a failure
    throw err;
  });
  return catalogPromise;
}

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function fail(status: number, message: string): Response {
  return json({ error: message }, { status });
}

async function getCounts(env: Env, ctx: ExecutionContext): Promise<Record<string, Downloads>> {
  const cache = caches.default;
  const cached = await cache.match(COUNTS_CACHE_KEY);
  if (cached) return (await cached.json()) as Record<string, Downloads>;

  const today = utcDay();
  const [totals, daily] = await env.DB.batch<{ mod_id: string; n: number }>([
    env.DB.prepare("SELECT mod_id, total AS n FROM mod_totals"),
    env.DB.prepare("SELECT mod_id, count AS n FROM mod_daily WHERE day = ?").bind(today),
  ]);
  const counts: Record<string, Downloads> = {};
  for (const row of totals.results) counts[row.mod_id] = { total: row.n, today: 0 };
  for (const row of daily.results) {
    (counts[row.mod_id] ??= { total: 0, today: 0 }).today = row.n;
  }
  ctx.waitUntil(
    cache.put(
      COUNTS_CACHE_KEY,
      json(counts, { headers: { "cache-control": `max-age=${COUNTS_TTL_SECONDS}` } }),
    ),
  );
  return counts;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Count one download per (visitor, mod, UTC day). Never throws: counting must not block installs. */
async function recordDownload(env: Env, request: Request, modId: string): Promise<void> {
  try {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const day = utcDay();
    const key = await sha256Hex(`${env.IP_SALT}|${day}|${ip}|${modId}`);
    const seen = await env.DB.prepare("INSERT OR IGNORE INTO dl_seen (key, day) VALUES (?, ?)")
      .bind(key, day)
      .run();
    if (seen.meta.changes === 0) return; // already counted today
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mod_totals (mod_id, total) VALUES (?, 1) ON CONFLICT(mod_id) DO UPDATE SET total = total + 1",
      ).bind(modId),
      env.DB.prepare(
        "INSERT INTO mod_daily (mod_id, day, count) VALUES (?, ?, 1) ON CONFLICT(mod_id, day) DO UPDATE SET count = count + 1",
      ).bind(modId, day),
    ]);
  } catch (err) {
    console.error(JSON.stringify({ event: "record_download_failed", modId, error: String(err) }));
  }
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/healthz" && request.method === "GET") return new Response("ok");

  if (path.startsWith("/thumbnails/") && request.method === "GET") {
    const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
    if (!res.ok) return fail(404, "not found");
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "public, max-age=86400");
    return out;
  }

  if (path === "/mods" && request.method === "GET") return listMods(url, env, ctx, false);
  if (path === "/mods/changed" && request.method === "GET") return listMods(url, env, ctx, true);

  const match = /^\/mods\/([^/]+)(\/download)?$/.exec(path);
  if (match) {
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return fail(400, "bad mod id");
    }
    const catalog = await loadCatalog(env, url.origin);
    const mod = catalog.find((m) => m.id === id);
    if (!mod) return fail(404, "mod not found");

    if (!match[2] && request.method === "GET") {
      const counts = await getCounts(env, ctx);
      return json(withDownloads(mod, counts));
    }
    if (match[2] && request.method === "POST") {
      const downloadUrl = mod.meta.downloadURL;
      if (!downloadUrl) return fail(404, "mod has no download url");
      await recordDownload(env, request, id);
      return json({ download_url: downloadUrl });
    }
    return fail(405, "method not allowed");
  }

  return fail(404, "not found");
}

async function listMods(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  changedOnly: boolean,
): Promise<Response> {
  const offset = parseCursor(url.searchParams.get("cursor"));
  if (offset === null) return fail(400, "bad cursor");
  const since = url.searchParams.get("since");
  if (changedOnly && !since) return fail(400, "since is required");

  const [catalog, counts] = await Promise.all([loadCatalog(env, url.origin), getCounts(env, ctx)]);
  const source = changedOnly ? changedSince(catalog, since!) : catalog;
  const sorted = sortMods(source, parseSort(url.searchParams.get("sort")), counts);
  const page = paginate(sorted, offset, parseLimit(url.searchParams.get("limit")));
  return json({ items: page.items.map((m) => withDownloads(m, counts)), next_cursor: page.nextCursor });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error(JSON.stringify({ event: "unhandled", path: new URL(request.url).pathname, error: String(err) }));
      return fail(500, "internal error");
    }
  },

  // Daily housekeeping: dedupe keys only matter for the current day; keep a week of daily counts.
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare("DELETE FROM dl_seen WHERE day < ?").bind(utcDay()),
        env.DB.prepare("DELETE FROM mod_daily WHERE day < date('now', '-7 days')"),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
