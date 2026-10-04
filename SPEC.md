# Tribe — encrypted team agent memory on Nostr

Static web app (GitHub Pages) + `bunx` MCP server. All crypto/sync logic lives in `@tribe/core`, shared by both.

## Decisions (fixed)
- Stack: Bun workspaces, TypeScript strict, Preact + Vite for web, hash routing, no backend.
- Libs: `nostr-tools` (v2: `finalizeEvent`, `generateSecretKey`, `getPublicKey`, `nip44`, `nip19`, `SimplePool`, `verifyEvent`), `@noble/hashes` (sha256, hmac, hkdf), `@noble/ciphers` (xchacha20poly1305) if needed. Prefer nip44 v2 for all encryption (with a conversation key = symmetric 32-byte key).
- Identity: per-user Nostr secret key, generated in browser. Stored either (a) wrapped with a passkey via WebAuthn PRF, or (b) plain in IndexedDB. Import nsec allowed.
- Roles: `admin` | `member`. Agents are *devices* of a member and inherit access.
- Memory: entries `type: "fact" | "page"`, pages link facts via `links: entryId[]`. Versioned; newest `createdAt` wins (tie → lexicographically larger inner event id); conflict = ≥2 heads (versions whose `prev` is the same and neither is superseded).
- Search: keyword only (MiniSearch) over local decrypted cache.
- Multiple buckets per identity.
- Scale target: ≤100 members, ≤50k entries per bucket.
- Revocation: removal → new epoch, future-only. No re-encryption.
- Relays: default list `["wss://relay.damus.io","wss://nos.lol","wss://relay.primal.net"]`, admin can override per bucket (stored in roster).

## Crypto primitives (core/src/crypto.ts)
- `symEncrypt(key32: Uint8Array, plaintext: string): string` — nip44 v2 `encrypt(plaintext, key32)` (key32 used directly as conversation key).
- `symDecrypt(key32, payload): string`.
- `hkdf32(ikm: Uint8Array, info: string): Uint8Array` — HKDF-SHA256, empty salt.
- `blind(key32, label: string): string` — hex(HMAC-SHA256(key32, label)).
- Large payloads: nip44 caps plaintext at 65535 bytes. For larger content, chunk is NOT required — enforce max entry body 60KB in UI/core and reject above.

## Bucket keys
- `bucketId`: random 16 bytes hex, chosen at creation.
- `rootSecret` (admin-only, 32 bytes): stored in admin's local keystore, also wrapped to every admin pubkey (kind 1059, see below) so co-admins can operate. Used to derive ephemeral signing keys so admins can NIP-09 delete.
- `epochKey[n]` (32 bytes random per epoch). All members get it.
- `locatorKey = hkdf32(sha256(bucketId), "tribe/locator")` — derived from bucketId alone so anyone with the invite/bucketId can query. Tag `g = blind(locatorKey, "bucket")`. (Bucket id is not secret from members; it only blinds from relay observers that don't know it.)
- Ephemeral outer signing key for an event: `hkdf32(epochKey, "tribe/eph/" + randomNonceHex)` — nonce stored in tag `n`. (So any member could compute; fine.)

## Event kinds
| kind | name | shape |
|---|---|---|
| 1059 | wrap | NIP-59 gift wrap (seal 13 inside) carrying a `KeyGrant` rumor (kind 4459) to a recipient pubkey. Use `nostr-tools/nip59` `wrapEvent`/`unwrapEvent`. Extra outer tag `["g", g]` not allowed by nip59 helper → wraps are found by `#p` only. |
| 30450 | roster | Addressable. `pubkey` = admin. tags: `["d", bucketIdBlind]` where `bucketIdBlind = blind(locatorKey,"roster")`, `["g", g]`. content = `symEncrypt(epochKey[epoch], JSON(RosterBody))`, plus tag `["epoch", String(epoch)]`. |
| 4450 | entry version | Regular. pubkey = ephemeral key. tags `["g", g]`, `["e2", blind(epochKey? NO → locatorKey, "entry/"+entryId)]` (use locatorKey so the tag is stable across epochs), `["epoch", n]`, `["n", nonceHex]`. content = `symEncrypt(epochKey[n], JSON(innerSignedEvent))`. |
| 4451 | join | Regular. pubkey = joiner's identity key. tags `["g", g]`, `["p", adminPubkey]`. content = nip44 to admin (`nip44.getConversationKey(joinerSk, adminPk)`) of JSON(JoinRequest). |
| 30451 | device list | Addressable, signed by member identity. tags `["d", blind(locatorKey,"devices/"+memberPk)]`, `["g", g]`. content = `symEncrypt(epochKey[latest], JSON({devices: DeviceInfo[]}))`. |
| 4452 | snapshot | Regular, ephemeral pubkey like 4450. Content = symEncrypt(epochKey, JSON({entries: InnerEvent[] (heads only), upTo: unix})). Optional; produced by admin or any member. |

Inner signed event (kind 4453, never published plain): standard Nostr event signed by author's identity key (or device key for agents), `content = JSON(EntryBody)`, `tags: [["entry", entryId]]`.

## Types (core/src/types.ts) — exact
```ts
export type Hex = string;
export type Role = "admin" | "member";
export interface Member { pk: Hex; role: Role; name?: string; addedAt: number; addedBy: Hex; viaInvite?: string }
export interface Invite { id: string; tokenPk: Hex; createdAt: number; expiresAt?: number; singleUse: boolean; usedBy?: Hex[]; label?: string; revoked?: boolean }
export interface RosterBody {
  v: 1; bucketId: Hex; name: string; epoch: number; prev?: Hex /* prev roster event id */;
  relays: string[]; members: Member[]; invites: Invite[]; updatedAt: number;
}
export interface KeyGrant { // rumor kind 4459 content
  bucketId: Hex; name: string; relays: string[]; admins: Hex[];
  epochs: { n: number; key: Hex }[]; rootSecret?: Hex /* only to admins */;
}
export interface JoinRequest { bucketId: Hex; inviteId?: string; tokenSig?: string /* schnorr sig by invite token key over sha256(bucketId+joinerPk) */; name?: string; message?: string }
export interface DeviceInfo { pk: Hex; label: string; kind: "browser" | "agent"; addedAt: number; revoked?: boolean }
export type EntryType = "fact" | "page";
export interface EntryBody {
  entryId: string; type: EntryType; title: string; body: string /* markdown */;
  tags: string[]; links: string[]; source: "human" | `agent:${string}`;
  prev?: Hex /* inner event id of previous version */; deleted?: boolean;
}
export interface EntryVersion extends EntryBody { id: Hex /* inner event id */; author: Hex; authorMember: Hex /* member identity pk (device resolved) */; createdAt: number; epoch: number }
export interface Entry { entryId: string; head: EntryVersion; versions: EntryVersion[]; conflict: boolean }
```

## Invites (pre-approved, no backend)
- Admin creates invite: random `tokenSk` (32B). `tokenPk = getPublicKey(tokenSk)`. Invite recorded in roster.
- Link: `https://<pages>/#/join?b=<bucketId>&a=<adminPk>&r=<relays,comma,urlencoded>#t=<nsec-style hex tokenSk>` — simpler: put everything in the hash after `#/join?` with `t=` param; GitHub Pages never sees the fragment. Encode as base64url JSON: `#/join/<base64url(JSON{b,a,r,t,n:name})>`.
- Admin publishes a KeyGrant gift-wrapped to `tokenPk` (same as to a member). On every epoch rotation admin re-wraps to all non-revoked, non-expired invite tokenPks.
- Joiner: unwrap grant using tokenSk → gets epoch keys. Publishes JoinRequest (kind 4451) with `tokenSig` proving token possession. Joiner can immediately read & write.
- Acceptance rule (all clients): an author pk is a valid member at epoch n if (a) listed in roster members, OR (b) there is a valid JoinRequest with a tokenSig for a roster invite that is not revoked/expired/over-used at the time. Admin client, when online, auto-converts (b) into roster members (with `viaInvite`) and publishes new roster. Single-use: first join wins (by created_at).
- `requireApproval` invites: not in v1 — instead a "request access" flow: user without token sends JoinRequest without tokenSig; admin sees it in "Pending" and approves (adds member + wraps keys).

## Roster validity
- Roster event must be signed by a pk in `admins` of the current trusted roster (bootstrap: admin pk from invite / creator). First roster: signer = creator, members contains creator as admin.
- Accept the newest valid roster (highest epoch, then updatedAt). `prev` chain recorded but v1 only warns on gaps.

## Revoke / rotate
- `removeMember(pk)`: drop from members, epoch+1, new epochKey, wrap KeyGrant (all epochs the recipient is allowed — default: all known epochs) to every remaining member identity pk, every device pk of remaining members (device keys come from device lists), and every live invite tokenPk. Publish roster under new epoch key. Admin also wraps rootSecret to admins.
- Members wrap new epoch keys to their own devices when they see a new epoch (members can do that since they hold the key).
- Entries written with an old epoch after the rotation by a removed member → rejected (author not member at that epoch).

## Sync / store (core)
- `Store` interface: `get/put/list` of raw events + decrypted cache. Two adapters: `IdbStore` (browser, `idb` lib) and `MemoryStore` (tests) and `FileStore` (MCP, JSON file in `~/.tribe/<bucketId>.json`; fine for ≤50k).
- `Relay` abstraction: `RelayPool` interface `{ publish(ev, relays): Promise<{ok:string[],failed:string[]}>; subscribe(filters, relays, onEvent, onEose): () => void; query(filters, relays): Promise<Event[]> }`. Default impl over nostr-tools `SimplePool`. A `MockPool` (in-memory, filter-matching) for tests and for the web app's "demo mode".

## Core public API (core/src/index.ts) — exact signatures
```ts
export class Identity {
  static generate(): Identity; static fromSecret(sk: Uint8Array): Identity;
  readonly sk: Uint8Array; readonly pk: Hex; npub(): string; nsec(): string;
  sign(t: EventTemplate): VerifiedEvent;
}
export interface BucketSummary { bucketId: Hex; name: string; role: Role | "pending"; relays: string[] }
export class Bucket {
  // lifecycle
  static create(opts: { identity: Identity; name: string; relays?: string[]; pool: RelayPool; store: Store }): Promise<Bucket>;
  static open(opts: { identity: Identity; bucketId: Hex; pool: RelayPool; store: Store; adminHint?: Hex; relays?: string[] }): Promise<Bucket>;
  static joinWithInvite(opts: { identity: Identity; link: string /* full URL or the base64 blob */; name?: string; pool: RelayPool; store: Store }): Promise<Bucket>;
  static requestAccess(opts: { identity: Identity; bucketId: Hex; adminPk: Hex; relays: string[]; name?: string; message?: string; pool: RelayPool }): Promise<void>;
  static listMine(store: Store): Promise<BucketSummary[]>;
  // state
  readonly bucketId: Hex; name: string; relays: string[]; epoch: number; roster: RosterBody | null;
  myRole(): Role | null; isAdmin(): boolean;
  sync(): Promise<void>; // fetch everything from relays, decrypt, rebuild index
  live(onChange: () => void): () => void; // subscribe for updates
  // members (admin)
  createInvite(opts?: { label?: string; singleUse?: boolean; expiresInDays?: number; baseUrl?: string }): Promise<{ invite: Invite; link: string }>;
  revokeInvite(id: string): Promise<void>;
  pendingRequests(): JoinRequestView[]; // {pk, name?, message?, createdAt, inviteId?, autoAccepted:boolean}
  approve(pk: Hex, role?: Role): Promise<void>;
  removeMember(pk: Hex): Promise<void>;
  setRole(pk: Hex, role: Role): Promise<void>;
  setRelays(relays: string[]): Promise<void>;
  rotate(): Promise<void>;
  rename(name: string): Promise<void>;
  // devices (any member)
  devices(memberPk?: Hex): DeviceInfo[];
  addDevice(pk: Hex, label: string, kind: "browser" | "agent"): Promise<void>; // updates device list + wraps all epoch keys to device
  revokeDevice(pk: Hex): Promise<void>; // marks revoked; if caller is admin also rotates; else asks admin via rotation request (v1: just mark + if admin rotate)
  // memory
  entries(): Entry[];
  get(entryId: string): Entry | undefined;
  search(q: string, opts?: { type?: EntryType; tag?: string; source?: "human" | "agent"; limit?: number }): Entry[];
  tags(): { tag: string; count: number }[];
  backlinks(entryId: string): Entry[];
  write(input: { entryId?: string; type: EntryType; title: string; body: string; tags?: string[]; links?: string[]; source?: EntryBody["source"]; prev?: Hex }): Promise<EntryVersion>;
  remove(entryId: string): Promise<void>; // writes tombstone version (deleted:true)
  exportJSON(): string; exportMarkdown(): { path: string; content: string }[];
  snapshot(): Promise<void>;
}
// device identity (agent acting on behalf of member): Bucket.open with identity = device key; it finds its KeyGrant wrapped to device pk, resolves owner via device lists; writes sign inner events with device key; authorMember = owner.
export { MockPool, NostrPool, MemoryStore, IdbStore /* browser only, separate entry */, FileStore /* node only, separate entry */ };
export function parseInviteLink(link: string): { bucketId: Hex; adminPk: Hex; relays: string[]; tokenSk: Hex; name?: string };
```
Entry points: `@tribe/core` (isomorphic, no IDB/fs), `@tribe/core/idb`, `@tribe/core/file`.

## Web app (apps/web)
Screens: Welcome/Identity → Buckets → Create wizard → Knowledge (feed + search + filters) → Entry view/editor (markdown, history, diff, backlinks, conflict banner) → Members (admin) → Devices & Agents (pairing) → Settings (relays, rotation, export, key backup). Demo mode toggle using MockPool + seeded data so it works without relays. Vite `base: "./"`. GitHub Actions workflow for Pages.

## MCP (packages/mcp)
`bunx tribe-mcp init` → generates device key in `~/.tribe/device.json`, prints npub + pairing code (the npub). `bunx tribe-mcp serve --bucket <id>` (stdio MCP via `@modelcontextprotocol/sdk`). Tools: `memory_search{query,type?,tag?,limit?}`, `memory_get{entryId}`, `memory_write{entryId?,type,title,body,tags?,links?}`, `memory_link{pageId, factIds[]}`, `memory_list_tags{}`. Source auto-set to `agent:<label>`.
