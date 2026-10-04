// Thin adapter over @tribe/core. All web code imports core through this file so
// any drift between SPEC and implementation is fixed in one place.
export { Bucket, Identity, MockPool, NostrPool, MemoryStore, parseInviteLink } from "@tribe/core";
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
