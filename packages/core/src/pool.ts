import { SimplePool, matchFilter } from "nostr-tools";
import type { Event, Filter } from "nostr-tools";

export interface RelayPool {
  publish(ev: Event, relays: string[]): Promise<{ ok: string[]; failed: string[] }>;
  subscribe(filters: Filter[], relays: string[], onEvent: (ev: Event) => void, onEose?: () => void): () => void;
  query(filters: Filter[], relays: string[]): Promise<Event[]>;
}

export class NostrPool implements RelayPool {
  readonly pool: SimplePool;
  maxWait: number;
  constructor(opts?: { pool?: SimplePool; maxWait?: number }) {
    this.pool = opts?.pool ?? new SimplePool();
    this.maxWait = opts?.maxWait ?? 4000;
  }
  async publish(ev: Event, relays: string[]) {
    const res = await Promise.allSettled(this.pool.publish(relays, ev, { maxWait: this.maxWait }));
    const ok: string[] = [], failed: string[] = [];
    res.forEach((r, i) => (r.status === "fulfilled" ? ok : failed).push(relays[i]!));
    return { ok, failed };
  }
  subscribe(filters: Filter[], relays: string[], onEvent: (ev: Event) => void, onEose?: () => void) {
    let pending = filters.length;
    const subs = filters.map((f) =>
      this.pool.subscribeMany(relays, f, {
        onevent: onEvent,
        oneose: () => { if (--pending === 0) onEose?.(); },
      }),
    );
    if (filters.length === 0) onEose?.();
    return () => subs.forEach((s) => s.close());
  }
  async query(filters: Filter[], relays: string[]): Promise<Event[]> {
    const all = await Promise.all(filters.map((f) => this.pool.querySync(relays, f, { maxWait: this.maxWait })));
    const seen = new Map<string, Event>();
    for (const list of all) for (const e of list) seen.set(e.id, e);
    return [...seen.values()];
  }
  close() { this.pool.destroy(); }
}

const isReplaceable = (k: number) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isAddressable = (k: number) => k >= 30000 && k < 40000;
const isEphemeral = (k: number) => k >= 20000 && k < 30000;
const dTag = (e: Event) => e.tags.find((t) => t[0] === "d")?.[1] ?? "";

/** In-memory relay set. Relays are simulated as one shared store per URL. */
export class MockPool implements RelayPool {
  private relays = new Map<string, Map<string, Event>>();
  private subs = new Set<{ filters: Filter[]; relays: Set<string>; onEvent: (e: Event) => void }>();
  /** relays that reject publishes (to simulate failures) */
  down = new Set<string>();
  /** artificial async delay in ms (0 = microtask) */
  delay = 0;
  publishedCount = 0;

  private relay(url: string) {
    let r = this.relays.get(url);
    if (!r) this.relays.set(url, (r = new Map()));
    return r;
  }
  private tick() { return this.delay ? new Promise((r) => setTimeout(r, this.delay)) : Promise.resolve(); }

  /** Insert into a relay applying replaceable/addressable semantics. Returns true if stored/new. */
  private store(url: string, ev: Event): boolean {
    const r = this.relay(url);
    if (r.has(ev.id)) return false;
    if (isEphemeral(ev.kind)) return true;
    if (isReplaceable(ev.kind) || isAddressable(ev.kind)) {
      const addr = isAddressable(ev.kind);
      for (const [id, o] of r) {
        if (o.kind === ev.kind && o.pubkey === ev.pubkey && (!addr || dTag(o) === dTag(ev))) {
          if (o.created_at > ev.created_at || (o.created_at === ev.created_at && o.id < ev.id)) return false;
          r.delete(id);
        }
      }
    }
    if (ev.kind === 5) {
      const ids = ev.tags.filter((t) => t[0] === "e").map((t) => t[1]!);
      for (const id of ids) { const o = r.get(id); if (o && o.pubkey === ev.pubkey) r.delete(id); }
    }
    r.set(ev.id, ev);
    return true;
  }

  async publish(ev: Event, relays: string[]) {
    await this.tick();
    const ok: string[] = [], failed: string[] = [];
    const fresh = new Set<string>();
    for (const url of relays) {
      if (this.down.has(url)) { failed.push(url); continue; }
      if (this.store(url, ev)) fresh.add(url);
      ok.push(url);
    }
    this.publishedCount++;
    if (fresh.size) {
      for (const s of [...this.subs]) {
        if ([...fresh].some((u) => s.relays.has(u)) && s.filters.some((f) => matchFilter(f, ev))) s.onEvent(ev);
      }
    }
    return { ok, failed };
  }

  private collect(filters: Filter[], relays: string[]): Event[] {
    const out = new Map<string, Event>();
    for (const f of filters) {
      const matched: Event[] = [];
      for (const url of relays) {
        if (this.down.has(url)) continue;
        for (const e of this.relay(url).values()) if (matchFilter(f, e)) matched.push(e);
      }
      matched.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
      const uniq: Event[] = [];
      const ids = new Set<string>();
      for (const e of matched) if (!ids.has(e.id)) { ids.add(e.id); uniq.push(e); }
      const lim = f.limit !== undefined ? uniq.slice(0, f.limit) : uniq;
      for (const e of lim) out.set(e.id, e);
    }
    return [...out.values()];
  }

  async query(filters: Filter[], relays: string[]) {
    await this.tick();
    return this.collect(filters, relays);
  }

  subscribe(filters: Filter[], relays: string[], onEvent: (ev: Event) => void, onEose?: () => void) {
    const sub = { filters: filters.map((f) => ({ ...f })), relays: new Set(relays), onEvent };
    let closed = false;
    this.subs.add(sub);
    void this.tick().then(() => {
      if (closed) return;
      for (const e of this.collect(filters, relays)) onEvent(e);
      // after initial batch, live events only (strip limit)
      sub.filters.forEach((f) => delete f.limit);
      onEose?.();
    });
    return () => { closed = true; this.subs.delete(sub); };
  }

  /** Test helper: all events stored on a relay. */
  dump(url?: string): Event[] {
    if (url) return [...this.relay(url).values()];
    const m = new Map<string, Event>();
    for (const r of this.relays.values()) for (const e of r.values()) m.set(e.id, e);
    return [...m.values()];
  }
}
