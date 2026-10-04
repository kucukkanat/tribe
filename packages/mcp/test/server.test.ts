/**
 * Core-independent test: a minimal in-memory fake of the Bucket surface used by
 * the tools, driven through a real MCP Client/Server pair (InMemoryTransport).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Bucket, Entry, EntryVersion } from "../src/core.ts";
import { buildServer } from "../src/server.ts";

function fakeBucket() {
  const entries = new Map<string, Entry>();
  let n = 0;
  let clock = 1_700_000_000;
  const owner = "aa".repeat(32);
  const b = {
    bucketId: "ff".repeat(16),
    name: "Fake",
    relays: [],
    epoch: 0,
    roster: { v: 1, bucketId: "ff", name: "Fake", epoch: 0, relays: [], members: [{ pk: owner, role: "admin", name: "Ada", addedAt: 0, addedBy: owner }], invites: [], updatedAt: 0 },
    entries: () => [...entries.values()],
    get: (id: string) => entries.get(id),
    devices: () => [],
    search(q: string, o: any = {}) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      return [...entries.values()].filter(
        (e) =>
          (!o.type || e.head.type === o.type) &&
          (!o.tag || e.head.tags.includes(o.tag)) &&
          terms.some((t) => (e.head.title + " " + e.head.body + " " + e.head.tags.join(" ")).toLowerCase().includes(t)),
      ).slice(0, o.limit ?? 10);
    },
    tags() {
      const m = new Map<string, number>();
      for (const e of entries.values()) for (const t of e.head.tags) m.set(t, (m.get(t) ?? 0) + 1);
      return [...m].map(([tag, count]) => ({ tag, count }));
    },
    backlinks: (id: string) => [...entries.values()].filter((e) => e.head.links.includes(id)),
    async write(i: any): Promise<EntryVersion> {
      const entryId = i.entryId ?? `e${++n}`;
      const v: EntryVersion = {
        entryId, type: i.type, title: i.title, body: i.body, tags: i.tags ?? [], links: i.links ?? [], source: i.source ?? "human",
        prev: i.prev, id: (++n).toString(16).padStart(64, "0"), author: "bb".repeat(32), authorMember: owner, createdAt: ++clock, epoch: 0,
      };
      const prev = entries.get(entryId);
      entries.set(entryId, { entryId, head: v, versions: [...(prev?.versions ?? []), v], conflict: false });
      return v;
    },
  };
  return b as unknown as Bucket;
}

const json = (r: any) => JSON.parse(r.content[0].text);

describe("MCP server (fake bucket)", () => {
  let client: Client;
  beforeAll(async () => {
    const server = buildServer({ ctx: { bucket: fakeBucket(), label: "unit" } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "t", version: "0" });
    await client.connect(b);
  });

  test("advertises six tools with annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    expect(tools.find((t) => t.name === "memory_search")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "memory_write")!.annotations?.readOnlyHint).toBe(false);
  });

  test("write → search → update → get → link → recent → tags", async () => {
    const f = json(await client.callTool({ name: "memory_write", arguments: { title: "Kafka topic naming", body: "Use team.domain.event", tags: ["Kafka"] } }));
    expect(f).toMatchObject({ created: true, type: "fact" });
    const s = json(await client.callTool({ name: "memory_search", arguments: { query: "kafka" } }));
    expect(s.results[0]).toMatchObject({ entryId: f.entryId, tags: ["kafka"], author: { name: "Ada", source: "agent:unit" } });
    const u = json(await client.callTool({ name: "memory_write", arguments: { entryId: f.entryId, title: "Kafka topic naming", body: "Use team.domain.event.v1" } }));
    expect(u.created).toBe(false);
    const g = json(await client.callTool({ name: "memory_get", arguments: { entryId: f.entryId } }));
    expect(g).toMatchObject({ versionCount: 2, tags: ["kafka"], body: "Use team.domain.event.v1" });
    const p = json(await client.callTool({ name: "memory_write", arguments: { type: "page", title: "Messaging", body: "Index" } }));
    const l = json(await client.callTool({ name: "memory_link", arguments: { pageId: p.entryId, factIds: [f.entryId] } }));
    expect(l.added).toEqual([f.entryId]);
    const g2 = json(await client.callTool({ name: "memory_get", arguments: { entryId: f.entryId } }));
    expect(g2.backlinks[0].entryId).toBe(p.entryId);
    const r = json(await client.callTool({ name: "memory_recent", arguments: { limit: 1 } }));
    expect(r.results[0].entryId).toBe(p.entryId);
    const t = json(await client.callTool({ name: "memory_list_tags", arguments: {} }));
    expect(t.tags).toEqual([{ tag: "kafka", count: 1 }]);
  });

  test("schema violations and tool errors are reported, not thrown", async () => {
    const bad: any = await client.callTool({ name: "memory_write", arguments: { title: "", body: "x" } });
    expect(bad.isError).toBe(true);
    const missing: any = await client.callTool({ name: "memory_link", arguments: { pageId: "nope", factIds: ["x"] } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("memory_search");
  });
});
