import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Services } from "../src/app";
import type { CatalogMod } from "../src/catalog";
import { loadConfig, type Config } from "../src/config";
import { getSecret, openDb } from "../src/db";
import { DownloadCounter } from "../src/downloads";
import { RateLimiter } from "../src/ratelimit";
import { CatalogStore } from "../src/store";

export const ADMIN = "a".repeat(32);

export function mod(id: string, name: string, updated: number, url: string | null = `https://example.com/${encodeURIComponent(id)}.zip`): CatalogMod {
  return { id, name, updated_at: String(updated), description: `${name} desc`, meta: { downloadURL: url, title: name } };
}

/** Write a catalog dir (index.json + thumbnails/) and return its path. */
export function writeCatalog(mods: CatalogMod[], thumbs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "bmi-cat-"));
  mkdirSync(join(dir, "thumbnails"));
  writeFileSync(join(dir, "index.json"), JSON.stringify({ mods }));
  for (const t of thumbs) writeFileSync(join(dir, "thumbnails", `${t}.webp`), "RIFFxxxxWEBP");
  return dir;
}

export function makeServices(overrides: Partial<Config> = {}, today: () => string = () => "2026-11-15") {
  const dataDir = mkdtempSync(join(tmpdir(), "bmi-data-"));
  const cfg = { ...loadConfig({ DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, TRUST_PROXY: "1" }), ...overrides };
  const db = openDb(join(dataDir, "bmi.sqlite"));
  const store = new CatalogStore(db);
  const downloads = new DownloadCounter(db, getSecret(db), today);
  const svc: Services = { cfg, db, store, downloads, limiter: new RateLimiter(), sync: null, counters: {} };
  return { svc, app: createApp(svc), dataDir };
}

export const req = (app: ReturnType<typeof createApp>, path: string, init: RequestInit & { ip?: string } = {}) => {
  const { ip = "1.1.1.1", ...rest } = init;
  return app.request(path, { ...rest, headers: { "cf-connecting-ip": ip, ...(rest.headers as Record<string, string>) } });
};
