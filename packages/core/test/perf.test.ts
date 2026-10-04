import { expect, test } from "bun:test";
import { Bucket, MemoryStore, MockPool } from "../src/index.ts";
import { __internal } from "../src/bucket.ts";
import { joinVia, newBucket } from "./helpers.ts";

const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega deploy kafka postgres redis cache queue order fulfilment forecast planning".split(" ");
const rnd = (i: number, n: number) => Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 13) % WORDS.length]).join(" ");

test("50k entries via decrypted-cache/index path", async () => {
  const pool = new MockPool();
  const { admin, bucket: A } = await newBucket(pool);
  const t0 = performance.now();
  const recs: [string, unknown][] = [];
  const base = Math.floor(Date.now() / 1000) - 100000;
  for (let i = 0; i < 50_000; i++) {
    const id = i.toString(16).padStart(64, "0");
    const body = { entryId: "p" + i, type: i % 10 ? "fact" : "page", title: `entry ${i} ${rnd(i, 3)}`, body: rnd(i + 1, 40) + ` unique${i}`, tags: [WORDS[i % 7]!], links: [], source: "human" };
    const inner = { id, pubkey: admin.id.pk, kind: 4453, created_at: base + i, tags: [["entry", body.entryId]], content: JSON.stringify(body), sig: "00".repeat(64) };
    recs.push([__internal.versionKey(admin.id.pk, A.bucketId, id), { o: "x" + i, i: inner, e: 0, m: admin.id.pk }]);
  }
  await admin.store.setMany(recs);
  const t1 = performance.now();
  const B = await Bucket.open({ identity: admin.id, bucketId: A.bucketId, pool, store: admin.store, offline: true } as any);
  const t2 = performance.now();
  expect(B.entries().length).toBe(50_000);
  const r = B.search("unique4242");
  expect(r[0]!.entryId).toBe("p4242");
  const multi = B.search("kafka postgres", { limit: 20 });
  expect(multi.length).toBe(20);
  expect(B.search("", { type: "page" }).length).toBe(5000);
  expect(B.tags().length).toBe(7);
  const t3 = performance.now();
  for (let i = 0; i < 100; i++) B.search("unique" + i * 37);
  const t4 = performance.now();
  console.log(`50k: build ${(t1 - t0) | 0}ms, open+index ${(t2 - t1) | 0}ms, queries ${(t3 - t2) | 0}ms, 100 searches ${(t4 - t3) | 0}ms`);
  expect(t4 - t0).toBeLessThan(30_000);
}, 60_000);

test("2k entries through full crypto + member sync", async () => {
  const pool = new MockPool();
  const { bucket: A } = await newBucket(pool);
  const { bucket: B } = await joinVia(pool, A);
  await A.sync(); // admin converts invite join → B's identity gets its own grant
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) await A.write({ type: "fact", title: `f${i} ${rnd(i, 2)}`, body: rnd(i, 30), tags: [WORDS[i % 5]!] });
  const t1 = performance.now();
  const fresh = await Bucket.open({ identity: B.identity, bucketId: B.bucketId, pool, store: new MemoryStore(), relays: A.relays });
  const t2 = performance.now();
  expect(fresh.entries().length).toBe(2000);
  // incremental sync: nothing new → fast
  await fresh.sync();
  const t3 = performance.now();
  console.log(`2k crypto: write ${(t1 - t0) | 0}ms, fresh open+sync ${(t2 - t1) | 0}ms, incremental ${(t3 - t2) | 0}ms`);
  expect(t3 - t0).toBeLessThan(30_000);
}, 60_000);
