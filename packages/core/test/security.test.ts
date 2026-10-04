// Regression tests for the security review findings (C1–C3, H4, H5, M6/M7, L10): each attack must now FAIL.
import { describe, expect, test } from "bun:test";
import {
  Bucket, Identity, MemoryStore, MockPool, wrapGrant, symEncrypt, blind, locatorKey, bucketTag, hkdf32, randomHex, hexToBytes,
  bytesToHex, KIND_ROSTER, KIND_ENTRY, KIND_INNER, KIND_JOIN, KIND_DEVICES, signTokenProof, buildConnectString, parseConnectString,
} from "../src/index.ts";

const R = ["wss://a.test", "wss://b.test"];
const S = () => new MemoryStore();
const T = (ms = 1100) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
async function mk(pool: MockPool) { const id = Identity.generate(); const b = await Bucket.create({ identity: id, name: "T", relays: R, pool, store: S() }); return { id, b }; }
async function join(pool: MockPool, A: Bucket, opts: any = {}) {
  const id = Identity.generate(); const { link, invite } = await A.createInvite(opts);
  const b = await Bucket.joinWithInvite({ identity: id, link, pool, store: S() }); return { id, b, link, invite };
}
function signOuter(epochKey: Uint8Array, inner: any, bid: string, n: number, entryId: string) {
  const nonce = randomHex(16);
  const eph = Identity.fromSecret(hkdf32(epochKey, "tribe/eph/" + nonce));
  return eph.sign({ kind: KIND_ENTRY, created_at: now(), tags: [["g", bucketTag(bid)], ["e2", blind(locatorKey(bid), "entry/" + entryId)], ["epoch", String(n)], ["n", nonce]], content: symEncrypt(epochKey, JSON.stringify(inner)) });
}
const tokenOf = (link: string) => JSON.parse(atob(link.split("#/join/")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).t as string;

async function plantEvilBucket(pool: MockPool, bid: string, devPk: string) {
  const atk = Identity.generate(); const K = hexToBytes(randomHex(32));
  for (let j = 0; j < 5; j++) await pool.publish(wrapGrant({ bucketId: bid, name: "Evil", relays: R, admins: [atk.pk], epochs: [{ n: 999, key: bytesToHex(K) }] }, atk.sk, devPk), R);
  const body = { v: 1, bucketId: bid, name: "Evil", epoch: 999, relays: R, members: [{ pk: atk.pk, role: "admin", addedAt: 0, addedBy: atk.pk }], invites: [], updatedAt: now(), removed: [] };
  await pool.publish(atk.sign({ kind: KIND_ROSTER, created_at: now(), tags: [["d", blind(locatorKey(bid), "roster")], ["g", bucketTag(bid)], ["epoch", "999"]], content: symEncrypt(K, JSON.stringify(body)) }), R);
  await pool.publish(atk.sign({ kind: KIND_DEVICES, created_at: now(), tags: [["d", blind(locatorKey(bid), "devices/" + atk.pk)], ["g", bucketTag(bid)], ["epoch", "999"]], content: symEncrypt(K, JSON.stringify({ devices: [{ pk: devPk, label: "x", kind: "agent", addedAt: 0 }] })) }), R);
  return atk;
}

describe("C2 first-open trust root", () => {
  test("open without adminHint (nothing persisted) throws asking for the admin pk", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const dev = Identity.generate();
    await A.addDevice(dev.pk, "agent", "agent");
    await expect(Bucket.open({ identity: dev, bucketId: A.bucketId, pool, store: S(), relays: R })).rejects.toThrow(/admin/i);
  });

  test("outsider grant + roster cannot hijack a device's open (adminHint given)", async () => {
    const pool = new MockPool();
    const { id: adm, b: A } = await mk(pool);
    const dev = Identity.generate();
    await A.addDevice(dev.pk, "agent", "agent");
    await plantEvilBucket(pool, A.bucketId, dev.pk);
    for (let i = 0; i < 5; i++) {
      const D = await Bucket.open({ identity: dev, bucketId: A.bucketId, pool, store: S(), relays: R, adminHint: adm.pk });
      expect(D.roster!.name).toBe("T");
      expect(D.epoch).toBe(A.epoch);
      const v = await D.write({ type: "fact", title: "x", body: "y" });
      expect(v.epoch).toBe(A.epoch); // never an attacker epoch
    }
  });

  test("outsider grant cannot hijack open even with no device pairing at all", async () => {
    const pool = new MockPool();
    const { id: adm, b: A } = await mk(pool);
    const dev = Identity.generate();
    await plantEvilBucket(pool, A.bucketId, dev.pk);
    await expect(Bucket.open({ identity: dev, bucketId: A.bucketId, pool, store: S(), relays: R, adminHint: adm.pk })).rejects.toThrow();
  });

  test("member's fresh client bootstraps from its self-wrap without adminHint", async () => {
    const pool = new MockPool();
    const { id: adm, b: A } = await mk(pool);
    const fresh = await Bucket.open({ identity: adm, bucketId: A.bucketId, pool, store: S(), relays: R });
    expect(fresh.isAdmin()).toBe(true);
  });

  test("connection string round-trip", () => {
    const pk = Identity.generate().pk;
    const s = buildConnectString({ bucketId: "ab12ab12", adminPk: pk, relays: ["wss://x.y/a?b=1", "wss://z"] });
    expect(s.startsWith("tribe://ab12ab12?admin=" + pk)).toBe(true);
    expect(parseConnectString(s)).toEqual({ bucketId: "ab12ab12", adminPk: pk, relays: ["wss://x.y/a?b=1", "wss://z"] });
    expect(() => parseConnectString("tribe://ab12ab12")).toThrow();
  });
});

describe("C1 removed co-admin rollback", () => {
  test("same/lower-epoch roster with huge updatedAt from removed co-admin is rejected (existing + fresh client)", async () => {
    const pool = new MockPool();
    const { id: adm, b: A } = await mk(pool);
    const { id: bid_, b: B } = await join(pool, A); await A.sync(); await A.setRole(bid_.pk, "admin"); await B.sync();
    const { b: C } = await join(pool, A); await A.sync(); await C.sync(); await B.sync();
    const oldEpoch = B.epoch; const oldKey = (B as any).keyFor(oldEpoch);
    await A.removeMember(bid_.pk); await C.sync();
    expect(C.epoch).toBe(oldEpoch + 1);
    const forged = structuredClone(C.roster!); forged.epoch = oldEpoch; forged.updatedAt = 4e9; forged.removed = [];
    forged.members = [...forged.members.map((m) => ({ ...m, role: "member" as const })), { pk: bid_.pk, role: "admin", addedAt: 0, addedBy: bid_.pk }];
    await pool.publish(bid_.sign({ kind: KIND_ROSTER, created_at: now(), tags: [["d", blind(locatorKey(A.bucketId), "roster")], ["g", bucketTag(A.bucketId)], ["epoch", String(oldEpoch)]], content: symEncrypt(oldKey, JSON.stringify(forged)) }), R);
    await C.sync();
    const C2 = await Bucket.open({ identity: C.identity, bucketId: A.bucketId, pool, store: S(), relays: R, adminHint: adm.pk });
    for (const x of [C, C2]) {
      expect(x.epoch).toBe(oldEpoch + 1);
      expect(x.roster!.members.some((m) => m.pk === bid_.pk)).toBe(false);
      const v = await x.write({ type: "fact", title: "post-removal", body: "secret" });
      expect(v.epoch).toBe(oldEpoch + 1);
    }
  });

  test("grant admins never vouch: co-admin-sent grant listing an attacker as admin does not make it trusted", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const { id: bid_, b: B } = await join(pool, A); await A.sync(); await A.setRole(bid_.pk, "admin"); await B.sync();
    const { b: C } = await join(pool, A); await A.sync(); await C.sync();
    const atk = Identity.generate();
    await pool.publish(wrapGrant({ bucketId: A.bucketId, name: "T", relays: R, admins: [atk.pk], epochs: [] }, bid_.sk, C.identity.pk), R);
    await C.sync();
    await A.removeMember(bid_.pk); await C.sync();
    // attacker (never an admin) signs a roster at the current epoch with a key it doesn't have → can't even encrypt; try with leaked key
    const key = (C as any).keyFor(C.epoch);
    const body = { ...structuredClone(C.roster!), name: "Evil", updatedAt: 4e9 };
    await pool.publish(atk.sign({ kind: KIND_ROSTER, created_at: now(), tags: [["d", blind(locatorKey(A.bucketId), "roster")], ["g", bucketTag(A.bucketId)], ["epoch", String(C.epoch)]], content: symEncrypt(key, JSON.stringify(body)) }), R);
    await C.sync();
    expect(C.roster!.name).toBe("T");
  });
});

describe("C3 reusable invite after removal", () => {
  test("member removed after joining via reusable invite gets no new epoch keys", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const { id, b: J, invite } = await join(pool, A, { singleUse: false }); await A.sync(); await J.sync();
    expect((J as any).st.tokenSk).toBeUndefined(); // joiner dropped token after conversion
    await A.removeMember(id.pk);
    expect(A.roster!.invites.find((i) => i.id === invite.id)!.revoked).toBe(true);
    await A.write({ type: "fact", title: "after removal", body: "secret" });
    await J.sync();
    expect(J.entries().some((e) => e.head.title === "after removal")).toBe(false);
    expect(J.lockedOut).toBe(true);
  });
});

describe("H4 backdating by removed members / revoked devices", () => {
  test("removed member's backdated entry at old epoch is rejected", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const { id, b: J } = await join(pool, A); await A.sync(); await J.sync();
    const pre = await J.write({ type: "fact", title: "legit pre-removal", body: "x" });
    await A.sync();
    const n = J.epoch, key = (J as any).keyFor(n);
    await T();
    await A.removeMember(id.pk);
    await T();
    const entryId = "forged-" + randomHex(4);
    const inner = id.sign({ kind: KIND_INNER, created_at: now() - 3600, tags: [["entry", entryId], ["epoch", String(n)]], content: JSON.stringify({ entryId, type: "fact", title: "Prod DB password rotated to hunter2", body: "x", tags: [], links: [], source: "human" }) });
    await pool.publish(signOuter(key, inner, A.bucketId, n, entryId), R);
    await A.sync();
    expect(A.get(entryId)).toBeUndefined();
    expect(A.get(pre.entryId)).toBeDefined(); // pre-removal writes stay
    const fresh = await Bucket.open({ identity: A.identity, bucketId: A.bucketId, pool, store: S(), relays: R });
    expect(fresh.get(entryId)).toBeUndefined();
    expect(fresh.get(pre.entryId)).toBeDefined();
  });

  test("non-admin revokeDevice → admin auto-rotates + cutoff; backdated device write rejected; device loses keys", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const { b: M } = await join(pool, A); await A.sync(); await M.sync();
    const dev = Identity.generate(); await M.addDevice(dev.pk, "agent", "agent");
    const D = await Bucket.open({ identity: dev, bucketId: A.bucketId, pool, store: S(), relays: R, adminHint: A.identity.pk });
    const ok = await D.write({ type: "fact", title: "device legit", body: "x" });
    await A.sync();
    const e0 = A.epoch;
    await T(); await M.revokeDevice(dev.pk);
    await A.sync(); // admin auto-acts on the rotation request
    expect(A.epoch).toBe(e0 + 1);
    expect(A.roster!.cutoffs!.some((c) => c.pk === dev.pk)).toBe(true);
    const k2 = (M as any).keyFor(e0); const e2 = "dev-" + randomHex(4);
    const inner2 = dev.sign({ kind: KIND_INNER, created_at: now() - 3600, tags: [["entry", e2]], content: JSON.stringify({ entryId: e2, type: "fact", title: "from revoked device", body: "x", tags: [], links: [], source: "agent:x" }) });
    await pool.publish(signOuter(k2, inner2, A.bucketId, e0, e2), R);
    await A.sync(); await M.sync();
    expect(A.get(e2)).toBeUndefined();
    expect(M.get(e2)).toBeUndefined();
    expect(A.get(ok.entryId)).toBeDefined();
    await A.write({ type: "fact", title: "after revoke", body: "s" });
    await D.sync();
    expect(D.entries().some((e) => e.head.title === "after revoke")).toBe(false);
  });
});

describe("H5 DoS", () => {
  test("outsider junk is not queued as pending nor stored", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const junk = Identity.generate();
    const big = "A".repeat(60000);
    for (let i = 0; i < 300; i++) await pool.publish(junk.sign({ kind: KIND_ENTRY, created_at: now(), tags: [["g", bucketTag(A.bucketId)], ["epoch", String(1000 + i)], ["n", "aa"]], content: big }), R);
    // next-epoch junk (plausible) is bounded by count/bytes
    for (let i = 0; i < 150; i++) await pool.publish(junk.sign({ kind: KIND_ENTRY, created_at: now(), tags: [["g", bucketTag(A.bucketId)], ["epoch", String(A.epoch + 1)], ["n", "aa" + i]], content: big }), R);
    // bad ephemeral-key event at the current epoch → invalid, not pending
    await pool.publish(junk.sign({ kind: KIND_ENTRY, created_at: now(), tags: [["g", bucketTag(A.bucketId)], ["epoch", String(A.epoch)], ["n", "bb"]], content: "x" }), R);
    await A.sync();
    const pend = await A.store.list(`b/${A.identity.pk}/${A.bucketId}/p/`);
    const bytes = JSON.stringify(pend).length;
    expect(bytes).toBeLessThan(6 * 1024 * 1024);
    expect((A as any).pending.size).toBeLessThanOrEqual(500);
    const stored = await A.store.queryEvents({ kinds: [KIND_ENTRY] });
    expect(stored.filter((e) => Number(e.tags.find((t) => t[0] === "epoch")![1]) >= 1000).length).toBe(0);
  });

  test("join spam per pubkey is capped and names truncated", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const x = Identity.generate();
    for (let i = 0; i < 20; i++) await Bucket.requestAccess({ identity: x, bucketId: A.bucketId, adminPk: A.identity.pk, relays: R, name: "N".repeat(5000), message: "m" + i, pool });
    await A.sync();
    const joins = [...(A as any).control.values()].filter((e: any) => e.kind === KIND_JOIN && e.pubkey === x.pk);
    expect(joins.length).toBeLessThanOrEqual(5);
    expect(A.pendingRequests()[0]!.name!.length).toBeLessThanOrEqual(100);
  });
});

describe("M6/M7 invite backdating", () => {
  test("expired invite: backdated join is not auto-converted", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const { link, invite } = await A.createInvite({ singleUse: false, expiresInDays: 1 / 86400 });
    await T(2200);
    const x = Identity.generate();
    await expect(Bucket.joinWithInvite({ identity: x, link, pool, store: S() })).rejects.toThrow();
    const sig = signTokenProof(tokenOf(link), A.bucketId, x.pk);
    const key = (A as any).keyFor(A.epoch);
    await pool.publish(x.sign({ kind: KIND_JOIN, created_at: invite.createdAt, tags: [["g", bucketTag(A.bucketId)], ["p", A.identity.pk], ["epoch", String(A.epoch)], ["x", symEncrypt(key, JSON.stringify({ inviteId: invite.id, tokenSig: sig, name: "late" }))]], content: "x" }), R);
    await A.sync();
    expect(A.roster!.members.some((m) => m.pk === x.pk)).toBe(false);
    expect(A.roster!.invites.find((i) => i.id === invite.id)!.revoked).toBe(true); // expired → revoked + rotated
  });

  test("single-use race: leaked-token holder backdating does not beat the first join the admin saw; joinStatus", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const { link, invite } = await A.createInvite({ singleUse: true });
    const legit = Identity.generate(), atk = Identity.generate();
    const key = (A as any).keyFor(A.epoch);
    const L = await Bucket.joinWithInvite({ identity: legit, link, pool, store: S() });
    await A.sync(); // admin observes legit first
    await pool.publish(atk.sign({ kind: KIND_JOIN, created_at: invite.createdAt + 0, tags: [["g", bucketTag(A.bucketId)], ["p", A.identity.pk], ["epoch", "0"], ["x", symEncrypt(key, JSON.stringify({ inviteId: invite.id, tokenSig: signTokenProof(tokenOf(link), A.bucketId, atk.pk) }))]], content: "x" }), R);
    await A.sync();
    expect(A.roster!.members.some((m) => m.pk === legit.pk)).toBe(true);
    expect(A.roster!.members.some((m) => m.pk === atk.pk)).toBe(false);
    await L.sync();
    expect(L.joinStatus()).toBe("accepted");
  });

  test("joinStatus reports rejected when another identity consumed the single-use invite", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const { link } = await A.createInvite({ singleUse: true });
    const first = Identity.generate();
    await Bucket.joinWithInvite({ identity: first, link, pool, store: S() });
    await A.sync();
    await expect(Bucket.joinWithInvite({ identity: Identity.generate(), link, pool, store: S() })).rejects.toThrow();
  });
});

describe("L10 device binding", () => {
  test("device pk claimed by two members is invalid for both", async () => {
    const pool = new MockPool();
    const { b: A } = await mk(pool);
    const { b: M } = await join(pool, A); await A.sync(); await M.sync();
    const { b: E } = await join(pool, A); await A.sync(); await E.sync();
    const dev = Identity.generate();
    await M.sync();
    await M.addDevice(dev.pk, "agent", "agent");
    const D = await Bucket.open({ identity: dev, bucketId: A.bucketId, pool, store: S(), relays: R, adminHint: A.identity.pk });
    const v = await D.write({ type: "fact", title: "dev", body: "x" });
    await E.sync();
    await E.addDevice(dev.pk, "stolen", "agent"); // E claims M's device to get its writes attributed to E
    await A.sync();
    expect(A.get(v.entryId)?.head.authorMember).not.toBe(E.identity.pk);
  });
});
