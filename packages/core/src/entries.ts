import type { Entry, EntryVersion } from "./types.ts";

export function newerFirst(a: EntryVersion, b: EntryVersion): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Version DAG per entry. head = newest non-superseded version; conflict = ≥2 non-superseded versions. */
export class EntryGraph {
  private byEntry = new Map<string, EntryVersion[]>();
  private ids = new Set<string>();
  private cache = new Map<string, Entry>();

  has(id: string) { return this.ids.has(id); }
  get size() { return this.byEntry.size; }

  /** Returns true if new. */
  add(v: EntryVersion): boolean {
    if (this.ids.has(v.id)) return false;
    this.ids.add(v.id);
    let list = this.byEntry.get(v.entryId);
    if (!list) this.byEntry.set(v.entryId, (list = []));
    list.push(v);
    this.cache.delete(v.entryId);
    return true;
  }

  get(entryId: string): Entry | undefined {
    const c = this.cache.get(entryId);
    if (c) return c;
    const list = this.byEntry.get(entryId);
    if (!list || !list.length) return undefined;
    const superseded = new Set<string>();
    for (const v of list) {
      if (v.prev) superseded.add(v.prev);
      if (v.merges) for (const m of v.merges) superseded.add(m);
    }
    const versions = [...list].sort(newerFirst);
    const heads = versions.filter((v) => !superseded.has(v.id));
    const head = heads[0] ?? versions[0]!; // cycles impossible w/ hashes, but be safe
    const e: Entry = { entryId, head, versions, conflict: heads.length >= 2 };
    this.cache.set(entryId, e);
    return e;
  }

  heads(entryId: string): EntryVersion[] {
    const e = this.get(entryId);
    if (!e) return [];
    const superseded = new Set<string>();
    for (const v of e.versions) { if (v.prev) superseded.add(v.prev); v.merges?.forEach((m) => superseded.add(m)); }
    return e.versions.filter((v) => !superseded.has(v.id));
  }

  entryIds() { return this.byEntry.keys(); }
  *all(): Iterable<Entry> { for (const id of this.byEntry.keys()) yield this.get(id)!; }
}
