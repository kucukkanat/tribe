#!/usr/bin/env bun
/**
 * Real-relay end-to-end check for Tribe. Uses NostrPool + MemoryStore against public relays.
 *
 *   bun scripts/e2e-real.ts                      # default relays
 *   TRIBE_RELAYS=wss://a,wss://b bun scripts/e2e-real.ts
 *   E2E_SKIP_MCP=1 bun scripts/e2e-real.ts       # skip the MCP stdio part
 *
 * Flow: admin creates bucket → 3 entries → invite → fresh client joins → reads → writes →
 * admin syncs (sees write, auto-converts join) → admin pairs a device → `tribe-mcp status` →
 * `tribe-mcp serve` driven over stdio (memory_write + memory_search) → admin removes member →
 * removed member (fresh client) cannot read a post-removal entry.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bucket, DEFAULT_RELAYS, Identity, MemoryStore, NostrPool, bytesToHex } from "../packages/core/src/index.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "packages/mcp/src/cli.ts");
const RELAYS = process.env.TRIBE_RELAYS ? process.env.TRIBE_RELAYS.split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_RELAYS];
const SKIP_MCP = !!process.env.E2E_SKIP_MCP;

const t0 = performance.now();
const steps: { name: string; ok: boolean; ms: number; info?: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

async function step<T>(name: string, fn: () => Promise<T>, info?: (r: T) => string): Promise<T> {
  const s = performance.now();
  try {
    const r = await fn();
    const ms = performance.now() - s;
    const i = info?.(r);
    steps.push({ name, ok: true, ms, info: i });
    console.log(`  ok   ${name.padEnd(48)} ${fmt(ms).padStart(7)}${i ? "  " + i : ""}`);
    return r;
  } catch (e) {
    const ms = performance.now() - s;
    const msg = e instanceof Error ? e.message : String(e);
    steps.push({ name, ok: false, ms, info: msg });
    console.log(`  FAIL ${name.padEnd(48)} ${fmt(ms).padStart(7)}  ${msg}`);
    throw e;
  }
}

/** Retry `fn` (typically sync + check) with backoff until it returns truthy or ~budget ms elapse. */
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, budget = 20_000): Promise<T> {
  const start = Date.now();
  let delay = 400;
  let last: unknown;
  for (;;) {
    try {
      const r = await fn();
      if (r) return r as T;
    } catch (e) { last = e; }
    if (Date.now() - start > budget) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ""}`);
    await sleep(delay);
    delay = Math.min(delay * 1.6, 4000);
  }
}

function run(cmd: string[], env: Record<string, string>, timeoutMs = 60_000) {
  const p = Bun.spawnSync(cmd, { env: { ...(process.env as Record<string, string>), ...env }, timeout: timeoutMs });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const pools: NostrPool[] = [];
const mkPool = () => { const p = new NostrPool(); pools.push(p); return p; };
const tmp = mkdtempSync(join(tmpdir(), "tribe-e2e-"));

async function main() {
  console.log(`Tribe real-relay e2e — relays: ${RELAYS.join(", ")}`);
  const adminId = Identity.generate();
  const bobId = Identity.generate();
  const deviceId = Identity.generate();
  const adminPool = mkPool();
  const runTag = Math.random().toString(36).slice(2, 8);

  const A = await step("admin creates bucket", () =>
    Bucket.create({ identity: adminId, name: `e2e-${runTag}`, relays: RELAYS, pool: adminPool, store: new MemoryStore() }),
    (b) => `bucket ${b.bucketId}`);

  const written = await step("admin writes 3 entries", async () => {
    const out = [];
    for (let i = 1; i <= 3; i++) out.push(await A.write({ type: "fact", title: `fact ${i} ${runTag}`, body: `Body of fact ${i}: zebra-${runTag}`, tags: ["e2e"] }));
    return out;
  });

  const { link } = await step("admin creates invite", () => A.createInvite({ label: "bob" }));

  const bobPool = mkPool();
  const B = await step("bob joins with link (fresh client)", () =>
    until("bob join", async () => {
      try { return await Bucket.joinWithInvite({ identity: bobId, link, name: "Bob", pool: bobPool, store: new MemoryStore() }); }
      catch (e) { if (/not found|no key grant/i.test((e as Error).message)) return null; throw e; }
    }),
    (b) => `role=${b.myRole()} epoch=${b.epoch}`);

  await step("bob reads the 3 entries", () =>
    until("bob sees 3 entries", async () => { await B.sync(); return written.every((v) => B.get(v.entryId)) && B.entries().length; }),
    (n) => `${n} entries`);

  const bobV = await step("bob writes one entry", () => B.write({ type: "fact", title: `bob fact ${runTag}`, body: "written by bob", tags: ["e2e", "bob"] }));

  await step("admin syncs: sees bob's entry + auto-converts join", () =>
    until("admin sees bob", async () => {
      await A.sync();
      const e = A.get(bobV.entryId);
      const member = A.roster?.members.find((m) => m.pk === bobId.pk);
      return e && member ? `authorMember ok=${e.head.authorMember === bobId.pk}, viaInvite=${member.viaInvite}` : null;
    }), (s) => s);

  await step("admin pairs device key", () => A.addDevice(deviceId.pk, "e2e-agent", "agent"), () => `device ${deviceId.pk.slice(0, 12)}…`);

  const home = join(tmp, "home");
  run(["mkdir", "-p", home], {});
  writeFileSync(join(home, "device.json"), JSON.stringify({ v: 1, sk: bytesToHex(deviceId.sk), pk: deviceId.pk, label: "e2e-agent", createdAt: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
  const relayArg = RELAYS.join(",");
  await step("tribe-mcp status shows paired + 4 entries", () =>
    until("status paired", async () => {
      const r = run(["bun", CLI, "status", "--bucket", A.bucketId, "--relays", relayArg], { TRIBE_HOME: home });
      if (r.code !== 0) throw new Error((r.out + r.err).trim().split("\n").slice(-2).join(" | "));
      const owner = /Owner\s*:\s*.*\[admin\]/.test(r.out);
      const n = Number(/Entries\s*:\s*(\d+)/.exec(r.out)?.[1] ?? -1);
      return owner && n === 4 ? `owner=admin entries=${n}` : (() => { throw new Error(`unexpected status: owner=${owner} entries=${n}`); })();
    }, 30_000), (s) => s);

  if (!SKIP_MCP) {
    await step("tribe-mcp serve: memory_write + memory_search", async () => {
      const { Client } = await import("../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
      const { StdioClientTransport } = await import("../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
      const transport = new StdioClientTransport({
        command: "bun", args: [CLI, "serve", "--bucket", A.bucketId, "--relays", relayArg],
        env: { ...(process.env as Record<string, string>), TRIBE_HOME: home }, stderr: "pipe",
      });
      const client = new Client({ name: "e2e-real", version: "0.0.0" });
      await client.connect(transport);
      try {
        const txt = (r: any) => JSON.parse(r.content[0].text);
        const w = await client.callTool({ name: "memory_write", arguments: { title: `agent note ${runTag}`, body: `quokka-${runTag} via MCP`, tags: ["e2e"] } });
        if ((w as any).isError) throw new Error((w as any).content[0].text);
        const wj = txt(w);
        const s = txt(await client.callTool({ name: "memory_search", arguments: { query: `quokka-${runTag}` } }));
        if (!s.count) throw new Error("search found nothing");
        // admin sees the agent write, attributed to admin
        await until("admin sees agent write", async () => { await A.sync(); const e = A.get(wj.entryId); return e && e.head.authorMember === adminId.pk && e.head.source === "agent:e2e-agent"; });
        return `entry ${wj.entryId}, search hits=${s.count}`;
      } finally { await client.close(); }
    }, (s) => s);
  }

  await step("admin removes bob", () => A.removeMember(bobId.pk), () => `epoch now ${A.epoch}`);
  const secret = await step("admin writes post-removal entry", () => A.write({ type: "fact", title: `secret ${runTag}`, body: "post-removal" }));

  await step("bob (existing client) cannot read post-removal entry", async () => {
    await sleep(1500);
    await B.sync();
    if (B.get(secret.entryId)) throw new Error("removed member read post-removal entry!");
    const w = await B.write({ type: "fact", title: "after removal", body: "x" }).then(() => "accepted-locally", (e) => `rejected: ${(e as Error).message}`);
    return `lockedOut=${B.lockedOut}, write ${w}`;
  }, (s) => s);

  await step("bob (fresh client) cannot read post-removal entry", async () => {
    const fresh = await Bucket.open({ identity: bobId, bucketId: A.bucketId, pool: mkPool(), store: new MemoryStore(), relays: RELAYS, adminHint: adminId.pk }).catch((e) => e as Error);
    if (fresh instanceof Error) return `open refused: ${fresh.message}`;
    if (fresh.get(secret.entryId)) throw new Error("removed member read post-removal entry!");
    if (!fresh.lockedOut) throw new Error("expected lockedOut");
    return `lockedOut=true, sees ${fresh.entries().length} old entries, role=${fresh.myRole()}`;
  }, (s) => s);

  await step("admin fresh client (from relays only) sees everything", async () => {
    const A2 = await Bucket.open({ identity: adminId, bucketId: A.bucketId, pool: mkPool(), store: new MemoryStore(), relays: RELAYS });
    return until("admin2 converge", async () => { await A2.sync(); return A2.get(secret.entryId) && A2.epoch === A.epoch ? `entries=${A2.entries().length} epoch=${A2.epoch}` : null; });
  }, (s) => s);

  console.log("\nRelay status (admin client):");
  for (const r of A.relayStatus()) console.log(`  ${r.url.padEnd(26)} read=${r.read ?? "-"} write=${r.write ?? "-"}${r.lastError ? "  last error: " + r.lastError : ""}`);
}

let failed = false;
try { await main(); } catch { failed = true; }
for (const p of pools) { try { p.close(); } catch {} }
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
const pass = !failed && steps.every((s) => s.ok);
console.log(`\n${pass ? "PASS" : "FAIL"} — ${steps.filter((s) => s.ok).length}/${steps.length} steps in ${fmt(performance.now() - t0)}`);
process.exit(pass ? 0 : 1);
