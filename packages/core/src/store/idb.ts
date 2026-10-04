import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import type { Event, Filter } from "nostr-tools";
import { matchFilter } from "nostr-tools";
import type { Store } from "./types.ts";

export type { Store } from "./types.ts";

/** Browser store backed by IndexedDB (`idb`). One DB per name (default "tribe"). */
export class IdbStore implements Store {
  private dbp: Promise<IDBPDatabase>;
  constructor(name = "tribe") {
    this.dbp = openDB(name, 1, {
      upgrade(db) {
        const ev = db.createObjectStore("events", { keyPath: "id" });
        ev.createIndex("g", "_g", { multiEntry: true });
        db.createObjectStore("kv");
      },
    });
  }
  async putEvents(events: Event[]) {
    if (!events.length) return;
    const db = await this.dbp;
    const tx = db.transaction("events", "readwrite");
    for (const e of events) {
      const _g = e.tags.filter((t) => t[0] === "g").map((t) => t[1]);
      void tx.store.put({ ...e, _g });
    }
    await tx.done;
  }
  private strip(r: any): Event { const { _g, ...e } = r; return e as Event; }
  async getEvent(id: string) { const r = await (await this.dbp).get("events", id); return r ? this.strip(r) : undefined; }
  async queryEvents(filter: Filter) {
    const db = await this.dbp;
    let rows: any[];
    const g = (filter as any)["#g"] as string[] | undefined;
    if (filter.ids) rows = (await Promise.all(filter.ids.map((id) => db.get("events", id)))).filter(Boolean);
    else if (g) rows = (await Promise.all(g.map((v) => db.getAllFromIndex("events", "g", v)))).flat();
    else rows = await db.getAll("events");
    const res = rows.map((r) => this.strip(r)).filter((e) => matchFilter(filter, e));
    res.sort((a, b) => b.created_at - a.created_at);
    return filter.limit !== undefined ? res.slice(0, filter.limit) : res;
  }
  async get<T>(key: string) { return (await (await this.dbp).get("kv", key)) as T | undefined; }
  async set(key: string, value: unknown) { await (await this.dbp).put("kv", value, key); }
  async setMany(entries: [string, unknown][]) {
    const db = await this.dbp;
    const tx = db.transaction("kv", "readwrite");
    for (const [k, v] of entries) void tx.store.put(v, k);
    await tx.done;
  }
  async delete(key: string) { await (await this.dbp).delete("kv", key); }
  async list<T>(prefix: string) {
    const db = await this.dbp;
    const range = IDBKeyRange.bound(prefix, prefix + "￿");
    const [keys, values] = await Promise.all([db.getAllKeys("kv", range), db.getAll("kv", range)]);
    return keys.map((k, i) => ({ key: String(k), value: values[i] as T }));
  }
}
