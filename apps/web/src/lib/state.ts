// App-wide state: identity, mode (live/demo), pool/store, open buckets, sync status.
import { useEffect, useReducer } from "preact/hooks";
import { Bucket, Identity, MockPool, MemoryStore, NostrPool, makeIdbStore, type BucketSummary, type Pool, type Store } from "./core";
import { loadRecord, saveRecord, clearRecord, localRecord, localSecret, unlockWithPasskey, protectWithPasskey, type KeyRecord } from "./keystore";
import { toastError } from "./toast";

export type SyncInfo = { state: "idle" | "syncing" | "ok" | "error"; at?: number; error?: string };
export type Phase = "boot" | "needs-identity" | "locked" | "ready";

interface AppState {
  phase: Phase;
  mode: "live" | "demo";
  identity: Identity | null;
  record: KeyRecord | null;
  buckets: BucketSummary[] | null;
  sync: Record<string, SyncInfo>;
  demoSeeding: boolean;
  /** bumps whenever any open bucket changes */
  rev: number;
}

export const state: AppState = {
  phase: "boot", mode: "live", identity: null, record: null, buckets: null, sync: {}, demoSeeding: false, rev: 0,
};

const subs = new Set<() => void>();
export function update(patch: Partial<AppState> = {}) {
  Object.assign(state, patch);
  state.rev++;
  subs.forEach((f) => f());
}
export function useApp(): AppState {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { const f = () => force(0); subs.add(f); return () => { subs.delete(f); }; }, []);
  return state;
}

// ---- pool / store per mode ----
let pool: Pool | null = null;
let store: Store | null = null;
const open = new Map<string, Bucket>();
const opening = new Map<string, Promise<Bucket>>();
const unlive = new Map<string, () => void>();

export function getPool(): Pool {
  if (!pool) pool = state.mode === "demo" ? new MockPool() : new NostrPool();
  return pool;
}
export async function getStore(): Promise<Store> {
  if (!store) store = state.mode === "demo" ? new MemoryStore() : await makeIdbStore();
  return store;
}

const DEMO_KEY = "tribe.demo";
export function demoRequested(): boolean {
  if (new URLSearchParams(location.search).get("demo") === "1") return true;
  try { return localStorage.getItem(DEMO_KEY) === "1"; } catch { return false; }
}

export async function boot() {
  if (demoRequested()) return startDemo();
  update({ mode: "live" });
  const record = await loadRecord();
  if (!record) return update({ phase: "needs-identity", record: null });
  if (record.kind === "local") {
    const identity = Identity.fromSecret(localSecret(record));
    return becomeReady(identity, record);
  }
  update({ phase: "locked", record });
}

async function becomeReady(identity: Identity, record: KeyRecord | null) {
  update({ identity, record, phase: "ready" });
  await refreshBuckets();
}

export async function refreshBuckets() {
  try {
    const list = await Bucket.listMine(await getStore());
    update({ buckets: list });
  } catch (e) { toastError(e, "Could not read your buckets"); update({ buckets: [] }); }
}

export async function unlock() {
  const r = state.record;
  if (!r || r.kind !== "passkey") return;
  const { sk, upgraded } = await unlockWithPasskey(r);
  if (upgraded) { try { await saveRecord(upgraded); } catch (e) { console.warn("could not re-wrap key", e); } }
  await becomeReady(Identity.fromSecret(sk), upgraded ?? r);
}

/** Save a freshly created/imported identity. protect = "passkey" | "local". */
export async function adoptIdentity(identity: Identity, protect: "passkey" | "local", label = "Tribe") {
  if (state.mode === "demo") return becomeReady(identity, null);
  const record = protect === "passkey" ? await protectWithPasskey(identity.sk, identity.pk, label) : localRecord(identity.sk, identity.pk);
  await saveRecord(record);
  await becomeReady(identity, record);
}

export function lock() {
  closeAll();
  if (state.record?.kind === "passkey") update({ identity: null, phase: "locked", buckets: null });
}

export async function signOut() {
  closeAll();
  if (state.mode === "live") await clearRecord();
  update({ identity: null, record: null, phase: "needs-identity", buckets: null });
}

function closeAll() {
  unlive.forEach((f) => f());
  unlive.clear(); open.clear(); opening.clear();
}

// ---- buckets ----
export function cachedBucket(id: string): Bucket | undefined { return open.get(id); }

export function setSync(id: string, s: SyncInfo) { update({ sync: { ...state.sync, [id]: s } }); }

export async function syncBucket(b: Bucket) {
  setSync(b.bucketId, { ...state.sync[b.bucketId], state: "syncing" });
  try {
    await b.sync();
    setSync(b.bucketId, { state: "ok", at: Date.now() });
  } catch (e) {
    setSync(b.bucketId, { state: "error", at: state.sync[b.bucketId]?.at, error: e instanceof Error ? e.message : String(e) });
  }
}

export function adoptBucket(b: Bucket) {
  open.set(b.bucketId, b);
  if (!unlive.has(b.bucketId)) {
    try { unlive.set(b.bucketId, b.live(() => update())); } catch (e) { console.warn("live() failed", e); }
  }
  update();
}

export function openBucket(id: string): Promise<Bucket> {
  const hit = open.get(id);
  if (hit) return Promise.resolve(hit);
  let p = opening.get(id);
  if (p) return p;
  p = (async () => {
    if (!state.identity) throw new Error("Unlock your identity first.");
    const summary = state.buckets?.find((s) => s.bucketId === id);
    const b = await Bucket.open({ identity: state.identity, bucketId: id, pool: getPool(), store: await getStore(), relays: summary?.relays });
    adoptBucket(b);
    if (state.mode === "live") void syncBucket(b);
    else setSync(id, { state: "ok", at: Date.now() });
    return b;
  })();
  opening.set(id, p);
  p.catch(() => opening.delete(id));
  return p;
}

/** Hook: opens the bucket, re-renders on any change. */
export function useBucket(id: string): { bucket: Bucket | null; error: string | null } {
  const app = useApp();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const b = open.get(id) ?? null;
  const err = errors.get(id) ?? null;
  useEffect(() => {
    if (b || app.phase !== "ready") return;
    errors.delete(id);
    openBucket(id).then(() => force(0), (e) => { errors.set(id, e instanceof Error ? e.message : String(e)); force(0); });
  }, [id, app.phase, !!b]);
  return { bucket: b, error: err };
}
const errors = new Map<string, string>();

// ---- demo ----
export async function startDemo() {
  closeAll();
  pool = null; store = null;
  try { localStorage.setItem(DEMO_KEY, "1"); } catch {}
  update({ mode: "demo", phase: "boot", demoSeeding: true, buckets: null, identity: null, record: null });
  try {
    const { seedDemo } = await import("./demo");
    const { identity, bucket } = await seedDemo(getPool(), await getStore());
    adoptBucket(bucket);
    setSync(bucket.bucketId, { state: "ok", at: Date.now() });
    await becomeReady(identity, null);
    if (!location.hash || location.hash === "#/" || location.hash.startsWith("#/welcome")) location.hash = `#/b/${bucket.bucketId}`;
  } catch (e) {
    toastError(e, "Demo failed to load");
    update({ phase: "needs-identity" });
  } finally {
    update({ demoSeeding: false });
  }
}

export async function exitDemo() {
  try { localStorage.removeItem(DEMO_KEY); } catch {}
  closeAll();
  pool = null; store = null;
  const url = new URL(location.href);
  url.searchParams.delete("demo");
  url.hash = "#/";
  history.replaceState(null, "", url.toString());
  update({ identity: null, record: null, buckets: null, sync: {} });
  await boot();
}
