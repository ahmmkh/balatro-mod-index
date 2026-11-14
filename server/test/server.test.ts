import { describe, expect, it } from "bun:test";
import { DownloadCounter } from "../src/downloads";
import { checkAllLinks, isSafeUrl, probe } from "../src/links";
import { RateLimiter } from "../src/ratelimit";
import { ADMIN, makeServices, mod, req, writeCatalog } from "./helpers";

const A = mod("a@Alpha", "Alpha", 100);
const B = mod("b@Beta", "Beta", 200);
const C = mod("c@Gamma!", "Gamma", 300);

describe("catalog lifecycle", () => {
  it("is not ready (503) until a catalog is loaded", async () => {
    const { app, svc } = makeServices();
    expect((await req(app, "/healthz")).status).toBe(503);
    svc.store.load(writeCatalog([A]));
    expect((await req(app, "/healthz")).status).toBe(200);
  });

  it("emits tombstones for removed mods and resurrects them when they return", async () => {
    const { app, svc } = makeServices();
    svc.store.load(writeCatalog([A, B, C]), 1000);
    const removed = svc.store.load(writeCatalog([A, C]), 2000);
    expect(removed.removed).toBe(1);

    const changed = await (await req(app, "/mods/changed?since=1500")).json() as { items: unknown[] };
    expect(changed.items).toEqual([{ id: "b@Beta", deleted: true, updated_at: "2000" }]);
    expect((await (await req(app, "/mods")).json() as { items: unknown[] }).items).toHaveLength(2);
    expect((await req(app, "/mods/b%40Beta")).status).toBe(404);

    const back = svc.store.load(writeCatalog([A, B, C]), 3000);
    expect(back.reappeared).toBe(1);
    const again = await (await req(app, "/mods/changed?since=2500")).json() as { items: { id: string; deleted?: boolean }[] };
    expect(again.items.map((i) => [i.id, i.deleted])).toEqual([["b@Beta", undefined]]);
  });

  it("treats first-seen mods as changed 'now' so incremental clients receive them", async () => {
    const { app, svc } = makeServices();
    svc.store.load(writeCatalog([A]), 1000);
    svc.store.load(writeCatalog([A, mod("n@New", "New", 5)]), 5000); // old git timestamp, new to us
    const r = await (await req(app, "/mods/changed?since=4000")).json() as { items: { id: string }[] };
    expect(r.items.map((i) => i.id)).toEqual(["n@New"]);
  });

  it("hides and unhides mods via the admin API", async () => {
    const { app, svc } = makeServices();
    svc.store.load(writeCatalog([A, B]), 1000);
    const auth = { authorization: `Bearer ${ADMIN}` };
    expect((await req(app, "/admin/mods/a%40Alpha/hide", { method: "POST", headers: auth })).status).toBe(200);
    expect((await (await req(app, "/mods")).json() as { items: unknown[] }).items).toHaveLength(1);
    const ch = await (await req(app, "/mods/changed?since=0", { headers: auth })).json() as { items: { id: string; deleted?: boolean }[] };
    expect(ch.items.find((i) => i.id === "a@Alpha")?.deleted).toBe(true);
    await req(app, "/admin/mods/a%40Alpha/hide", { method: "DELETE", headers: auth });
    expect((await (await req(app, "/mods")).json() as { items: unknown[] }).items).toHaveLength(2);
  });
});

describe("downloads", () => {
  it("counts once per visitor per mod per day, and shows today/week/total", async () => {
    let day = "2026-11-15";
    const { app, svc } = makeServices({}, () => day);
    svc.store.load(writeCatalog([A, B]));
    const post = (ip: string, id = "a%40Alpha") => req(app, `/mods/${id}/download`, { method: "POST", ip });
    const r = await post("9.9.9.9");
    expect(await r.json()).toEqual({ download_url: "https://example.com/a%40Alpha.zip" });
    await post("9.9.9.9"); await post("9.9.9.9"); // retries
    await post("8.8.8.8");
    await post("9.9.9.9", "b%40Beta");
    expect(svc.downloads.get("a@Alpha")).toEqual({ total: 2, today: 2, week: 2 });
    expect(svc.downloads.get("b@Beta").total).toBe(1);

    day = "2026-11-16"; // next UTC day: same visitor counts again, 'today' resets, week keeps history
    await post("9.9.9.9");
    expect(svc.downloads.get("a@Alpha")).toEqual({ total: 3, today: 1, week: 3 });
  });

  it("persists across restarts and never double counts after a flush", () => {
    const { svc } = makeServices();
    svc.downloads.record("a@Alpha", "1.2.3.4");
    svc.downloads.record("a@Alpha", "1.2.3.5");
    expect(svc.downloads.flush()).toBe(2);
    expect(svc.downloads.flush()).toBe(0);
    const reborn = new DownloadCounter(svc.db, svc.downloads.hash("x").length ? (svc.db.query("SELECT value FROM meta WHERE key='salt'").get() as { value: string }).value : "", () => "2026-11-15");
    expect(reborn.get("a@Alpha").total).toBe(2);
    expect(reborn.record("a@Alpha", "1.2.3.4")).toBe(false); // seen-set restored
  });

  it("serves download-sorted listings from live counts", async () => {
    const { app, svc } = makeServices();
    svc.store.load(writeCatalog([A, B, C]));
    for (const ip of ["1", "2", "3"]) svc.downloads.record("c@Gamma!", ip);
    svc.downloads.record("b@Beta", "1");
    const r = await (await req(app, "/mods?sort=downloads_desc")).json() as { items: { id: string; downloads: { total: number } }[] };
    expect(r.items.map((i) => [i.id, i.downloads.total])).toEqual([["c@Gamma!", 3], ["b@Beta", 1], ["a@Alpha", 0]]);
  });

  it("returns 404 for unknown mods and mods without a download URL", async () => {
    const { app, svc } = makeServices();
    svc.store.load(writeCatalog([A, mod("x@NoUrl", "NoUrl", 1, null)]));
    expect((await req(app, "/mods/nope/download", { method: "POST" })).status).toBe(404);
    expect((await req(app, "/mods/x%40NoUrl/download", { method: "POST" })).status).toBe(404);
  });
});

describe("paging", () => {
  it("walks all pages with cursors", async () => {
    const { app, svc } = makeServices();
    svc.store.load(writeCatalog(Array.from({ length: 5 }, (_, i) => mod(`m${i}@M`, `M${i}`, i + 1))));
    const seen: string[] = [];
    let cursor = "";
    for (let i = 0; i < 10; i++) {
      const r = await (await req(app, `/mods?limit=2${cursor}`)).json() as { items: { id: string }[]; next_cursor: string | null };
      seen.push(...r.items.map((m) => m.id));
      if (!r.next_cursor) break;
      cursor = `&cursor=${r.next_cursor}`;
    }
    expect(seen).toHaveLength(5);
    expect((await req(app, "/mods?cursor=abc")).status).toBe(400);
    expect((await req(app, "/mods/changed")).status).toBe(400);
  });
});

describe("thumbnails", () => {
  it("serves with etag/304, rejects traversal and unknown files", async () => {
    const { app, svc } = makeServices();
    svc.store.load(writeCatalog([A], ["a@Alpha"]));
    const ok = await req(app, "/thumbnails/a%40Alpha.webp");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/webp");
    const etag = ok.headers.get("etag")!;
    expect((await req(app, "/thumbnails/a%40Alpha.webp", { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await req(app, "/thumbnails/missing.webp")).status).toBe(404);
    expect((await req(app, "/thumbnails/..%2Findex.json")).status).toBe(404);
    expect((await req(app, "/thumbnails/a%40Alpha.png")).status).toBe(404);
  });
});

describe("reports", () => {
  const body = (o: object) => ({ method: "POST", body: JSON.stringify(o) });
  it("stores valid reports, validates input and caps size", async () => {
    const { app, svc } = makeServices();
    expect((await req(app, "/report", body({ title: "t", description: "d", log_b64: "QQ==" }))).status).toBe(201);
    expect((svc.db.query("SELECT count(*) n FROM reports").get() as { n: number }).n).toBe(1);
    expect((await req(app, "/report", { method: "POST", body: "x", ip: "2.2.2.2" })).status).toBe(400);
    expect((await req(app, "/report", { ...body({ description: "d" }), ip: "3.3.3.3" })).status).toBe(400);
    const big = await req(app, "/report", { method: "POST", body: "x".repeat(1_100_000), ip: "4.4.4.4" });
    expect(big.status).toBe(413);
  });
  it("rate limits per IP", async () => {
    const { app } = makeServices();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await req(app, "/report", body({ title: "t", description: "d" }))).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429, 429]);
  });
});

describe("admin & abuse", () => {
  it("is hidden without a token, 401 with a wrong one, works with the right one", async () => {
    const off = makeServices({ adminToken: null });
    expect((await req(off.app, "/admin/stats")).status).toBe(404);
    const { app, svc } = makeServices();
    svc.store.load(writeCatalog([A]));
    expect((await req(app, "/admin/stats")).status).toBe(401);
    expect((await req(app, "/admin/stats", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await req(app, "/admin/stats", { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { mods: number }).mods).toBe(1);
    expect((await req(app, "/metrics", { headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(200);
    expect((await req(app, "/metrics")).status).toBe(401);
  });
  it("blocks banned IPs but keeps /healthz reachable", async () => {
    const { app, svc } = makeServices();
    svc.store.load(writeCatalog([A]));
    await req(app, "/admin/ban", { method: "POST", body: JSON.stringify({ ip: "6.6.6.6" }), headers: { authorization: `Bearer ${ADMIN}` } });
    expect((await req(app, "/mods", { ip: "6.6.6.6" })).status).toBe(403);
    expect((await req(app, "/healthz", { ip: "6.6.6.6" })).status).toBe(200);
    expect((await req(app, "/mods", { ip: "7.7.7.7" })).status).toBe(200);
  });
  it("only trusts forwarded IP headers when configured", async () => {
    const { app, svc } = makeServices({ trustProxy: false });
    svc.store.load(writeCatalog([A]));
    // Spoofed header must not let one client dodge the limiter: all requests share the real ('unknown') address.
    let limited = 0;
    for (let i = 0; i < 130; i++) if ((await app.request("/mods", { headers: { "cf-connecting-ip": `10.0.0.${i}` } })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

describe("admin jobs", () => {
  it("run in the background and report conflicts", async () => {
    const { app, svc } = makeServices();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // No real network in tests; hold the first job open so the second request observes it running.
    svc.fetchFn = (async () => {
      await gate;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    svc.store.load(writeCatalog([A]));
    const auth = { authorization: `Bearer ${ADMIN}` };
    expect((await req(app, "/admin/reload", { method: "POST", headers: auth })).status).toBe(400); // no repo configured
    expect((await req(app, "/admin/links/check", { method: "POST", headers: auth })).status).toBe(202);
    expect((await req(app, "/admin/links/check", { method: "POST", headers: auth })).status).toBe(409);
    release();
  });
});

describe("rate limiter", () => {
  it("refills over time", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 60; i++) expect(rl.allow("x", "ip", 60)).toBe(true);
    expect(rl.allow("x", "ip", 60)).toBe(false);
    t += 1000; // 1 token/second at 60/min
    expect(rl.allow("x", "ip", 60)).toBe(true);
  });
});

describe("link health", () => {
  it("isSafeUrl accepts public https only", () => {
    expect(isSafeUrl("https://github.com/x/y.zip")).toBe(true);
    for (const u of ["http://github.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x", "https://169.254.169.254/x", "https://svc.internal/x", "https://[::1]/x", "file:///etc/passwd", "nope"])
      expect(isSafeUrl(u)).toBe(false);
  });
  it("probe falls back to ranged GET when HEAD is refused", async () => {
    const calls: string[] = [];
    const f = (async (_u: string, init: RequestInit) => { calls.push(init.method!); return new Response(null, { status: init.method === "HEAD" ? 405 : 206 }); }) as unknown as typeof fetch;
    expect(await probe("https://x.test/a.zip", f)).toBe(206);
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(await probe("https://x.test/a.zip", (async () => { throw new Error("boom"); }) as unknown as typeof fetch)).toBe(0);
  });
  it("flags a mod unavailable only after 3 consecutive failures, and recovers", async () => {
    const { svc } = makeServices();
    svc.store.load(writeCatalog([A, B]));
    let aUp = false;
    const fetchFn = (async (u: string) => new Response(null, { status: u.includes("a%2540Alpha") || u.includes("a%40Alpha") ? (aUp ? 200 : 404) : 200 })) as unknown as typeof fetch;
    await checkAllLinks(svc.db, svc.store, { fetchFn });
    await checkAllLinks(svc.db, svc.store, { fetchFn });
    expect(svc.store.get("a@Alpha")?.unavailable).toBeUndefined();
    const third = await checkAllLinks(svc.db, svc.store, { fetchFn });
    expect(third.dead).toBe(1);
    expect(svc.store.get("a@Alpha")?.unavailable).toBe(true);
    expect(svc.store.get("b@Beta")?.unavailable).toBeUndefined();
    aUp = true;
    await checkAllLinks(svc.db, svc.store, { fetchFn });
    expect(svc.store.get("a@Alpha")?.unavailable).toBeUndefined();
  });
});

