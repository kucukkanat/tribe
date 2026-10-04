import { Bucket, Identity, MemoryStore, MockPool, NostrPool, findOwner } from "./core.ts";
import { bucketStorePath, ensureHome } from "./device.ts";
import { log } from "./log.ts";

/** nostr-tools SimplePool needs a global WebSocket. Bun has one; old Node does not. */
export async function ensureWebSocket(): Promise<void> {
  if (typeof (globalThis as any).WebSocket === "function") return;
  const { WebSocket } = await import("ws");
  (globalThis as any).WebSocket = WebSocket;
  try {
    const spec = "nostr-tools/pool"; // resolved via @tribe/core's dependency tree; may be absent
    const pool: any = await import(spec);
    pool.useWebSocketImplementation?.(WebSocket);
  } catch {
    // nostr-tools not directly resolvable from this package; the global is enough.
  }
}

export class NotPairedError extends Error {
  constructor(
    public readonly bucketId: string,
    public readonly devicePk: string,
    cause?: unknown,
  ) {
    super(
      `This device is not paired with bucket ${bucketId} yet (no key grant found for device ${devicePk}).\n` +
        `Ask a bucket member to open the Tribe web app → Devices & Agents → Pair an agent, and paste this device's npub ` +
        `(run \`tribe-mcp init\` to show it). Then retry.` +
        (cause instanceof Error ? `\n(cause: ${cause.message})` : ""),
    );
  }
}

export interface Opened {
  bucket: Bucket;
  identity: Identity;
  /** Close relay subscriptions etc. */
  close: () => void;
}

function looksUnpaired(err: unknown): boolean {
  const m = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (/roster not found/.test(m)) return false; // have keys but no roster: relays unreachable / wrong relays
  return /grant|not (a )?member|no access|not paired|no key|unauthori[sz]ed|forbidden/.test(m);
}

export async function openReal(opts: { identity: Identity; bucketId: string; relays?: string[] }): Promise<Opened> {
  await ensureWebSocket();
  ensureHome();
  const { FileStore } = await import("@tribe/core/file");
  const store = new FileStore(bucketStorePath(opts.bucketId));
  const pool = new NostrPool();
  const relays = opts.relays?.length ? opts.relays : undefined;
  let bucket: Bucket;
  try {
    // Bucket.open syncs from relays itself.
    bucket = await Bucket.open({ identity: opts.identity, bucketId: opts.bucketId, pool, store, ...(relays ? { relays } : {}) });
  } catch (err) {
    try {
      pool.close?.();
    } catch {}
    if (looksUnpaired(err)) throw new NotPairedError(opts.bucketId, opts.identity.pk, err);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg}. Check --relays (currently ${(relays ?? ["bucket defaults"]).join(", ")}) and your network.`);
  }
  if (!bucket.roster) {
    pool.close?.();
    throw new NotPairedError(opts.bucketId, opts.identity.pk);
  }
  return {
    bucket,
    identity: opts.identity,
    close: () => {
      try {
        store.flush();
      } catch (err) {
        log("failed to flush local cache:", err);
      }
      try {
        pool.close?.();
      } catch {}
    },
  };
}

/**
 * In-process demo/test mode: one MockPool, an admin creates a bucket, pairs the
 * device, seeds a couple of entries, and the device opens the bucket.
 */
export async function openMock(opts: { identity: Identity; label: string; seed?: boolean }): Promise<Opened & { admin: Identity; adminBucket: Bucket }> {
  const pool = new MockPool();
  const admin = Identity.generate();
  const adminBucket = await Bucket.create({ identity: admin, name: "Mock Team", pool, store: new MemoryStore() });
  await adminBucket.addDevice(opts.identity.pk, opts.label, "agent");
  if (opts.seed !== false) {
    const f = await adminBucket.write({
      type: "fact",
      title: "Staging database runs Postgres 16",
      body: "The staging DB is Postgres 16 on host db-stg-1. Migrations run via `bun run migrate`.",
      tags: ["infra", "postgres"],
      source: "human",
    });
    await adminBucket.write({
      type: "page",
      title: "Infrastructure overview",
      body: "Entry point for infra knowledge.",
      tags: ["infra"],
      links: [f.entryId],
      source: "human",
    });
  }
  const bucket = await Bucket.open({ identity: opts.identity, bucketId: adminBucket.bucketId, pool, store: new MemoryStore(), adminHint: admin.pk });
  await bucket.sync();
  const owner = findOwner(bucket, opts.identity.pk);
  log(`mock bucket ${bucket.bucketId} ready; device owner = ${owner?.pk ?? "unresolved"}`);
  return { bucket, identity: opts.identity, admin, adminBucket, close: () => {} };
}
