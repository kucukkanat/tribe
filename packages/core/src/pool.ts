import { SimplePool, matchFilter } from "nostr-tools";
import type { Event, Filter } from "nostr-tools";

export interface RelayStatus {
  url: string;
  /** false if the most recent operation on this relay failed */
  ok: boolean;
  lastError?: string; lastOkAt?: number; lastErrorAt?: number;
  /** result of the most recent publish / query (undefined = not attempted yet) */
  write?: boolean; read?: boolean;
}

export interface RelayPool {
  publish(ev: Event, relays: string[]): Promise<{ ok: string[]; failed: string[] }>;
  subscribe(filters: Filter[], relays: string[], onEvent: (ev: Event) => void, onEose?: () => void): () => void;
  query(filters: Filter[], relays: string[]): Promise<Event[]>;
  /** ADDITION (optional): last known per-relay health from publish/query results. */
  status?(relays?: string[]): RelayStatus[];
}

/** Tracks per-relay health. */
export class RelayHealth {
  private m = new Map<string, RelayStatus>();
  private get(url: string) { let s = this.m.get(url); if (!s) this.m.set(url, (s = { url, ok: true })); return s; }
  ok(url: string, op?: "read" | "write") {
    const s = this.get(url);
    s.ok = true; s.lastOkAt = Date.now();
    if (op) s[op] = true;
  }
  fail(url: string, err: unknown, op?: "read" | "write") {
    const s = this.get(url);
    s.ok = false; s.lastError = errMsg(err); s.lastErrorAt = Date.now();
    if (op) s[op] = false;
  }
  list(relays?: string[]): RelayStatus[] {
    const urls = relays ?? [...this.m.keys()];
    return urls.map((url) => ({ ...(this.m.get(url) ?? { url, ok: true }) }));
  }
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e) ?? String(e)).slice(0, 200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const normUrl = (u: string) => u.replace(/\/+$/, "");

export class NostrPool implements RelayPool {
  readonly pool: SimplePool;
  maxWait: number;
  /** retries per relay for rate-limited / transient publish failures */
  publishRetries: number;
  readonly health = new RelayHealth();
  constructor(opts?: { pool?: SimplePool; maxWait?: number; publishRetries?: number }) {
    this.pool = opts?.pool ?? new SimplePool({ enablePing: true, enableReconnect: true } as any);
    this.maxWait = opts?.maxWait ?? 4000;
    this.publishRetries = opts?.publishRetries ?? 2;
  }
  /** max in-flight publishes per relay (bursts like rotation wraps trip relay rate limits) */
  perRelayConcurrency = 3;
  private inflight = new Map<string, number>();
  private waiters = new Map<string, (() => void)[]>();
  private cooldownUntil = new Map<string, number>();
  private async acquire(url: string) {
    while ((this.inflight.get(url) ?? 0) >= this.perRelayConcurrency) {
      await new Promise<void>((r) => { const w = this.waiters.get(url) ?? []; w.push(r); this.waiters.set(url, w); });
    }
    this.inflight.set(url, (this.inflight.get(url) ?? 0) + 1);
    const cd = (this.cooldownUntil.get(url) ?? 0) - Date.now();
    if (cd > 0) await sleep(cd);
  }
  private release(url: string) {
    this.inflight.set(url, (this.inflight.get(url) ?? 1) - 1);
    this.waiters.get(url)?.shift()?.();
  }
  /** relays that answered "banned"/"blocked" are skipped (fail fast) for this long */
  banCooldownMs = 60_000;
  private bannedUntil = new Map<string, { until: number; msg: string }>();
  private async publishOne(url: string, ev: Event): Promise<void> {
    const ban = this.bannedUntil.get(url);
    if (ban && ban.until > Date.now()) { this.health.fail(url, ban.msg, "write"); throw new Error(ban.msg); }
    await this.acquire(url);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const [p] = this.pool.publish([url], ev, { maxWait: this.maxWait });
          await p!;
          this.health.ok(url, "write");
          return;
        } catch (e) {
          const m = errMsg(e);
          if (/duplicate/i.test(m)) { this.health.ok(url, "write"); return; }
          const limited = /rate-?limit|too (much|many|fast)|slow down|noting too much/i.test(m);
          if (limited) this.cooldownUntil.set(url, Date.now() + 1500 * (attempt + 1));
          const transient = limited || /timed? ?out|connection|closed/i.test(m);
          if (/banned|blocked/i.test(m)) this.bannedUntil.set(url, { until: Date.now() + this.banCooldownMs, msg: m });
          if (/banned|blocked|restricted|policy|pow:|auth-required/i.test(m) || !transient || attempt >= this.publishRetries) {
            this.health.fail(url, e, "write");
            throw e;
          }
          await sleep(limited ? 1500 * (attempt + 1) : 500 * (attempt + 1) + Math.random() * 300);
        }
      }
    } finally { this.release(url); }
  }
  async publish(ev: Event, relays: string[]) {
    const res = await Promise.allSettled(relays.map((u) => this.publishOne(u, ev)));
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
        onclose: (reasons: { url: string; reason: string }[] | string[]) => {
          for (const r of reasons as any[]) if (r && typeof r === "object" && r.reason && !/closed by caller/i.test(r.reason)) this.health.fail(r.url, r.reason, "read");
        },
      } as any),
    );
    if (filters.length === 0) onEose?.();
    return () => subs.forEach((s) => s.close());
  }
  /** Per-relay query: each relay gets its own subscription so one slow/broken relay can't stall or hide others. */
  async query(filters: Filter[], relays: string[]): Promise<Event[]> {
    const seen = new Map<string, Event>();
    await Promise.all(relays.map(async (url) => {
      try {
        const lists = await Promise.all(filters.map((f) => this.queryRelay(url, f)));
        for (const list of lists) for (const e of list) seen.set(e.id, e);
        this.health.ok(url, "read");
      } catch (e) { this.health.fail(url, e, "read"); }
    }));
    return [...seen.values()];
  }
  private queryRelay(url: string, f: Filter): Promise<Event[]> {
    return new Promise((resolve, reject) => {
      const out: Event[] = [];
      let done = false;
      const finish = (err?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sub.close(); } catch { /* ignore */ }
        if (err && !out.length) reject(err); else resolve(out);
      };
      // eose may never come from a relay that silently drops the REQ → hard timeout
      const timer = setTimeout(() => finish(out.length ? undefined : new Error("query timeout (no EOSE)")), this.maxWait + 2000);
      const sub = this.pool.subscribeMany([url], f, {
        maxWait: this.maxWait,
        onevent: (e: Event) => out.push(e),
        oneose: () => finish(),
        onclose: (reasons: any) => {
          const r = Array.isArray(reasons) ? reasons[0] : reasons;
          const reason = typeof r === "string" ? r : r?.reason;
          finish(reason && !/closed by caller|eose/i.test(reason) ? new Error(reason) : undefined);
        },
      } as any);
    });
  }
  status(relays?: string[]): RelayStatus[] {
    const conn = this.pool.listConnectionStatus();
    const byNorm = new Map([...conn].map(([u, v]) => [normUrl(u), v]));
    return this.health.list(relays).map((s) => {
      const c = byNorm.get(normUrl(s.url));
      return c === false && s.ok ? { ...s, ok: false, lastError: s.lastError ?? "disconnected" } : s;
    });
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

  status(relays?: string[]): RelayStatus[] {
    const urls = relays ?? [...this.relays.keys()];
    return urls.map((url) => (this.down.has(url) ? { url, ok: false, lastError: "down (mock)" } : { url, ok: true }));
  }

  /** Test helper: all events stored on a relay. */
  dump(url?: string): Event[] {
    if (url) return [...this.relay(url).values()];
    const m = new Map<string, Event>();
    for (const r of this.relays.values()) for (const e of r.values()) m.set(e.id, e);
    return [...m.values()];
  }
}
