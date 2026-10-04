import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { Identity } from "./core.ts";

export interface DeviceFile {
  v: 1;
  sk: string; // hex secret key
  pk: string; // hex public key
  label: string;
  createdAt: number;
}

export function tribeHome(): string {
  return process.env.TRIBE_HOME || join(homedir(), ".tribe");
}

export function devicePath(): string {
  return join(tribeHome(), "device.json");
}

export function bucketStorePath(bucketId: string): string {
  if (!/^[0-9a-fA-F]{8,128}$/.test(bucketId)) throw new Error(`Invalid bucket id "${bucketId}" (expected hex)`);
  return join(tribeHome(), `${bucketId.toLowerCase()}.json`);
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function sanitizeLabel(label: string): string {
  const s = label.trim().replace(/[^\w.\- ]+/g, "-").replace(/\s+/g, "-").slice(0, 40);
  return s || "agent";
}

export function defaultLabel(): string {
  try {
    return sanitizeLabel(`agent-${hostname()}`);
  } catch {
    return "agent";
  }
}

export function ensureHome(): string {
  const dir = tribeHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function createDevice(opts: { label?: string; force?: boolean } = {}): { device: DeviceFile; identity: Identity; created: boolean } {
  ensureHome();
  const path = devicePath();
  if (existsSync(path) && !opts.force) {
    const { device, identity } = loadDevice();
    return { device, identity, created: false };
  }
  const identity = Identity.generate();
  const device: DeviceFile = {
    v: 1,
    sk: bytesToHex(identity.sk),
    pk: identity.pk,
    label: sanitizeLabel(opts.label ?? defaultLabel()),
    createdAt: Math.floor(Date.now() / 1000),
  };
  writeFileSync(path, JSON.stringify(device, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { device, identity, created: true };
}

export function loadDevice(): { device: DeviceFile; identity: Identity } {
  const path = devicePath();
  if (!existsSync(path)) {
    throw new Error(`No device key at ${path}. Run \`tribe-mcp init --label <name>\` first.`);
  }
  const device = JSON.parse(readFileSync(path, "utf8")) as DeviceFile;
  if (!device.sk || !/^[0-9a-f]{64}$/i.test(device.sk)) throw new Error(`Corrupt device file ${path}: missing/invalid "sk"`);
  const identity = Identity.fromSecret(hexToBytes(device.sk));
  if (device.pk && device.pk !== identity.pk) throw new Error(`Corrupt device file ${path}: pk does not match sk`);
  return { device: { ...device, pk: identity.pk, label: device.label || "agent" }, identity };
}
