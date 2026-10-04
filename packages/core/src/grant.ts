import { nip44, verifyEvent, getEventHash } from "nostr-tools";
import type { Event } from "nostr-tools";
import { wrapEvent } from "nostr-tools/nip59";
import type { Hex, KeyGrant } from "./types.ts";
import { KIND_GRANT, KIND_SEAL, KIND_WRAP } from "./types.ts";

/** Gift-wrap (NIP-59) a KeyGrant rumor (kind 4459) from sender to recipient. */
export function wrapGrant(grant: KeyGrant, senderSk: Uint8Array, recipientPk: Hex): Event {
  return wrapEvent({ kind: KIND_GRANT, content: JSON.stringify(grant), tags: [] }, senderSk, recipientPk);
}

export interface UnwrappedGrant { sender: Hex; grant: KeyGrant; createdAt: number; recipient: Hex }

/** Unwrap and fully verify (wrap sig, seal sig, rumor id, rumor.pubkey === seal.pubkey). Returns null if not for us / invalid. */
export function unwrapGrant(wrap: Event, recipientSk: Uint8Array, recipientPk: Hex): UnwrappedGrant | null {
  try {
    if (wrap.kind !== KIND_WRAP) return null;
    if (!wrap.tags.some((t) => t[0] === "p" && t[1] === recipientPk)) return null;
    if (!verifyEvent(wrap)) return null;
    const seal = JSON.parse(nip44.v2.decrypt(wrap.content, nip44.getConversationKey(recipientSk, wrap.pubkey))) as Event;
    if (seal.kind !== KIND_SEAL || !verifyEvent(seal)) return null;
    const rumor = JSON.parse(nip44.v2.decrypt(seal.content, nip44.getConversationKey(recipientSk, seal.pubkey)));
    if (rumor.kind !== KIND_GRANT || rumor.pubkey !== seal.pubkey) return null;
    if (getEventHash(rumor) !== rumor.id) return null;
    const grant = JSON.parse(rumor.content) as KeyGrant;
    if (typeof grant.bucketId !== "string" || !Array.isArray(grant.epochs)) return null;
    return { sender: seal.pubkey, grant, createdAt: rumor.created_at, recipient: recipientPk };
  } catch {
    return null;
  }
}
