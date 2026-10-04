#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createDevice, devicePath, loadDevice, sanitizeLabel } from "./device.ts";
import { log } from "./log.ts";
import { NotPairedError, openMock, openReal, type Opened } from "./open.ts";
import { findOwner, Identity, memberName } from "./core.ts";
import { SERVER_VERSION, startServer } from "./server.ts";

const USAGE = `tribe-mcp ${SERVER_VERSION} — Tribe encrypted team memory for AI agents (MCP over stdio)

Usage:
  tribe-mcp init [--label <name>] [--force]     Create this machine's device key (~/.tribe/device.json)
  tribe-mcp status --bucket <id> [--relays a,b]  Check pairing and show bucket info
  tribe-mcp serve  --bucket <id> [--relays a,b]  Run the MCP server on stdio

Options:
  --bucket <id>     Bucket id (hex) — shown in the Tribe web app under Settings
  --relays <list>   Comma-separated relay URLs (default: bucket's roster relays)
  --label <name>    Device label; entries are tagged with source "agent:<label>"
  --force           Overwrite an existing device key (init)
  TRIBE_HOME        Env var overriding the ~/.tribe directory
`;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      bucket: { type: "string", short: "b" },
      relays: { type: "string", short: "r" },
      label: { type: "string", short: "l" },
      force: { type: "boolean" },
      mock: { type: "boolean" }, // hidden: in-process MockPool + MemoryStore, self-seeded
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

function out(s = ""): void {
  process.stdout.write(s + "\n");
}

function relaysOf(v?: string): string[] | undefined {
  if (!v) return undefined;
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const r of list) if (!/^wss?:\/\//.test(r)) throw new Error(`Invalid relay URL "${r}" (must start with wss:// or ws://)`);
  return list.length ? list : undefined;
}

function requireBucket(v?: string): string {
  if (!v) throw new Error("Missing --bucket <id>. Find the bucket id in the Tribe web app (Settings).");
  if (!/^[0-9a-fA-F]{8,128}$/.test(v)) throw new Error(`Invalid --bucket "${v}": expected a hex bucket id.`);
  return v.toLowerCase();
}

async function cmdInit(values: ReturnType<typeof parse>["values"]) {
  const { device, identity, created } = createDevice({ label: values.label, force: values.force });
  if (!created) {
    out(`Device key already exists at ${devicePath()} (use --force to replace it — this unpairs the agent).`);
  } else {
    out(`Created device key at ${devicePath()} (mode 0600).`);
  }
  out("");
  out(`  label : ${device.label}`);
  out(`  npub  : ${identity.npub()}`);
  out(`  hex pk: ${identity.pk}`);
  out("");
  out("Pair this agent with your bucket:");
  out("  1. Open the Tribe web app and select your bucket.");
  out("  2. Go to Devices & Agents → Pair an agent.");
  out(`  3. Paste this npub: ${identity.npub()}`);
  out(`  4. Then run: tribe-mcp status --bucket <bucketId>`);
}

async function openFor(values: ReturnType<typeof parse>["values"]): Promise<Opened & { label: string }> {
  if (values.mock) {
    const label = sanitizeLabel(values.label ?? "mock-agent");
    let identity: Identity;
    try {
      identity = loadDevice().identity;
    } catch {
      identity = Identity.generate();
    }
    return { ...(await openMock({ identity, label })), label };
  }
  const bucketId = requireBucket(values.bucket);
  const { device, identity } = loadDevice();
  const label = values.label ? sanitizeLabel(values.label) : device.label;
  return { ...(await openReal({ identity, bucketId, relays: relaysOf(values.relays) })), label };
}

async function cmdStatus(values: ReturnType<typeof parse>["values"]) {
  let opened: Opened & { label: string };
  try {
    opened = await openFor(values);
  } catch (err) {
    if (err instanceof NotPairedError) {
      out("Not paired yet.");
      out(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  const { bucket, identity, label } = opened;
  const owner = findOwner(bucket, identity.pk);
  const entries = bucket.entries().filter((e) => !e.head.deleted);
  out(`Bucket   : ${bucket.name} (${bucket.bucketId})`);
  out(`Epoch    : ${bucket.epoch}`);
  out(`Relays   : ${bucket.relays.join(", ")}`);
  out(`Device   : ${label} ${identity.npub()}`);
  out(
    owner
      ? `Owner    : ${memberName(bucket, owner.pk) ?? "(unnamed)"} ${owner.pk} [${owner.role}]`
      : "Owner    : unresolved (device list not found — the pairing may still be propagating)",
  );
  out(`Entries  : ${entries.length}`);
  opened.close();
}

async function cmdServe(values: ReturnType<typeof parse>["values"]) {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const opened = await openFor(values);
  const { bucket, label, identity } = opened;
  const owner = findOwner(bucket, identity.pk);
  log(`bucket "${bucket.name}" epoch ${bucket.epoch}, ${bucket.entries().length} entries, device ${label}, owner ${owner?.pk ?? "unresolved"}`);

  let unsub: (() => void) | undefined;
  try {
    unsub = bucket.live(() => log("bucket updated from relays"));
  } catch (err) {
    log("live subscription failed (continuing with periodic sync):", err);
  }
  // Safety net: periodic resync in case the live subscription drops.
  const timer = values.mock ? undefined : setInterval(() => bucket.sync().catch((e) => log("resync failed:", e)), 5 * 60_000);

  const transport = new StdioServerTransport();
  const server = await startServer({ ctx: { bucket, label } }, transport);
  log("MCP server ready on stdio");

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    if (timer) clearInterval(timer);
    try {
      unsub?.();
    } catch {}
    try {
      await server.close();
    } catch {}
    opened.close();
    process.exit(0);
  };
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function main(argv = process.argv.slice(2)): Promise<string | undefined> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    process.exit(64);
  }
  const { values, positionals } = parsed;
  if (values.version) {
    out(SERVER_VERSION);
    return;
  }
  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stderr.write(USAGE);
    return;
  }
  try {
    if (cmd === "init") await cmdInit(values);
    else if (cmd === "status") await cmdStatus(values);
    else if (cmd === "serve") await cmdServe(values);
    else {
      process.stderr.write(`Unknown command "${cmd}".\n\n${USAGE}`);
      process.exit(64);
    }
  } catch (err) {
    if (cmd === "serve") log(err instanceof Error ? err.message : err);
    else process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  return cmd;
}

if (import.meta.main) {
  const cmd = await main();
  // status/init: relay sockets may keep the event loop alive.
  if (cmd !== "serve") process.exit(process.exitCode ?? 0);
}
