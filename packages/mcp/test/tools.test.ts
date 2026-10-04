import { beforeAll, describe, expect, test } from "bun:test";
import { Bucket, Identity, MemoryStore, MockPool, findOwner } from "../src/core.ts";
import {
  LIMITS,
  ToolError,
  memoryGet,
  memoryLink,
  memoryListTags,
  memoryRecent,
  memorySearch,
  memoryWrite,
  snippet,
  type ToolContext,
} from "../src/tools.ts";

let admin: Identity;
let device: Identity;
let adminBucket: Bucket;
let bucket: Bucket;
let ctx: ToolContext;

beforeAll(async () => {
  const pool = new MockPool();
  admin = Identity.generate();
  device = Identity.generate();
  adminBucket = await Bucket.create({ identity: admin, name: "Team", pool, store: new MemoryStore() });
  await adminBucket.addDevice(device.pk, "test-agent", "agent");
  bucket = await Bucket.open({ identity: device, bucketId: adminBucket.bucketId, pool, store: new MemoryStore(), adminHint: admin.pk });
  await bucket.sync();
  ctx = { bucket, label: "test-agent" };
});

describe("device pairing", () => {
  test("device opens bucket and resolves owner to admin", () => {
    expect(bucket.roster).not.toBeNull();
    expect(bucket.name).toBe("Team");
    expect(findOwner(bucket, device.pk)?.pk).toBe(admin.pk);
  });

  test("unpaired device cannot read the bucket", async () => {
    const pool = new MockPool();
    const a = Identity.generate();
    const b = await Bucket.create({ identity: a, name: "Other", pool, store: new MemoryStore() });
    const stranger = Identity.generate();
    let failed = false;
    try {
      const sb = await Bucket.open({ identity: stranger, bucketId: b.bucketId, pool, store: new MemoryStore(), adminHint: a.pk });
      await sb.sync();
      failed = sb.roster === null;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

describe("memory tools", () => {
  let factId = "";
  let pageId = "";

  test("memory_write creates a fact with agent source and owner as authorMember", async () => {
    const r = await memoryWrite(ctx, {
      title: "Deploys happen via GitHub Actions",
      body: "Production deploys run from the `deploy.yml` workflow on tags matching v*.",
      tags: ["CI", "#deploy", "ci"],
    });
    expect(r.created).toBe(true);
    expect(r.type).toBe("fact");
    factId = r.entryId;
    const e = bucket.get(factId)!;
    expect(e.head.source).toBe("agent:test-agent");
    expect(e.head.author).toBe(device.pk);
    expect(e.head.authorMember).toBe(admin.pk);
    expect(e.head.tags).toEqual(["ci", "deploy"]);
  });

  test("memory_search finds it with snippet and author", () => {
    const r = memorySearch(ctx, { query: "deploy workflow" });
    expect(r.count).toBeGreaterThan(0);
    const hit = r.results.find((x) => x.entryId === factId)!;
    expect(hit).toBeDefined();
    expect(hit.author.pk).toBe(admin.pk);
    expect(hit.author.source).toBe("agent:test-agent");
    expect(hit.snippet.length).toBeGreaterThan(0);
  });

  test("memory_search filters by type and tag", () => {
    expect(memorySearch(ctx, { query: "deploy", type: "page" }).results.find((x) => x.entryId === factId)).toBeUndefined();
    expect(memorySearch(ctx, { query: "", tag: "deploy" }).results.map((x) => x.entryId)).toContain(factId);
    expect(memorySearch(ctx, { query: "zzzznomatch" }).hint).toBeDefined();
  });

  test("memory_write update keeps tags, sets prev, bumps versions", async () => {
    const before = bucket.get(factId)!;
    const r = await memoryWrite(ctx, { entryId: factId, title: "Deploys happen via GitHub Actions", body: "Updated: deploys on tags v* and on manual dispatch." });
    expect(r.created).toBe(false);
    const e = bucket.get(factId)!;
    expect(e.versions.length).toBe(2);
    expect(e.head.prev).toBe(before.head.id);
    expect(e.head.tags).toEqual(["ci", "deploy"]);
    expect(e.conflict).toBe(false);
  });

  test("memory_write creates a page linking the fact; memory_get shows links/backlinks", async () => {
    const p = await memoryWrite(ctx, { type: "page", title: "Release process", body: "How we ship.", tags: ["deploy"], links: [factId] });
    pageId = p.entryId;
    const g = memoryGet(ctx, { entryId: pageId }) as any;
    expect(g.type).toBe("page");
    expect(g.links).toEqual([{ entryId: factId, type: "fact", title: "Deploys happen via GitHub Actions" }]);
    const f = memoryGet(ctx, { entryId: factId }) as any;
    expect(f.versionCount).toBe(2);
    expect(f.backlinks.map((b: any) => b.entryId)).toContain(pageId);
    expect(f.author.pk).toBe(admin.pk);
  });

  test("memory_link appends links and is idempotent", async () => {
    const f2 = await memoryWrite(ctx, { title: "Rollback with git revert", body: "Revert the tag commit and re-tag.", tags: ["deploy"] });
    const r = await memoryLink(ctx, { pageId, factIds: [factId, f2.entryId, f2.entryId] });
    expect(r.added).toEqual([f2.entryId]);
    expect(bucket.get(pageId)!.head.links).toEqual([factId, f2.entryId]);
    expect(bucket.get(pageId)!.versions.length).toBe(2);
    const again = await memoryLink(ctx, { pageId, factIds: [factId] });
    expect(again.added).toEqual([]);
    expect(bucket.get(pageId)!.versions.length).toBe(2);
  });

  test("memory_link rejects non-page and unknown ids", async () => {
    await expect(memoryLink(ctx, { pageId: factId, factIds: [pageId] })).rejects.toThrow(/not a page/);
    await expect(memoryLink(ctx, { pageId, factIds: ["nope-123"] })).rejects.toThrow(/Unknown entry/);
  });

  test("memory_list_tags and memory_recent", () => {
    const t = memoryListTags(ctx);
    expect(t.tags.find((x) => x.tag === "deploy")!.count).toBeGreaterThanOrEqual(3);
    const r = memoryRecent(ctx, { limit: 2 });
    expect(r.count).toBe(2);
    // createdAt has 1s resolution, so writes in the same second may tie: only check ordering.
    expect(r.results[0]!.updatedAt >= r.results[1]!.updatedAt).toBe(true);
    expect(memoryRecent(ctx, {}).results.map((x) => x.entryId)).toContain(pageId);
  });

  test("admin sees the agent's writes after sync", async () => {
    await adminBucket.sync();
    const e = adminBucket.get(factId)!;
    expect(e).toBeDefined();
    expect(e.head.authorMember).toBe(admin.pk);
    expect(e.head.source).toBe("agent:test-agent");
  });

  test("validation errors are actionable", async () => {
    await expect(memoryWrite(ctx, { title: "big", body: "x".repeat(LIMITS.bodyMaxBytes + 1) })).rejects.toThrow(/Split it/);
    await expect(memoryWrite(ctx, { title: "   ", body: "b" })).rejects.toThrow(ToolError);
    await expect(memoryWrite(ctx, { entryId: "missing", title: "t", body: "b" })).rejects.toThrow(/memory_search/);
    await expect(memoryWrite(ctx, { title: "t", body: "b", links: ["ghost"] })).rejects.toThrow(/Unknown link/);
    expect(() => memoryGet(ctx, { entryId: "missing" })).toThrow(ToolError);
  });
});

describe("snippet", () => {
  test("centers on the first matching term", () => {
    const body = "a ".repeat(300) + "needle here " + "b ".repeat(300);
    const s = snippet(body, "needle");
    expect(s).toContain("needle");
    expect(s.startsWith("…")).toBe(true);
  });
});
