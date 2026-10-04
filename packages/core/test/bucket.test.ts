import { describe, expect, test } from "bun:test";
import { Bucket, Identity, MemoryStore, MockPool, KIND_ENTRY, KIND_INNER, hexToBytes, symEncrypt, blind, locatorKey, bucketTag, randomHex, MAX_BODY_BYTES } from "../src/index.ts";
import { finalizeEvent } from "nostr-tools";
import { RELAYS, joinVia, newBucket } from "./helpers.ts";
import { hkdf32 } from "../src/crypto.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("bucket lifecycle", () => {
  test("create + listMine + reopen from store", async () => {
    const pool = new MockPool();
    const { admin, bucket } = await newBucket(pool, "Alpha");
    expect(bucket.isAdmin()).toBe(true);
    expect(bucket.myRole()).toBe("admin");
    expect(bucket.roster!.members.length).toBe(1);
    expect(bucket.relays).toEqual(RELAYS);
    const list = await Bucket.listMine(admin.store);
    expect(list).toEqual([{ bucketId: bucket.bucketId, name: "Alpha", role: "admin", relays: RELAYS }]);
    await bucket.write({ type: "fact", title: "t", body: "b" });
    const again = await Bucket.open({ identity: admin.id, bucketId: bucket.bucketId, pool, store: admin.store });
    expect(again.entries().length).toBe(1);
    // same identity, fresh store (another browser) can open via self-wrapped grant
    const fresh = await Bucket.open({ identity: admin.id, bucketId: bucket.bucketId, pool, store: new MemoryStore(), relays: RELAYS });
    expect(fresh.isAdmin()).toBe(true);
    expect(fresh.entries().length).toBe(1);
  });

  test("stranger cannot open", async () => {
    const pool = new MockPool();
    const { bucket } = await newBucket(pool);
    await expect(Bucket.open({ identity: Identity.generate(), bucketId: bucket.bucketId, pool, store: new MemoryStore(), relays: RELAYS })).rejects.toThrow();
  });
});

describe("invites", () => {
  test("join with invite: immediate read/write, admin auto-converts", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    await A.write({ type: "fact", title: "Deploy process", body: "use the pipeline", tags: ["ops"] });
    const { user, bucket: J } = await joinVia(pool, A, "Joe");
    expect(J.myRole()).toBe("member");
    expect(J.entries().map((e) => e.head.title)).toEqual(["Deploy process"]);
    const v = await J.write({ type: "fact", title: "From Joe", body: "hi" });
    expect(v.authorMember).toBe(user.id.pk);
    // admin sees joiner's write even before converting (acceptance rule b)
    await A.sync();
    expect(A.get(v.entryId)?.head.title).toBe("From Joe");
    // auto-converted into roster
    const m = A.roster!.members.find((x) => x.pk === user.id.pk)!;
    expect(m.viaInvite).toBeDefined();
    expect(m.name).toBe("Joe");
    expect(A.roster!.invites[0]!.usedBy).toEqual([user.id.pk]);
    await J.sync();
    expect(J.roster!.members.some((x) => x.pk === user.id.pk)).toBe(true);
    expect((await Bucket.listMine(user.store))[0]!.role).toBe("member");
  });

  test("single-use invite cannot be reused", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { link } = await joinVia(pool, A);
    await A.sync();
    await expect(Bucket.joinWithInvite({ identity: Identity.generate(), link, pool, store: new MemoryStore() })).rejects.toThrow();
  });

  test("multi-use invite + pendingRequests autoAccepted", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { link } = await A.createInvite({ singleUse: false, label: "team" });
    const u1 = Identity.generate(), u2 = Identity.generate();
    await Bucket.joinWithInvite({ identity: u1, link, pool, store: new MemoryStore() });
    await Bucket.joinWithInvite({ identity: u2, link, pool, store: new MemoryStore() });
    await A.sync();
    expect(A.roster!.members.length).toBe(3);
  });

  test("revoke invite → token can't join, can't read new data", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { invite, link } = await A.createInvite();
    await A.revokeInvite(invite.id);
    expect(A.epoch).toBe(1);
    expect(A.roster!.invites[0]!.revoked).toBe(true);
    await expect(Bucket.joinWithInvite({ identity: Identity.generate(), link, pool, store: new MemoryStore() })).rejects.toThrow(/revoked/);
  });

  test("request access + approve", async () => {
    const pool = new MockPool();
    const { admin, bucket: A } = await newBucket(pool);
    const u = { id: Identity.generate(), store: new MemoryStore() };
    await Bucket.requestAccess({ identity: u.id, bucketId: A.bucketId, adminPk: admin.id.pk, relays: RELAYS, name: "Req", message: "let me in", pool, store: u.store });
    expect((await Bucket.listMine(u.store))[0]!.role).toBe("pending");
    // cannot open yet
    await expect(Bucket.open({ identity: u.id, bucketId: A.bucketId, pool, store: u.store })).rejects.toThrow();
    await A.sync();
    const p = A.pendingRequests();
    expect(p.length).toBe(1);
    expect(p[0]).toMatchObject({ pk: u.id.pk, name: "Req", message: "let me in", autoAccepted: false });
    await A.approve(u.id.pk);
    expect(A.pendingRequests().length).toBe(0);
    const B = await Bucket.open({ identity: u.id, bucketId: A.bucketId, pool, store: u.store });
    expect(B.myRole()).toBe("member");
    expect((await Bucket.listMine(u.store))[0]!.role).toBe("member");
    await B.write({ type: "fact", title: "x", body: "y" });
    await A.sync();
    expect(A.entries().length).toBe(1);
  });

  test("unapproved requester's writes are not accepted", async () => {
    const pool = new MockPool();
    const { admin, bucket: A } = await newBucket(pool);
    const u = Identity.generate();
    await Bucket.requestAccess({ identity: u, bucketId: A.bucketId, adminPk: admin.id.pk, relays: RELAYS, pool });
    await A.sync();
    expect(A.pendingRequests()[0]!.autoAccepted).toBe(false);
  });
});

describe("entries", () => {
  test("write/edit/versions/conflict/tombstone", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { bucket: B } = await joinVia(pool, A);
    const v1 = await A.write({ entryId: "e1", type: "fact", title: "v1", body: "one" });
    await tick(1);
    const v2 = await A.write({ entryId: "e1", type: "fact", title: "v2", body: "two" });
    expect(v2.prev).toBe(v1.id);
    expect(A.get("e1")!.versions.length).toBe(2);
    expect(A.get("e1")!.head.title).toBe("v2");
    expect(A.get("e1")!.conflict).toBe(false);
    // concurrent edits from same base
    await B.sync();
    const c1 = await A.write({ entryId: "e1", type: "fact", title: "A edit", body: "a", prev: v2.id });
    const c2 = await B.write({ entryId: "e1", type: "fact", title: "B edit", body: "b", prev: v2.id });
    await A.sync(); await B.sync();
    const e = A.get("e1")!;
    expect(e.conflict).toBe(true);
    expect(A.heads("e1").map((h) => h.id).sort()).toEqual([c1.id, c2.id].sort());
    const expectedHead = [c1, c2].sort((x, y) => y.createdAt - x.createdAt || (x.id < y.id ? 1 : -1))[0]!;
    expect(e.head.id).toBe(expectedHead.id);
    expect(B.get("e1")!.head.id).toBe(expectedHead.id);
    // resolve: write without prev merges all heads
    await A.write({ entryId: "e1", type: "fact", title: "merged", body: "ab" });
    await B.sync();
    expect(B.get("e1")!.conflict).toBe(false);
    expect(B.get("e1")!.head.title).toBe("merged");
    // tombstone
    await B.remove("e1");
    await A.sync();
    expect(A.get("e1")!.head.deleted).toBe(true);
    expect(A.entries().find((x) => x.entryId === "e1")).toBeUndefined();
    expect(A.search("merged").length).toBe(0);
  });

  test("body > 60KB throws", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    await expect(A.write({ type: "fact", title: "big", body: "x".repeat(MAX_BODY_BYTES + 1) })).rejects.toThrow();
    const ok = await A.write({ type: "page", title: "near limit", body: "x".repeat(MAX_BODY_BYTES - 1000) });
    expect(ok.body.length).toBe(MAX_BODY_BYTES - 1000);
  });

  test("search, tags, filters, backlinks", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const f1 = await A.write({ type: "fact", title: "Postgres runs on port 5432", body: "primary db", tags: ["db", "infra"] });
    const f2 = await A.write({ type: "fact", title: "Redis cache", body: "used for sessions", tags: ["infra"], source: "agent:claude" });
    const p = await A.write({ type: "page", title: "Architecture", body: "overview of the database layer", links: [f1.entryId, f2.entryId], tags: ["docs"] });
    expect(A.search("postgres").map((e) => e.entryId)).toEqual([f1.entryId]);
    expect(A.search("sess").map((e) => e.entryId)).toEqual([f2.entryId]); // prefix
    expect(A.search("infra").length).toBe(2); // tag field
    expect(A.search("", { type: "page" }).map((e) => e.entryId)).toEqual([p.entryId]);
    expect(A.search("", { tag: "infra" }).length).toBe(2);
    expect(A.search("", { source: "agent" }).map((e) => e.entryId)).toEqual([f2.entryId]);
    expect(A.search("", { source: "human" }).length).toBe(2);
    expect(A.search("", { limit: 1 }).length).toBe(1);
    expect(A.tags()).toEqual([{ tag: "infra", count: 2 }, { tag: "db", count: 1 }, { tag: "docs", count: 1 }]);
    expect(A.backlinks(f1.entryId).map((e) => e.entryId)).toEqual([p.entryId]);
    // edit updates index
    await A.write({ entryId: f1.entryId, type: "fact", title: "MySQL now", body: "migrated", tags: ["db"] });
    expect(A.search("postgres").length).toBe(0);
    expect(A.search("mysql").length).toBe(1);
  });

  test("forged / invalid entries rejected", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { bucket: B } = await joinVia(pool, A);
    // outsider who obtained epoch key (e.g. leaked) but isn't a member: inner signed by non-member
    const key = (A as any).keyFor(A.epoch) as Uint8Array;
    const outsider = Identity.generate();
    const inner = outsider.sign({ kind: KIND_INNER, created_at: Math.floor(Date.now() / 1000), tags: [["entry", "evil"]], content: JSON.stringify({ entryId: "evil", type: "fact", title: "evil", body: "", tags: [], links: [], source: "human" }) });
    const nonce = randomHex(16);
    const outer = finalizeEvent({ kind: KIND_ENTRY, created_at: inner.created_at, tags: [["g", bucketTag(A.bucketId)], ["epoch", String(A.epoch)], ["n", nonce]], content: symEncrypt(key, JSON.stringify(inner)) }, hkdf32(key, "tribe/eph/" + nonce));
    await pool.publish(outer, RELAYS);
    // tampered inner (bad signature)
    const good = A.identity.sign({ kind: KIND_INNER, created_at: inner.created_at, tags: [["entry", "t"]], content: JSON.stringify({ entryId: "t", type: "fact", title: "orig", body: "", tags: [], links: [], source: "human" }) });
    const tampered = { ...good, content: good.content.replace("orig", "hack") };
    const n2 = randomHex(16);
    await pool.publish(finalizeEvent({ kind: KIND_ENTRY, created_at: inner.created_at, tags: [["g", bucketTag(A.bucketId)], ["epoch", String(A.epoch)], ["n", n2]], content: symEncrypt(key, JSON.stringify(tampered)) }, hkdf32(key, "tribe/eph/" + n2)), RELAYS);
    await B.sync();
    expect(B.get("evil")).toBeUndefined();
    expect(B.get("t")).toBeUndefined();
  });
});

describe("revocation", () => {
  test("remove member → rotation; removed can't read new, new writes rejected", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { bucket: B } = await joinVia(pool, A, "Bob");
    const { bucket: C, user: cu } = await joinVia(pool, A, "Carol");
    await A.sync();
    await A.write({ type: "fact", title: "old secret", body: "before removal" });
    await B.sync();
    expect(B.entries().length).toBe(1);
    const bobPk = B.identity.pk;
    await A.removeMember(bobPk);
    expect(A.epoch).toBe(1);
    expect(A.roster!.members.some((m) => m.pk === bobPk)).toBe(false);
    await A.write({ type: "fact", title: "new secret", body: "after removal" });
    // Carol still in, gets new key
    await C.sync();
    expect(C.epoch).toBe(1);
    expect(C.entries().map((e) => e.head.title).sort()).toEqual(["new secret", "old secret"]);
    const cv = await C.write({ type: "fact", title: "carol post-rotation", body: "x" });
    expect(cv.epoch).toBe(1);
    expect(cv.authorMember).toBe(cu.id.pk);
    // Bob cannot read new data
    await B.sync();
    expect(B.epoch).toBe(0);
    expect(B.lockedOut).toBe(true);
    expect(B.myRole()).toBeNull();
    expect(B.entries().map((e) => e.head.title)).toEqual(["old secret"]);
    // Bob tries to write (bypassing local checks) with old epoch key
    (B as any).lockedOut = false;
    (B as any).roster = { ...B.roster!, members: [...B.roster!.members] };
    await B.write({ entryId: "bob-evil", type: "fact", title: "bob after removal", body: "x" }).catch(() => {});
    await A.sync(); await C.sync();
    expect(A.get("bob-evil")).toBeUndefined();
    expect(C.get("bob-evil")).toBeUndefined();
    // fresh device of Bob cannot open with new keys either
    const bobFresh = await Bucket.open({ identity: B.identity, bucketId: A.bucketId, pool, store: new MemoryStore(), relays: RELAYS }).catch((e) => e);
    if (bobFresh instanceof Bucket) {
      expect(bobFresh.lockedOut).toBe(true);
      expect(bobFresh.entries().some((e) => e.head.title === "new secret")).toBe(false);
    }
  });

  test("non-admin roster is ignored", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { bucket: B } = await joinVia(pool, A);
    await A.sync(); await B.sync();
    // Bob signs a roster promoting himself
    const forged = { ...B.roster!, members: B.roster!.members.map((m) => ({ ...m, role: "admin" as const })), updatedAt: B.roster!.updatedAt + 10 };
    const key = (B as any).keyFor(B.epoch);
    const ev = B.identity.sign({ kind: 30450, created_at: Math.floor(Date.now() / 1000) + 10, tags: [["d", blind(locatorKey(B.bucketId), "roster")], ["g", bucketTag(B.bucketId)], ["epoch", String(B.epoch)]], content: symEncrypt(key, JSON.stringify(forged)) });
    await pool.publish(ev, RELAYS);
    await A.sync();
    const fresh = await Bucket.open({ identity: B.identity, bucketId: A.bucketId, pool, store: new MemoryStore(), relays: RELAYS });
    for (const x of [A, fresh]) expect(x.roster!.members.find((m) => m.pk === B.identity.pk)!.role).toBe("member");
    expect(fresh.isAdmin()).toBe(false);
  });

  test("setRole: co-admin gets rootSecret and can manage", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { bucket: B } = await joinVia(pool, A);
    await A.sync();
    await A.setRole(B.identity.pk, "admin");
    await B.sync();
    expect(B.isAdmin()).toBe(true);
    expect((B as any).st.rootSecret).toBe((A as any).st.rootSecret);
    await B.rename("Renamed");
    await A.sync();
    expect(A.name).toBe("Renamed");
  });
});

describe("devices", () => {
  test("agent device opens bucket, writes, authorMember resolves; re-wrap on rotation; revoke", async () => {
    const pool = new MockPool();
    const { admin, bucket: A } = await newBucket(pool);
    const { bucket: B, user: bob } = await joinVia(pool, A, "Bob");
    await A.sync(); await B.sync();
    const agent = Identity.generate();
    await B.addDevice(agent.pk, "claude", "agent");
    expect(B.devices().map((d) => d.pk)).toEqual([agent.pk]);
    const D = await Bucket.open({ identity: agent, bucketId: A.bucketId, pool, store: new MemoryStore(), relays: RELAYS });
    expect(D.memberPk).toBe(bob.id.pk);
    expect(D.myRole()).toBe("member");
    const v = await D.write({ type: "fact", title: "agent fact", body: "x", source: "agent:claude" });
    expect(v.author).toBe(agent.pk);
    expect(v.authorMember).toBe(bob.id.pk);
    await A.sync();
    expect(A.get(v.entryId)!.head.authorMember).toBe(bob.id.pk);
    expect(A.devices(bob.id.pk).length).toBe(1);
    // rotation (remove someone else) → device still has access (admin wraps to devices; member also rewraps)
    const { bucket: C } = await joinVia(pool, A, "Carol");
    await A.sync();
    await A.removeMember(C.identity.pk);
    await B.sync();
    await D.sync();
    expect(D.epoch).toBe(A.epoch);
    const v2 = await D.write({ type: "fact", title: "agent after rotation", body: "y" });
    await A.sync();
    expect(A.get(v2.entryId)).toBeDefined();
    // device added by a member AFTER a rotation the admin did gets keys via member's rewrap
    await A.rotate();
    await B.sync(); // Bob observes new epoch, rewraps
    await D.sync();
    expect(D.epoch).toBe(A.epoch);
    // revoke device: Bob is not admin → mark only; writes after revoke rejected by others
    await B.revokeDevice(agent.pk);
    await tick(1100);
    // D has NOT synced, so it doesn't know it is revoked: its write succeeds locally and is published …
    const v3 = await D.write({ type: "fact", title: "revoked agent", body: "z" });
    expect(D.get(v3.entryId)).toBeDefined();
    expect(pool.dump().some((e) => e.kind === 4450 && e.created_at >= v3.createdAt)).toBe(true);
    // … but every other client rejects it (author device revoked before createdAt)
    await A.sync(); await B.sync();
    expect(A.get(v3.entryId)).toBeUndefined();
    expect(B.get(v3.entryId)).toBeUndefined();
    const fresh = await Bucket.open({ identity: admin.id, bucketId: A.bucketId, pool, store: new MemoryStore(), relays: RELAYS });
    expect(fresh.get(v3.entryId)).toBeUndefined();
    expect(fresh.get(v2.entryId)!.head.authorMember).toBe(bob.id.pk); // pre-revocation writes stay valid
    // once D syncs it sees its own revocation and refuses to write
    await D.sync();
    expect(D.memberPk).toBeNull();
    await expect(D.write({ type: "fact", title: "after sync", body: "z" })).rejects.toThrow();
  });
});

describe("deny, live notifications, relay status", () => {
  test("deny: recorded in roster, hidden on all admin clients, re-request shows again, approve clears", async () => {
    const pool = new MockPool();
    const { admin, bucket: A } = await newBucket(pool);
    const carol = Identity.generate();
    await Bucket.requestAccess({ identity: carol, bucketId: A.bucketId, adminPk: admin.id.pk, relays: RELAYS, name: "Carol", pool });
    await A.sync();
    expect(A.pendingRequests().map((r) => r.pk)).toEqual([carol.pk]);
    await A.deny(carol.pk);
    expect(A.roster!.denied!.map((d) => d.pk)).toEqual([carol.pk]);
    expect(A.pendingRequests()).toEqual([]);
    // co-admin / second session of admin sees it denied too
    const A2 = await Bucket.open({ identity: admin.id, bucketId: A.bucketId, pool, store: new MemoryStore(), relays: RELAYS });
    expect(A2.pendingRequests()).toEqual([]);
    const epoch = A.epoch;
    expect(epoch).toBe(0); // no rotation
    // a newer request appears again
    await tick(1100);
    await Bucket.requestAccess({ identity: carol, bucketId: A.bucketId, adminPk: admin.id.pk, relays: RELAYS, message: "pls", pool });
    await A.sync();
    expect(A.pendingRequests().map((r) => r.pk)).toEqual([carol.pk]);
    await A.approve(carol.pk);
    expect(A.roster!.denied ?? []).toEqual([]);
    await expect(A.deny(carol.pk)).rejects.toThrow(/member/);
  });

  test("deny refuses invite joiners", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { bucket: B } = await joinVia(pool, A);
    await A.sync();
    await expect(A.deny(B.identity.pk)).rejects.toThrow(/member|invite/);
  });

  test("live() fires after local writes and admin actions", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    let n = 0;
    const stop = A.live(() => n++);
    await tick(10);
    n = 0;
    await A.write({ type: "fact", title: "local", body: "" });
    await tick(5);
    expect(n).toBe(1);
    await A.createInvite();
    await tick(5);
    expect(n).toBe(2);
    await A.rename("New name");
    await tick(5);
    expect(n).toBe(3);
    stop();
    await A.write({ type: "fact", title: "after stop", body: "" });
    await tick(5);
    expect(n).toBe(3);
  });

  test("relayStatus reflects pool health", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    expect(A.relayStatus().every((r) => r.ok)).toBe(true);
    pool.down.add(RELAYS[1]!);
    const s = A.relayStatus();
    expect(s.find((r) => r.url === RELAYS[1])!.ok).toBe(false);
    expect(s.find((r) => r.url === RELAYS[0])!.ok).toBe(true);
  });
});

describe("relays, export, snapshot, live", () => {
  test("relay change via roster", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { bucket: B } = await joinVia(pool, A);
    await A.setRelays(["wss://new.test"]);
    expect(A.relays).toEqual(["wss://new.test"]);
    await B.sync(); // roster still on old relays too (published to union)
    expect(B.relays).toEqual(["wss://new.test"]);
    await A.write({ entryId: "n1", type: "fact", title: "on new relay", body: "" });
    expect(pool.dump("wss://a.test").some((e) => e.kind === 4450)).toBe(false);
    await B.sync();
    expect(B.get("n1")).toBeDefined();
  });

  test("export JSON + markdown", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    await A.write({ type: "fact", title: "Hello: World", body: "body text", tags: ["a"] });
    await A.write({ type: "page", title: "Page", body: "p\n" });
    const md = A.exportMarkdown();
    expect(md.length).toBe(2);
    const f = md.find((x) => x.path.startsWith("facts/"))!;
    expect(f.path).toBe("facts/hello-world.md");
    expect(f.content.startsWith("---\n")).toBe(true);
    expect(f.content).toContain('title: "Hello: World"');
    expect(f.content).toContain('tags: ["a"]');
    expect(f.content.endsWith("body text\n")).toBe(true);
    const j = JSON.parse(A.exportJSON());
    expect(j.entries.length).toBe(2);
  });

  test("snapshot: new member loads from snapshot even if originals are gone", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    for (let i = 0; i < 30; i++) await A.write({ entryId: "s" + i, type: "fact", title: "snap " + i, body: "z".repeat(3000) });
    await A.snapshot();
    const snaps = pool.dump(RELAYS[0]).filter((e) => e.kind === 4452);
    expect(snaps.length).toBeGreaterThan(1); // chunked
    const p2 = new MockPool();
    for (const e of pool.dump()) if (e.kind !== 4450) await p2.publish(e, RELAYS);
    const fresh = await Bucket.open({ identity: A.identity, bucketId: A.bucketId, pool: p2, store: new MemoryStore(), relays: RELAYS });
    expect(fresh.entries().length).toBe(30);
    expect(fresh.get("s7")!.head.title).toBe("snap 7");
  });

  test("live subscription + incremental sync", async () => {
    const pool = new MockPool();
    const { bucket: A } = await newBucket(pool);
    const { bucket: B } = await joinVia(pool, A);
    let changes = 0;
    const stop = B.live(() => changes++);
    await tick(10);
    await A.write({ entryId: "live1", type: "fact", title: "live", body: "" });
    await tick(20);
    expect(changes).toBeGreaterThan(0);
    expect(B.get("live1")).toBeDefined();
    stop();
    // reopen B from its store: cached entries present without network
    const B2 = await Bucket.open({ identity: B.identity, bucketId: B.bucketId, pool: new MockPool(), store: B.store, offline: true } as any);
    expect(B2.get("live1")).toBeDefined();
  });
});
