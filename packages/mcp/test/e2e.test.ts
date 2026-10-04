import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "tribe-mcp-test-"));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function text(r: any): any {
  return JSON.parse(r.content[0].text);
}

describe("cli init", () => {
  test("creates a 0600 device key and prints pairing instructions; does not overwrite", async () => {
    const run = (args: string[]) => {
      const p = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, TRIBE_HOME: home } });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const r1 = run(["init", "--label", "ci bot"]);
    expect(r1.code).toBe(0);
    expect(r1.out).toMatch(/npub1[0-9a-z]+/);
    expect(r1.out).toContain("Devices & Agents");
    expect(r1.out).toContain("label : ci-bot");
    const file = join(home, "device.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const pk1 = JSON.parse(readFileSync(file, "utf8")).pk;
    const r2 = run(["init"]);
    expect(r2.out).toContain("already exists");
    expect(JSON.parse(readFileSync(file, "utf8")).pk).toBe(pk1);
    run(["init", "--force", "--label", "x"]);
    expect(JSON.parse(readFileSync(file, "utf8")).pk).not.toBe(pk1);
  });
});

describe("serve --mock over stdio", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: [CLI, "serve", "--mock", "--label", "e2e"],
      env: { ...(process.env as Record<string, string>), TRIBE_HOME: home },
      stderr: "pipe",
    });
    client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client?.close();
  });

  test("lists tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["memory_get", "memory_link", "memory_list_tags", "memory_recent", "memory_search", "memory_write"].sort(),
    );
    const w = tools.find((t) => t.name === "memory_write")!;
    expect((w.inputSchema as any).required).toEqual(expect.arrayContaining(["title", "body"]));
  });

  test("search seeded data, write, get, link", async () => {
    const s = text(await client.callTool({ name: "memory_search", arguments: { query: "postgres" } }));
    expect(s.count).toBeGreaterThan(0);
    const w = text(
      await client.callTool({ name: "memory_write", arguments: { title: "Redis is used for sessions", body: "Session store is Redis 7.", tags: ["infra"] } }),
    );
    expect(w.created).toBe(true);
    const g = text(await client.callTool({ name: "memory_get", arguments: { entryId: w.entryId } }));
    expect(g.author.source).toBe("agent:e2e");
    const recent = text(await client.callTool({ name: "memory_recent", arguments: {} }));
    expect(recent.results.map((x: any) => x.entryId)).toContain(w.entryId); // 1s timestamp ties
    const pages = text(await client.callTool({ name: "memory_search", arguments: { query: "", type: "page" } }));
    const pageId = pages.results[0].entryId;
    const l = text(await client.callTool({ name: "memory_link", arguments: { pageId, factIds: [w.entryId] } }));
    expect(l.added).toEqual([w.entryId]);
    const tags = text(await client.callTool({ name: "memory_list_tags", arguments: {} }));
    expect(tags.tags.find((t: any) => t.tag === "infra").count).toBeGreaterThanOrEqual(3);
  });

  test("errors come back as isError with actionable text", async () => {
    const r: any = await client.callTool({ name: "memory_get", arguments: { entryId: "does-not-exist" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("memory_search");
  });
});
