/**
 * Thin adapter over @tribe/core. Everything the MCP package needs from core is
 * imported here so the rest of the package has a single integration point.
 */
export {
  Identity,
  Bucket,
  MockPool,
  NostrPool,
  MemoryStore,
} from "@tribe/core";
export type {
  Hex,
  Entry,
  EntryVersion,
  EntryType,
  EntryBody,
  DeviceInfo,
  Member,
  RosterBody,
} from "@tribe/core";

import type { Bucket, Hex, Member } from "@tribe/core";

/** Default relays (SPEC "Decisions"). */
export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

/** Find the roster member that owns device `devicePk` (or the member itself if pk is a member). */
export function findOwner(bucket: Bucket, devicePk: Hex): Member | undefined {
  const members = bucket.roster?.members ?? [];
  const direct = members.find((m) => m.pk === devicePk);
  if (direct) return direct;
  for (const m of members) {
    let devs: { pk: Hex; revoked?: boolean }[] = [];
    try {
      devs = bucket.devices(m.pk) ?? [];
    } catch {
      devs = [];
    }
    if (devs.some((d) => d.pk === devicePk && !d.revoked)) return m;
  }
  return undefined;
}

export function memberName(bucket: Bucket, pk: Hex): string | undefined {
  return bucket.roster?.members.find((m) => m.pk === pk)?.name;
}
