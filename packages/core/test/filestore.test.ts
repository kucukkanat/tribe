import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/store/file.ts";
import { Bucket, MockPool } from "../src/index.ts";
import { newBucket, RELAYS } from "./helpers.ts";

test("FileStore persists bucket state across instances", async () => {
  const pool = new MockPool();
  const { admin, bucket } = await newBucket(pool);
  const path = join(mkdtempSync(join(tmpdir(), "tribe-")), "store.json");
  const fs1 = new FileStore(path);
  const b = await Bucket.open({ identity: admin.id, bucketId: bucket.bucketId, pool, store: fs1, relays: RELAYS });
  await b.write({ entryId: "f1", type: "fact", title: "persisted", body: "x" });
  fs1.flush();
  const fs2 = new FileStore(path);
  expect((await Bucket.listMine(fs2)).map((s) => s.bucketId)).toEqual([bucket.bucketId]);
  const b2 = await Bucket.open({ identity: admin.id, bucketId: bucket.bucketId, pool: new MockPool(), store: fs2, offline: true } as any);
  expect(b2.get("f1")!.head.title).toBe("persisted");
});
