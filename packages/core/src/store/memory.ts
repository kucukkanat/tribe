import type { Event, Filter } from "nostr-tools";
import { matchFilter } from "nostr-tools";
import type { Store } from "./types.ts";

/** Indexes events by blinded `g` tag for fast bucket-scoped queries. */
export class EventIndex {
  byId = new Map<string, Event>();
  byG = new Map<string, Set<string>>();
  add(e: Event) {
    if (this.byId.has(e.id)) return false;
    this.byId.set(e.id, e);
    for (const t of e.tags) if (t[0] === "g" && t[1]) {
      let s = this.byG.get(t[1]);
      if (!s) this.byG.set(t[1], (s = new Set()));
      s.add(e.id);
    }
    return true;
  }
  query(f: Filter): Event[] {
    let candidates: Iterable<Event>;
    const ids = f.ids, g = (f as any)["#g"] as string[] | undefined;
    if (ids) candidates = ids.map((i) => this.byId.get(i)).filter((e): e is Event => !!e);
    else if (g) {
      const out: Event[] = [];
      for (const gv of g) for (const id of this.byG.get(gv) ?? []) out.push(this.byId.get(id)!);
      candidates = out;
    } else candidates = this.byId.values();
    const res: Event[] = [];
    for (const e of candidates) if (matchFilter(f, e)) res.push(e);
    res.sort((a, b) => b.created_at - a.created_at);
    return f.limit !== undefined ? res.slice(0, f.limit) : res;
  }
}

export class MemoryStore implements Store {
  protected events = new EventIndex();
  protected kv = new Map<string, unknown>();
  async putEvents(events: Event[]) { for (const e of events) this.events.add(e); }
  async getEvent(id: string) { return this.events.byId.get(id); }
  async queryEvents(filter: Filter) { return this.events.query(filter); }
  async get<T>(key: string) { return this.kv.get(key) as T | undefined; }
  async set(key: string, value: unknown) { this.kv.set(key, value); }
  async setMany(entries: [string, unknown][]) { for (const [k, v] of entries) this.kv.set(k, v); }
  async delete(key: string) { this.kv.delete(key); }
  async list<T>(prefix: string) {
    const out: { key: string; value: T }[] = [];
    for (const [key, value] of this.kv) if (key.startsWith(prefix)) out.push({ key, value: value as T });
    return out;
  }
}
