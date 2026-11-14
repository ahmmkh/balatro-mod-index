import { describe, expect, it } from "bun:test";
import {
  type CatalogMod,
  changedSince,
  paginate,
  parseCursor,
  parseLimit,
  parseSort,
  sortMods,
  withDownloads,
} from "../src/catalog";

const mod = (id: string, name: string, updated: number): CatalogMod => ({
  id,
  name,
  updated_at: String(updated),
  description: "",
  meta: {},
});
const mods = [mod("b@B", "banana", 20), mod("a@A", "Apple", 30), mod("c@C", "cherry", 10)];
const counts = { "b@B": { total: 5, today: 1, week: 2 }, "c@C": { total: 9, today: 0, week: 3 } };

describe("sortMods", () => {
  const ids = (s: Parameters<typeof sortMods>[1]) => sortMods(mods, s, counts).map((m) => m.id);
  it("sorts by name case-insensitively", () => {
    expect(ids("name_asc")).toEqual(["a@A", "b@B", "c@C"]);
    expect(ids("name_desc")).toEqual(["c@C", "b@B", "a@A"]);
  });
  it("sorts by updated", () => {
    expect(ids("updated_desc")).toEqual(["a@A", "b@B", "c@C"]);
    expect(ids("updated_asc")).toEqual(["c@C", "b@B", "a@A"]);
  });
  it("sorts by downloads, treating missing counts as 0", () => {
    expect(ids("downloads_desc")).toEqual(["c@C", "b@B", "a@A"]);
    expect(ids("downloads_asc")).toEqual(["a@A", "b@B", "c@C"]);
  });
  it("does not mutate its input", () => {
    sortMods(mods, "name_desc", counts);
    expect(mods[0].id).toBe("b@B");
  });
});

describe("paging", () => {
  it("returns a cursor until the end", () => {
    const first = paginate([1, 2, 3, 4, 5], 0, 2);
    expect(first).toEqual({ items: [1, 2], nextCursor: "2" });
    expect(paginate([1, 2, 3, 4, 5], 4, 2)).toEqual({ items: [5], nextCursor: null });
    expect(paginate([1, 2], 0, 2).nextCursor).toBeNull();
  });
  it("validates params", () => {
    expect(parseCursor(null)).toBe(0);
    expect(parseCursor("12")).toBe(12);
    expect(parseCursor("-1")).toBeNull();
    expect(parseCursor("abc")).toBeNull();
    expect(parseLimit("9999")).toBe(500);
    expect(parseLimit("0")).toBe(200);
    expect(parseLimit(null)).toBe(200);
    expect(parseSort("nope")).toBe("name_asc");
    expect(parseSort("downloads_desc")).toBe("downloads_desc");
  });
});

describe("changedSince / withDownloads", () => {
  it("returns only strictly newer mods", () => {
    expect(changedSince(mods, "20").map((m) => m.id)).toEqual(["a@A"]);
  });
  it("defaults downloads to zero", () => {
    expect(withDownloads(mods[1], counts).downloads).toEqual({ total: 0, today: 0, week: 0 });
  });
});
