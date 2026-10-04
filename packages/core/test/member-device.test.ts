import { test, expect } from "bun:test";
import { Bucket, Identity, MockPool, MemoryStore } from "../src/index.ts";

test("agent paired by a non-admin member can open and write", async () => {
  const pool = new MockPool();
  const admin = Identity.generate(), member = Identity.generate(), dev = Identity.generate();
  const a = await Bucket.create({ identity: admin, name: "t", pool, store: new MemoryStore() });
  const { link } = await a.createInvite({ singleUse: false });
  const m = await Bucket.joinWithInvite({ identity: member, link, pool, store: new MemoryStore() });
  await a.sync();
  await m.sync();
  await m.addDevice(dev.pk, "agent", "agent");
  const d = await Bucket.open({ identity: dev, bucketId: a.bucketId, pool, store: new MemoryStore(), adminHint: admin.pk });
  const v = await d.write({ type: "fact", title: "from agent", body: "x" });
  expect(v.authorMember).toBe(member.pk);
  await a.sync();
  expect(a.get(v.entryId)?.head.title).toBe("from agent");
});

test("agent paired by a member who missed a rotation heals after the member syncs", async () => {
  const pool = new MockPool();
  const admin = Identity.generate(), member = Identity.generate(), dev = Identity.generate();
  const a = await Bucket.create({ identity: admin, name: "t", pool, store: new MemoryStore() });
  const { link } = await a.createInvite({ singleUse: true, expiresInDays: 7 });
  const m = await Bucket.joinWithInvite({ identity: member, link, pool, store: new MemoryStore() });
  await a.sync(); // converts single-use join → rotation
  await m.addDevice(dev.pk, "agent", "agent"); // member hasn't seen the rotation yet
  await m.sync();
  const d = await Bucket.open({ identity: dev, bucketId: a.bucketId, pool, store: new MemoryStore(), adminHint: admin.pk });
  const v = await d.write({ type: "fact", title: "from agent", body: "x" });
  expect(v.authorMember).toBe(member.pk);
  await a.sync();
  expect(a.get(v.entryId)?.head.title).toBe("from agent");
});
