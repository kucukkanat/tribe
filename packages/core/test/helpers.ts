import { Bucket, Identity, MemoryStore, MockPool } from "../src/index.ts";

export const RELAYS = ["wss://a.test", "wss://b.test"];

export function setup() {
  const pool = new MockPool();
  const mk = () => ({ id: Identity.generate(), store: new MemoryStore() });
  return { pool, mk };
}

export async function newBucket(pool: MockPool, name = "Team") {
  const admin = { id: Identity.generate(), store: new MemoryStore() };
  const bucket = await Bucket.create({ identity: admin.id, name, relays: RELAYS, pool, store: admin.store });
  return { admin, bucket };
}

export async function joinVia(pool: MockPool, admin: Bucket, name = "joiner", opts?: { singleUse?: boolean }) {
  const u = { id: Identity.generate(), store: new MemoryStore() };
  const { link } = await admin.createInvite({ singleUse: opts?.singleUse });
  const b = await Bucket.joinWithInvite({ identity: u.id, link, name, pool, store: u.store });
  return { user: u, bucket: b, link };
}
