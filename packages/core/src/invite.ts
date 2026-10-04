import { finalizeEvent, getEventHash, verifyEvent } from "nostr-tools";
import type { Hex } from "./types.ts";
import { b64urlDecode, b64urlEncode, hexToBytes, sha256Hex } from "./crypto.ts";
import { KIND_TOKEN_PROOF } from "./types.ts";
import { Identity } from "./identity.ts";

export interface InviteLinkData { bucketId: Hex; adminPk: Hex; relays: string[]; tokenSk: Hex; name?: string }

export function defaultBaseUrl(): string {
  const loc = (globalThis as any).location;
  if (loc && typeof loc.origin === "string" && loc.origin !== "null") return loc.origin + loc.pathname;
  return "https://tribe.local/";
}

export function buildInviteLink(d: InviteLinkData, baseUrl?: string): string {
  const blob = b64urlEncode(JSON.stringify({ b: d.bucketId, a: d.adminPk, r: d.relays, t: d.tokenSk, n: d.name }));
  const base = (baseUrl ?? defaultBaseUrl()).replace(/#.*$/, "");
  return `${base}#/join/${blob}`;
}

export function parseInviteLink(link: string): { bucketId: Hex; adminPk: Hex; relays: string[]; tokenSk: Hex; name?: string } {
  let blob = link.trim();
  const i = blob.indexOf("#/join/");
  if (i >= 0) blob = blob.slice(i + 7);
  else if (blob.includes("/join/")) blob = blob.slice(blob.lastIndexOf("/join/") + 6);
  blob = blob.split(/[?#&]/)[0]!;
  let o: any;
  try { o = JSON.parse(b64urlDecode(blob)); } catch { throw new Error("invalid invite link"); }
  const hex64 = /^[0-9a-f]{64}$/;
  if (!o || typeof o.b !== "string" || !hex64.test(o.a) || !hex64.test(o.t) || !Array.isArray(o.r)) throw new Error("invalid invite link");
  return { bucketId: o.b, adminPk: o.a, relays: o.r, tokenSk: o.t, name: o.n };
}

/**
 * tokenSig: BIP-340 schnorr signature by the invite token key, produced as the `sig` of a canonical
 * Nostr event {kind:4458, created_at:0, tags:[], content: sha256hex(bucketId+joinerPk)} — i.e. a schnorr sig
 * over a hash committing to sha256(bucketId+joinerPk). Verifiable with standard nostr tooling.
 */
function proofTemplate(bucketId: Hex, joinerPk: Hex) {
  return { kind: KIND_TOKEN_PROOF, created_at: 0, tags: [] as string[][], content: sha256Hex(bucketId + joinerPk) };
}
export function signTokenProof(tokenSkHex: Hex, bucketId: Hex, joinerPk: Hex): string {
  return finalizeEvent(proofTemplate(bucketId, joinerPk), hexToBytes(tokenSkHex)).sig;
}
export function verifyTokenProof(tokenPk: Hex, bucketId: Hex, joinerPk: Hex, sig: string): boolean {
  try {
    const t = { ...proofTemplate(bucketId, joinerPk), pubkey: tokenPk };
    const ev = { ...t, id: getEventHash(t), sig };
    return verifyEvent(ev);
  } catch { return false; }
}

/** Connection string for agents/devices: `tribe://<bucketId>?admin=<pk>&relays=<enc>,<enc>`. */
export interface ConnectData { bucketId: Hex; adminPk: Hex; relays: string[] }
export function buildConnectString(d: ConnectData): string {
  return `tribe://${d.bucketId}?admin=${d.adminPk}&relays=${d.relays.map(encodeURIComponent).join(",")}`;
}
export function parseConnectString(s: string): ConnectData {
  const m = /^tribe:\/\/([0-9a-fA-F]{8,128})\?(.*)$/.exec(s.trim());
  if (!m) throw new Error("invalid connection string (expected tribe://<bucketId>?admin=<pk>&relays=...)");
  let adminPk = "", relays: string[] = [];
  for (const part of m[2]!.split("&")) {
    const i = part.indexOf("=");
    const k = part.slice(0, i), v = part.slice(i + 1);
    if (k === "admin") { try { adminPk = Identity.parsePubkey(decodeURIComponent(v)); } catch { adminPk = ""; } }
    else if (k === "relays") relays = v.split(",").filter(Boolean).map(decodeURIComponent);
  }
  if (!/^[0-9a-f]{64}$/.test(adminPk)) throw new Error("invalid connection string: missing/invalid admin pubkey");
  for (const r of relays) if (!/^wss?:\/\//.test(r)) throw new Error(`invalid relay URL in connection string: ${r}`);
  return { bucketId: m[1]!.toLowerCase(), adminPk, relays };
}
