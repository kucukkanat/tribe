// Thin adapter over @tribe/core. All web code imports core through this file so
// any drift between SPEC and implementation is fixed in one place.
export { Bucket, Identity, MockPool, NostrPool, MemoryStore, parseInviteLink } from "@tribe/core";
import { buildConnectString } from "@tribe/core";
export type {
  Entry, EntryVersion, EntryType, EntryBody, Member, Invite, RosterBody, DeviceInfo, Role, Hex, BucketSummary,
} from "@tribe/core";
import { IdbStore } from "@tribe/core/idb";
import type { Bucket } from "@tribe/core";

export type Pool = Parameters<typeof Bucket.create>[0]["pool"];
export type Store = Parameters<typeof Bucket.create>[0]["store"];
export type JoinRequestView = ReturnType<Bucket["pendingRequests"]>[number];
export { DEFAULT_RELAYS, MAX_BODY_BYTES } from "@tribe/core";

export async function makeIdbStore(): Promise<Store> { return new IdbStore("tribe"); }

// ---- optional / in-flight core APIs, feature-detected so the app compiles either way ----
export type { RelayStatus } from "@tribe/core";
import type { RelayStatus } from "@tribe/core";

/** Per-relay health, or null when this core build has no relayStatus(). */
export function relayStatusOf(b: Bucket): RelayStatus[] | null {
  const f = (b as unknown as { relayStatus?: () => RelayStatus[] }).relayStatus;
  if (typeof f !== "function") return null;
  try { return f.call(b); } catch { return null; }
}

export type JoinStatus = { status: "pending" | "rejected" | "accepted" | string; reason?: string };
/** Join status for a bucket joined via invite, or null when unknown/unsupported. */
export function joinStatusOf(b: Bucket): JoinStatus | null {
  const raw = (b as unknown as { joinStatus?: unknown }).joinStatus;
  let v: unknown = raw;
  try { if (typeof raw === "function") v = (raw as () => unknown).call(b); } catch { return null; }
  if (typeof v === "string") return { status: v };
  if (v && typeof v === "object" && typeof (v as JoinStatus).status === "string") return v as JoinStatus;
  return null;
}

/** Root admin (bucket creator / first admin) pk. */
export function rootAdminOf(b: Bucket): string | null {
  const st = (b as unknown as { st?: { rootAdmins?: string[] } }).st;
  if (st?.rootAdmins?.[0]) return st.rootAdmins[0];
  const admins = (b.roster?.members ?? []).filter((m) => m.role === "admin").sort((x, y) => x.addedAt - y.addedAt);
  return admins[0]?.pk ?? null;
}

/** `tribe://<bucketId>?admin=<pk>&relays=<enc>,<enc>` (same format as core's buildConnectString). */
export function connectString(bucketId: string, admin: string, relays: string[]): string {
  return buildConnectString({ bucketId, adminPk: admin, relays });
}

/** Relays recommended for new buckets (damus rate-limits bursts and doesn't serve gift wraps reliably). */
export const RECOMMENDED_RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom", "wss://relay.snort.social"];
