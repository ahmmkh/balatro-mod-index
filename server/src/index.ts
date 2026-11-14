import { mkdirSync } from "node:fs";
import { createApp, type Services } from "./app";
import { loadConfig } from "./config";
import { getSecret, openDb } from "./db";
import { DownloadCounter } from "./downloads";
import { checkAllLinks } from "./links";
import { RateLimiter } from "./ratelimit";
import { CatalogStore } from "./store";
import { IndexSync } from "./sync";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
const db = openDb(`${cfg.dataDir}/bmi.sqlite`);
const store = new CatalogStore(db);
const downloads = new DownloadCounter(db, getSecret(db));
const sync = new IndexSync(cfg, store, log);

const svc: Services = { cfg, db, store, downloads, limiter: new RateLimiter(), sync, counters: {} };
const app = createApp(svc);

try {
  const stats = sync.loadFromDisk();
  if (stats) log("catalog_loaded_from_disk", { ...stats });
} catch (err) {
  log("catalog_disk_load_failed", { error: String(err) });
}

const server = Bun.serve({
  port: cfg.port,
  fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address }),
});
log("listening", { port: server.port, trustProxy: cfg.trustProxy, admin: !!cfg.adminToken, repo: cfg.indexRepoUrl });

const every = (ms: number, fn: () => unknown) => setInterval(() => void Promise.resolve(fn()).catch((e) => log("task_failed", { error: String(e) })), ms).unref();
every(5_000, () => downloads.flush());
every(60_000, () => svc.limiter.sweep());
if (cfg.indexRepoUrl) {
  void sync.syncOnce();
  every(cfg.syncIntervalSec * 1000, () => sync.syncOnce());
}
setTimeout(() => void checkAllLinks(db, store).then((s) => log("links_checked", { ...s })).catch((e) => log("links_failed", { error: String(e) })), 120_000).unref();
every(cfg.linkCheckIntervalSec * 1000, async () => log("links_checked", { ...(await checkAllLinks(db, store)) }));

const shutdown = (sig: string) => {
  log("shutdown", { sig });
  try {
    downloads.flush();
  } finally {
    server.stop();
    db.close();
    process.exit(0);
  }
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
