// Pure catalog logic (sorting, paging, change filtering) - no Workers APIs, so it is unit-testable.

export interface Downloads {
  total: number;
  today: number;
  week: number;
}

export const ZERO_DOWNLOADS: Downloads = { total: 0, today: 0, week: 0 };

export interface CatalogMod {
  id: string;
  name: string;
  updated_at: string;
  description: string;
  meta: { "downloadURL"?: string | null } & Record<string, unknown>;
  thumbnail_url?: string;
  /** Set by the server when the mod's download link has been failing health checks. */
  unavailable?: boolean;
}

/** Marker sent in `changed` responses so clients drop a mod they previously cached. */
export interface Tombstone {
  id: string;
  deleted: true;
  updated_at: string;
}

export type SortMode =
  | "name_asc"
  | "name_desc"
  | "updated_asc"
  | "updated_desc"
  | "downloads_asc"
  | "downloads_desc";

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;

const SORTS = new Set<string>([
  "name_asc",
  "name_desc",
  "updated_asc",
  "updated_desc",
  "downloads_asc",
  "downloads_desc",
]);

export function parseSort(value: string | null): SortMode {
  return value !== null && SORTS.has(value) ? (value as SortMode) : "name_asc";
}

export function parseLimit(value: string | null): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** Cursor is the offset into the sorted list. Returns null for a malformed cursor. */
export function parseCursor(value: string | null): number | null {
  if (value === null || value === "") return 0;
  return /^\d{1,9}$/.test(value) ? Number.parseInt(value, 10) : null;
}

function byName(a: CatalogMod, b: CatalogMod): number {
  return (
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id)
  );
}

export function sortMods(
  mods: readonly CatalogMod[],
  sort: SortMode,
  counts: Readonly<Record<string, Downloads>>,
): CatalogMod[] {
  const total = (m: CatalogMod) => counts[m.id]?.total ?? 0;
  const updated = (m: CatalogMod) => Number(m.updated_at) || 0;
  const out = [...mods];
  switch (sort) {
    case "name_asc":
      return out.sort(byName);
    case "name_desc":
      return out.sort((a, b) => byName(b, a));
    case "updated_asc":
      return out.sort((a, b) => updated(a) - updated(b) || byName(a, b));
    case "updated_desc":
      return out.sort((a, b) => updated(b) - updated(a) || byName(a, b));
    case "downloads_asc":
      return out.sort((a, b) => total(a) - total(b) || byName(a, b));
    case "downloads_desc":
      return out.sort((a, b) => total(b) - total(a) || byName(a, b));
  }
}

export function changedSince(mods: readonly CatalogMod[], since: string): CatalogMod[] {
  const cutoff = Number(since);
  if (!Number.isFinite(cutoff)) return [...mods];
  return mods.filter((m) => (Number(m.updated_at) || 0) > cutoff);
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function paginate<T>(items: readonly T[], offset: number, limit: number): Page<T> {
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit;
  return { items: slice, nextCursor: next < items.length ? String(next) : null };
}

export function withDownloads(
  mod: CatalogMod,
  counts: Readonly<Record<string, Downloads>>,
): CatalogMod & { downloads: Downloads } {
  return { ...mod, downloads: counts[mod.id] ?? ZERO_DOWNLOADS };
}
