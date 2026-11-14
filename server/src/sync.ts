import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import type { CatalogStore, LoadStats } from "./store";

export async function run(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.trim().slice(-500)}`);
  return out.trim();
}

export interface SyncStatus {
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  head: string | null;
  running: boolean;
}

/** Loads the catalog at boot and keeps it current from the index git repo. */
export class IndexSync {
  status: SyncStatus = { lastRunAt: null, lastOkAt: null, lastError: null, head: null, running: false };

  constructor(
    private readonly cfg: Config,
    private readonly store: CatalogStore,
    private readonly log: (event: string, data?: Record<string, unknown>) => void = () => {},
  ) {}

  /** Load whatever catalog is already on disk (fast; used before the first network sync). */
  loadFromDisk(): LoadStats | null {
    for (const dir of [join(this.cfg.catalogDir, "current"), this.cfg.catalogDir]) {
      if (existsSync(join(dir, "index.json"))) return this.store.load(realpathSync(dir));
    }
    return null;
  }

  async syncOnce(force = false): Promise<{ changed: boolean }> {
    if (this.status.running) return { changed: false };
    if (!this.cfg.indexRepoUrl) return { changed: false };
    this.status.running = true;
    this.status.lastRunAt = Math.floor(Date.now() / 1000);
    try {
      const { indexDir, indexRepoUrl, indexBranch, catalogDir } = this.cfg;
      if (!existsSync(join(indexDir, ".git"))) {
        mkdirSync(indexDir, { recursive: true });
        await run(["git", "clone", "--filter=blob:none", "--branch", indexBranch, indexRepoUrl, indexDir]);
      }
      await run(["git", "fetch", "--prune", "origin", indexBranch], indexDir);
      const head = await run(["git", "rev-parse", `origin/${indexBranch}`], indexDir);
      const headFile = join(catalogDir, "HEAD");
      const built = existsSync(headFile) ? readFileSync(headFile, "utf8").trim() : null;
      this.status.head = head;
      if (!force && built === head && this.store.ready) {
        this.status.lastOkAt = this.status.lastRunAt;
        this.status.lastError = null;
        return { changed: false };
      }
      await run(["git", "reset", "--hard", `origin/${indexBranch}`], indexDir);

      mkdirSync(catalogDir, { recursive: true });
      const name = `build-${Date.now()}`;
      const outDir = join(catalogDir, name);
      await run(["python3", join(indexDir, "scripts", "build_index.py"), "--out", outDir]);

      const tmpLink = join(catalogDir, "current.tmp");
      rmSync(tmpLink, { force: true });
      symlinkSync(name, tmpLink);
      renameSync(tmpLink, join(catalogDir, "current")); // atomic swap
      const stats = this.store.load(realpathSync(outDir));
      writeFileSync(headFile, head);
      this.prune(name);
      this.status.lastOkAt = this.status.lastRunAt;
      this.status.lastError = null;
      this.log("catalog_synced", { head, ...stats });
      return { changed: true };
    } catch (err) {
      this.status.lastError = String(err instanceof Error ? err.message : err);
      this.log("catalog_sync_failed", { error: this.status.lastError });
      return { changed: false };
    } finally {
      this.status.running = false;
    }
  }

  private prune(keep: string): void {
    const builds = readdirSync(this.cfg.catalogDir).filter((n) => n.startsWith("build-")).sort();
    for (const old of builds.slice(0, -2)) if (old !== keep) rmSync(join(this.cfg.catalogDir, old), { recursive: true, force: true });
  }
}
