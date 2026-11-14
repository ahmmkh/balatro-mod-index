export interface Config {
  port: number;
  dataDir: string;
  /** Directory holding index.json + thumbnails/ (built by scripts/build_index.py). */
  catalogDir: string;
  /** Git remote of the index repo. If unset, the server just serves whatever is in catalogDir. */
  indexRepoUrl: string | null;
  indexBranch: string;
  /** Where the index repo is cloned. */
  indexDir: string;
  /** Path to scripts/build_index.py inside the clone. */
  syncIntervalSec: number;
  linkCheckIntervalSec: number;
  adminToken: string | null;
  /** Trust CF-Connecting-IP / X-Forwarded-For (only when behind Cloudflare Tunnel / a trusted proxy). */
  trustProxy: boolean;
  discordWebhookUrl: string | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = env.DATA_DIR ?? "./data";
  const int = (v: string | undefined, d: number) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const adminToken = env.ADMIN_TOKEN?.trim() || null;
  if (adminToken && adminToken.length < 24) throw new Error("ADMIN_TOKEN must be at least 24 characters");
  return {
    port: int(env.PORT, 8080),
    dataDir,
    catalogDir: env.CATALOG_DIR ?? `${dataDir}/catalog`,
    indexRepoUrl: env.INDEX_REPO_URL?.trim() || null,
    indexBranch: env.INDEX_BRANCH ?? "main",
    indexDir: env.INDEX_DIR ?? `${dataDir}/index-repo`,
    syncIntervalSec: int(env.SYNC_INTERVAL_SEC, 900),
    linkCheckIntervalSec: int(env.LINK_CHECK_INTERVAL_SEC, 6 * 3600),
    adminToken,
    trustProxy: env.TRUST_PROXY === "1",
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL?.trim() || null,
  };
}
