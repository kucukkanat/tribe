export type Hex = string;
export type Role = "admin" | "member";
export interface Member { pk: Hex; role: Role; name?: string; addedAt: number; addedBy: Hex; viaInvite?: string }
export interface Invite { id: string; tokenPk: Hex; createdAt: number; expiresAt?: number; singleUse: boolean; usedBy?: Hex[]; label?: string; revoked?: boolean }
export interface RemovedMember { pk: Hex; epoch: number /* first epoch they are NOT a member of */; at: number }
export interface RosterBody {
  v: 1; bucketId: Hex; name: string; epoch: number; prev?: Hex /* prev roster event id */;
  relays: string[]; members: Member[]; invites: Invite[]; updatedAt: number;
  /** ADDITION: removal history so all clients can reject post-removal writes at old epochs. */
  removed?: RemovedMember[];
}
export interface KeyGrant { // rumor kind 4459 content
  bucketId: Hex; name: string; relays: string[]; admins: Hex[];
  epochs: { n: number; key: Hex }[]; rootSecret?: Hex /* only to admins */;
}
export interface JoinRequest { bucketId: Hex; inviteId?: string; tokenSig?: string /* schnorr sig by invite token key over sha256(bucketId+joinerPk) */; name?: string; message?: string }
export interface DeviceInfo { pk: Hex; label: string; kind: "browser" | "agent"; addedAt: number; revoked?: boolean; /** ADDITION */ revokedAt?: number }
export type EntryType = "fact" | "page";
export interface EntryBody {
  entryId: string; type: EntryType; title: string; body: string /* markdown */;
  tags: string[]; links: string[]; source: "human" | `agent:${string}`;
  prev?: Hex /* inner event id of previous version */; deleted?: boolean;
  /** ADDITION: other head ids this version supersedes (conflict resolution). */
  merges?: Hex[];
}
export interface EntryVersion extends EntryBody { id: Hex /* inner event id */; author: Hex; authorMember: Hex /* member identity pk (device resolved) */; createdAt: number; epoch: number }
export interface Entry { entryId: string; head: EntryVersion; versions: EntryVersion[]; conflict: boolean }

export interface BucketSummary { bucketId: Hex; name: string; role: Role | "pending"; relays: string[] }
export interface JoinRequestView { pk: Hex; name?: string; message?: string; createdAt: number; inviteId?: string; autoAccepted: boolean }

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
export const MAX_BODY_BYTES = 60 * 1024;

export const KIND_WRAP = 1059;
export const KIND_SEAL = 13;
export const KIND_GRANT = 4459;
export const KIND_ROSTER = 30450;
export const KIND_ENTRY = 4450;
export const KIND_JOIN = 4451;
export const KIND_DEVICES = 30451;
export const KIND_SNAPSHOT = 4452;
export const KIND_INNER = 4453;
export const KIND_TOKEN_PROOF = 4458;
