import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import type { Event, Filter } from "nostr-tools";
import { Identity } from "./identity.ts";
import type { RelayPool } from "./pool.ts";
import type { Store } from "./store/types.ts";
import {
  DEFAULT_RELAYS, KIND_DEVICES, KIND_ENTRY, KIND_INNER, KIND_JOIN, KIND_ROSTER, KIND_SNAPSHOT, KIND_WRAP, MAX_BODY_BYTES,
} from "./types.ts";
import type {
  BucketSummary, DeviceInfo, Entry, EntryBody, EntryType, EntryVersion, Hex, Invite, JoinRequest, JoinRequestView, KeyGrant,
  Role, RosterBody,
} from "./types.ts";
import {
  blind, bucketTag, bytesToHex, ephemeralKey, hexToBytes, locatorKey, randomHex, symDecrypt, symEncrypt,
} from "./crypto.ts";
import { unwrapGrant, wrapGrant } from "./grant.ts";
import { buildInviteLink, parseInviteLink, signTokenProof, verifyTokenProof } from "./invite.ts";
import { EntryGraph } from "./entries.ts";
import { SearchIndex } from "./search.ts";

const now = () => Math.floor(Date.now() / 1000);
const WRAP_OVERLAP = 3 * 86400; // NIP-59 randomizes wrap created_at up to 2 days into the past
const SYNC_OVERLAP = 600;
const MAX_PENDING = 2000;
const SNAPSHOT_CHUNK = 48_000;
const tagVal = (e: Event, name: string) => e.tags.find((t) => t[0] === name)?.[1];

/** Persisted per (identity, bucket). */
interface PersistState {
  v: 1;
  bucketId: Hex;
  name: string;
  relays: string[];
  epochKeys: Record<string, Hex[]>; // candidates per epoch
  rootSecret?: Hex;
  rootAdmins: Hex[]; // bootstrap trust anchors
  trusted: Hex[]; // admins of last accepted roster
  lastSync: number;
  lastWrapSync: number;
  tokenSk?: Hex;
  seenWraps: Hex[];
  deviceWrapped: Record<Hex, number>;
}

/** Version record persisted in kv (inner signed event + resolved metadata). */
interface VersionRecord { o: string; i: Event; e: number; m: Hex }

interface JoinInfo { ev: Event; pk: Hex; createdAt: number; inviteId?: string; tokenSig?: string; name?: string; message?: string }

type ProcessResult = "ok" | "dup" | "pending" | "invalid";

class Mutex {
  private p: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.p.then(fn, fn);
    this.p = r.catch(() => {});
    return r;
  }
}

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 60) || "untitled";
}
const yamlStr = (s: string) => JSON.stringify(s);

export class Bucket {
  readonly bucketId: Hex;
  name: string;
  relays: string[];
  epoch = 0;
  roster: RosterBody | null = null;

  /** ADDITION: true when a newer roster exists that we cannot decrypt (we were removed / invite revoked). */
  lockedOut = false;
  /** ADDITION: the member identity this client acts for (== identity.pk unless identity is a device). */
  memberPk: Hex | null = null;
  readonly identity: Identity;
  readonly pool: RelayPool;
  readonly store: Store;

  private st: PersistState;
  private loc: Uint8Array;
  private g: string;
  private rosterD: string;
  private keys = new Map<number, Uint8Array[]>();
  private confirmed = new Map<number, Uint8Array>();
  private control = new Map<string, Event>();
  private rosterEventId: Hex | undefined;
  private lastRosterAt = 0;
  private lastDevicesAt = 0;
  private deviceLists = new Map<Hex, { at: number; devices: DeviceInfo[] }>();
  private joins = new Map<Hex, JoinInfo>();
  private validJoins = new Map<Hex, JoinInfo>();
  private graph = new EntryGraph();
  private index = new SearchIndex();
  private seenOuter = new Set<string>();
  private pending = new Map<string, Event>();
  private seenWraps: Set<string>;
  private mutex = new Mutex();

  private constructor(identity: Identity, pool: RelayPool, store: Store, st: PersistState) {
    this.identity = identity;
    this.pool = pool;
    this.store = store;
    this.st = st;
    this.bucketId = st.bucketId;
    this.name = st.name;
    this.relays = st.relays;
    this.loc = locatorKey(st.bucketId);
    this.g = bucketTag(st.bucketId);
    this.rosterD = blind(this.loc, "roster");
    this.seenWraps = new Set(st.seenWraps);
    for (const [n, ks] of Object.entries(st.epochKeys)) this.keys.set(Number(n), ks.map(hexToBytes));
  }

  // ---------- storage keys ----------
  private get prefix() { return `b/${this.identity.pk}/${this.bucketId}/`; }
  private static stateKey(pk: Hex, bid: Hex) { return `b/${pk}/${bid}/state`; }
  private static summaryKey(pk: Hex, bid: Hex) { return `s/${pk}/${bid}`; }

  private static freshState(bucketId: Hex, relays: string[], rootAdmins: Hex[], name = ""): PersistState {
    return { v: 1, bucketId, name, relays, epochKeys: {}, rootAdmins, trusted: [], lastSync: 0, lastWrapSync: 0, seenWraps: [], deviceWrapped: {} };
  }

  private static async load(identity: Identity, pool: RelayPool, store: Store, bucketId: Hex, fallback: () => PersistState): Promise<Bucket> {
    const st = (await store.get<PersistState>(Bucket.stateKey(identity.pk, bucketId))) ?? fallback();
    const b = new Bucket(identity, pool, store, st);
    await b.loadCache();
    return b;
  }

  private async loadCache() {
    const recs = await this.store.list<VersionRecord>(this.prefix + "v/");
    for (const { value: r } of recs) {
      const v = this.recordToVersion(r);
      if (!v) continue;
      this.graph.add(v);
      this.seenOuter.add(r.o);
    }
    this.index.addAll(this.graph.all());
    const ctl = await this.store.list<Event>(this.prefix + "c/");
    for (const { value } of ctl) this.control.set(value.id, value);
    const pend = (await this.store.get<Event[]>(this.prefix + "pending")) ?? [];
    for (const e of pend) this.pending.set(e.id, e);
    this.recomputeControl();
  }

  private recordToVersion(r: VersionRecord): EntryVersion | null {
    try {
      const body = JSON.parse(r.i.content) as EntryBody;
      return { ...body, id: r.i.id, author: r.i.pubkey, authorMember: r.m, createdAt: r.i.created_at, epoch: r.e };
    } catch { return null; }
  }

  private async persist(newRecords: [string, unknown][] = []) {
    this.st.name = this.name;
    this.st.relays = this.relays;
    this.st.seenWraps = [...this.seenWraps];
    this.st.epochKeys = {};
    for (const [n, ks] of this.keys) this.st.epochKeys[n] = ks.map(bytesToHex);
    const role = this.myRole();
    const summary: BucketSummary = { bucketId: this.bucketId, name: this.name, role: role ?? "pending", relays: this.relays };
    await this.store.setMany([
      ...newRecords,
      [Bucket.stateKey(this.identity.pk, this.bucketId), this.st],
      [Bucket.summaryKey(this.identity.pk, this.bucketId), summary],
      [this.prefix + "pending", [...this.pending.values()]],
    ]);
  }

  // ---------- keys ----------
  private addKey(n: number, key: Uint8Array): boolean {
    const list = this.keys.get(n) ?? [];
    const hex = bytesToHex(key);
    if (list.some((k) => bytesToHex(k) === hex)) return false;
    list.push(key);
    this.keys.set(n, list);
    return true;
  }
  private keyFor(n: number): Uint8Array {
    const k = this.confirmed.get(n) ?? this.keys.get(n)?.[0];
    if (!k) throw new Error(`no key for epoch ${n}`);
    return k;
  }
  private tryDecrypt(n: number, payload: string, check?: (key: Uint8Array) => boolean): { key: Uint8Array; text: string } | null {
    const cands = this.keys.get(n);
    if (!cands) return null;
    const conf = this.confirmed.get(n);
    const ordered = conf ? [conf, ...cands.filter((k) => k !== conf)] : cands;
    for (const key of ordered) {
      if (check && !check(key)) continue;
      try { return { key, text: symDecrypt(key, payload) }; } catch { /* next */ }
    }
    return null;
  }
  private maxKeyEpoch() { let m = -1; for (const n of this.keys.keys()) m = Math.max(m, n); return m; }
  private allEpochs(): { n: number; key: Hex }[] {
    return [...this.keys.keys()].sort((a, b) => a - b).map((n) => ({ n, key: bytesToHex(this.keyFor(n)) }));
  }

  // ---------- membership ----------
  myRole(): Role | null {
    if (!this.roster || this.lockedOut) return null;
    const pk = this.memberPk ?? this.identity.pk;
    const m = this.roster.members.find((x) => x.pk === pk);
    if (m) return m.role;
    if (this.validJoins.has(pk) && !this.isRemoved(pk)) return "member";
    return null;
  }
  /** True when this identity itself is a roster admin (a device of an admin is not). */
  isAdmin(): boolean {
    if (!this.roster || this.lockedOut) return false;
    return this.roster.members.some((m) => m.pk === this.identity.pk && m.role === "admin");
  }
  private admins(r: RosterBody | null = this.roster): Hex[] {
    return r ? r.members.filter((m) => m.role === "admin").map((m) => m.pk) : [];
  }
  private isRemoved(pk: Hex): boolean {
    if (!this.roster) return false;
    if (this.roster.members.some((m) => m.pk === pk)) return false;
    return (this.roster.removed ?? []).some((r) => r.pk === pk);
  }
  /** Acceptance rule: is member identity `pk` allowed to author at `epoch`, time `createdAt`? */
  private isValidAuthorAt(pk: Hex, epoch: number, createdAt: number): boolean {
    const r = this.roster;
    if (!r) return false;
    if (r.members.some((m) => m.pk === pk)) return true;
    const rem = (r.removed ?? []).filter((x) => x.pk === pk);
    if (rem.length) {
      const last = rem.reduce((a, b) => (b.at > a.at ? b : a));
      return epoch < last.epoch && createdAt < last.at;
    }
    return this.validJoins.has(pk);
  }
  private resolveAuthor(authorPk: Hex, createdAt: number): Hex | null {
    if (this.roster?.members.some((m) => m.pk === authorPk)) return authorPk;
    if (this.joins.has(authorPk) || this.roster?.removed?.some((x) => x.pk === authorPk)) return authorPk;
    for (const [member, { devices }] of this.deviceLists) {
      const d = devices.find((x) => x.pk === authorPk);
      if (!d) continue;
      if (d.revoked && (d.revokedAt === undefined || createdAt >= d.revokedAt)) return null;
      return member;
    }
    return null;
  }

  // ---------- control state ----------
  private recomputeControl() {
    // rosters
    const cands: { ev: Event; body: RosterBody; key: Uint8Array }[] = [];
    let maxSeenEpochTrusted = -1;
    const undecryptable: Event[] = [];
    for (const ev of this.control.values()) {
      if (ev.kind !== KIND_ROSTER || tagVal(ev, "d") !== this.rosterD) continue;
      this.lastRosterAt = Math.max(this.lastRosterAt, ev.created_at);
      const n = Number(tagVal(ev, "epoch"));
      const d = this.tryDecrypt(n, ev.content);
      if (!d) { undecryptable.push(ev); continue; }
      try {
        const body = JSON.parse(d.text) as RosterBody;
        if (body.bucketId !== this.bucketId || body.epoch !== n || !Array.isArray(body.members)) continue;
        cands.push({ ev, body, key: d.key });
      } catch { /* ignore */ }
    }
    cands.sort((a, b) => a.body.epoch - b.body.epoch || a.body.updatedAt - b.body.updatedAt || a.ev.created_at - b.ev.created_at || (a.ev.id < b.ev.id ? -1 : 1));
    let trusted = new Set<Hex>([...this.st.rootAdmins, ...this.st.trusted]);
    let accepted: (typeof cands)[number] | null = null;
    for (const c of cands) {
      if (!trusted.has(c.ev.pubkey)) continue;
      accepted = c;
      this.confirmed.set(c.body.epoch, c.key);
      trusted = new Set(this.admins(c.body));
    }
    if (accepted) {
      this.roster = accepted.body;
      this.rosterEventId = accepted.ev.id;
      this.epoch = accepted.body.epoch;
      this.name = accepted.body.name;
      this.relays = accepted.body.relays?.length ? accepted.body.relays : this.relays;
      this.st.trusted = [...trusted];
      maxSeenEpochTrusted = accepted.body.epoch;
    }
    // newer roster signed by a trusted admin that we can't decrypt → locked out
    this.lockedOut = undecryptable.some((ev) => trusted.has(ev.pubkey) && Number(tagVal(ev, "epoch")) > maxSeenEpochTrusted);

    // device lists
    this.deviceLists.clear();
    for (const ev of this.control.values()) {
      if (ev.kind !== KIND_DEVICES) continue;
      this.lastDevicesAt = Math.max(this.lastDevicesAt, ev.created_at);
      if (tagVal(ev, "d") !== blind(this.loc, "devices/" + ev.pubkey)) continue;
      const prev = this.deviceLists.get(ev.pubkey);
      if (prev && prev.at >= ev.created_at) continue;
      const d = this.tryDecrypt(Number(tagVal(ev, "epoch")), ev.content);
      if (!d) continue;
      try {
        const devices = (JSON.parse(d.text) as { devices: DeviceInfo[] }).devices;
        if (Array.isArray(devices)) this.deviceLists.set(ev.pubkey, { at: ev.created_at, devices });
      } catch { /* ignore */ }
    }

    // joins
    this.joins.clear();
    for (const ev of this.control.values()) {
      if (ev.kind !== KIND_JOIN) continue;
      const info: JoinInfo = { ev, pk: ev.pubkey, createdAt: ev.created_at };
      const x = tagVal(ev, "x");
      if (x) {
        const d = this.tryDecrypt(Number(tagVal(ev, "epoch")), x);
        if (d) try { Object.assign(info, pick(JSON.parse(d.text))); } catch { /* ignore */ }
      }
      if (tagVal(ev, "p") === this.identity.pk) {
        try {
          const req = JSON.parse(nip44.v2.decrypt(ev.content, nip44.getConversationKey(this.identity.sk, ev.pubkey))) as JoinRequest;
          if (req.bucketId === this.bucketId) Object.assign(info, pick(req));
        } catch { /* ignore */ }
      }
      const old = this.joins.get(ev.pubkey);
      if (!old || (info.tokenSig && !old.tokenSig) || (!!info.tokenSig === !!old.tokenSig && info.createdAt < old.createdAt)) this.joins.set(ev.pubkey, info);
    }
    this.validJoins.clear();
    if (this.roster) {
      const byInvite = new Map<string, JoinInfo[]>();
      for (const j of this.joins.values()) {
        if (!j.inviteId || !j.tokenSig) continue;
        const inv = this.roster.invites.find((i) => i.id === j.inviteId);
        if (!inv || inv.revoked) continue;
        if (inv.expiresAt && j.createdAt > inv.expiresAt) continue;
        if (!verifyTokenProof(inv.tokenPk, this.bucketId, j.pk, j.tokenSig)) continue;
        const l = byInvite.get(inv.id) ?? [];
        l.push(j);
        byInvite.set(inv.id, l);
      }
      for (const [id, list] of byInvite) {
        const inv = this.roster.invites.find((i) => i.id === id)!;
        list.sort((a, b) => a.createdAt - b.createdAt || (a.ev.id < b.ev.id ? -1 : 1));
        if (inv.singleUse) {
          const used = inv.usedBy ?? [];
          const winner = used.length ? list.find((j) => used.includes(j.pk)) : list[0];
          if (winner) this.validJoins.set(winner.pk, winner);
        } else for (const j of list) this.validJoins.set(j.pk, j);
      }
    }

    // who am I acting for?
    if (this.roster?.members.some((m) => m.pk === this.identity.pk) || this.joins.has(this.identity.pk)) this.memberPk = this.identity.pk;
    else {
      this.memberPk = null;
      for (const [member, { devices }] of this.deviceLists) {
        if (devices.some((d) => d.pk === this.identity.pk && !d.revoked)) { this.memberPk = member; break; }
      }
    }
  }

  // ---------- ingest pipeline ----------
  /** Process events from relays/subscriptions/local writes. Returns true if visible state changed. */
  private ingest(events: Event[]): Promise<boolean> {
    return this.mutex.run(() => this._ingest(events));
  }

  private async _ingest(events: Event[]): Promise<boolean> {
    let controlChanged = false;
    const entryEvents: Event[] = [];
    const raw: Event[] = [];
    const ctlRecords: [string, unknown][] = [];
    for (const ev of events) {
      if (ev.kind === KIND_WRAP) {
        if (this.seenWraps.has(ev.id)) continue;
        this.seenWraps.add(ev.id);
        for (const [sk, pk] of this.recipientKeys()) {
          const u = unwrapGrant(ev, sk, pk);
          if (u && u.grant.bucketId === this.bucketId) { if (this.mergeGrant(u.grant, u.sender)) controlChanged = true; }
        }
      } else if (ev.kind === KIND_ROSTER || ev.kind === KIND_DEVICES || ev.kind === KIND_JOIN) {
        if (this.control.has(ev.id) || tagVal(ev, "g") !== this.g) continue;
        if (!verifyEvent(ev)) continue;
        this.control.set(ev.id, ev);
        ctlRecords.push([this.prefix + "c/" + ev.id, ev]);
        raw.push(ev);
        controlChanged = true;
      } else if (ev.kind === KIND_ENTRY || ev.kind === KIND_SNAPSHOT) {
        if (this.seenOuter.has(ev.id) || this.pending.has(ev.id) || tagVal(ev, "g") !== this.g) continue;
        entryEvents.push(ev);
        raw.push(ev);
      }
    }
    if (raw.length) await this.store.putEvents(raw);
    if (controlChanged) this.recomputeControl();

    const touched = new Set<string>();
    const records: [string, unknown][] = [...ctlRecords];
    const run = (list: Event[]) => {
      for (const ev of list) {
        const res = this.processOuter(ev, touched, records);
        if (res === "pending") { if (this.pending.size < MAX_PENDING) this.pending.set(ev.id, ev); }
        else { this.pending.delete(ev.id); this.seenOuter.add(ev.id); }
      }
    };
    // snapshots last so live versions take their outer ids first
    run(entryEvents.filter((e) => e.kind === KIND_ENTRY));
    run(entryEvents.filter((e) => e.kind === KIND_SNAPSHOT));
    if ((controlChanged || touched.size) && this.pending.size) run([...this.pending.values()]);

    for (const id of touched) { const e = this.graph.get(id); if (e) this.index.update(e); }

    let changed = controlChanged || touched.size > 0;
    await this.persist(records);
    if (controlChanged) {
      if (await this.autoConvertJoins()) changed = true;
      await this.rewrapToMyDevices();
    }
    return changed;
  }

  private recipientKeys(): [Uint8Array, Hex][] {
    const out: [Uint8Array, Hex][] = [[this.identity.sk, this.identity.pk]];
    if (this.st.tokenSk) { const sk = hexToBytes(this.st.tokenSk); out.push([sk, getPublicKey(sk)]); }
    return out;
  }

  private mergeGrant(grant: KeyGrant, sender: Hex): boolean {
    let changed = false;
    for (const { n, key } of grant.epochs ?? []) {
      try { if (this.addKey(n, hexToBytes(key))) changed = true; } catch { /* bad hex */ }
    }
    if (grant.rootSecret && !this.st.rootSecret) { this.st.rootSecret = grant.rootSecret; changed = true; }
    const admins = grant.admins ?? [];
    if (!this.st.rootAdmins.length) {
      this.st.rootAdmins = admins.includes(sender) ? [sender] : [...admins];
    } else if (this.st.rootAdmins.includes(sender) || this.st.trusted.includes(sender)) {
      // a trusted admin vouches for the current admin set (rosters are addressable, so history may be gone)
      for (const a of admins) if (!this.st.trusted.includes(a)) this.st.trusted.push(a);
    }
    if (!this.roster) {
      if (!this.name && grant.name) this.name = grant.name;
      if (grant.relays?.length && !this.relays.length) this.relays = grant.relays;
    }
    return changed;
  }

  private processOuter(ev: Event, touched: Set<string>, records: [string, unknown][]): ProcessResult {
    const n = Number(tagVal(ev, "epoch"));
    const nonce = tagVal(ev, "n");
    if (!Number.isInteger(n) || !nonce) return "invalid";
    if (!this.keys.has(n)) return "pending";
    if (!verifyEvent(ev)) return "invalid";
    const d = this.tryDecrypt(n, ev.content, (key) => getPublicKey(ephemeralKey(key, nonce)) === ev.pubkey);
    if (!d) return "pending";
    try {
      if (ev.kind === KIND_ENTRY) return this.processInner(JSON.parse(d.text), n, ev.id, touched, records);
      const snap = JSON.parse(d.text) as { entries: Event[] };
      let anyPending = false;
      for (const inner of snap.entries ?? []) {
        const en = Number(inner.tags?.find((t) => t[0] === "epoch")?.[1] ?? n);
        if (this.processInner(inner, Number.isInteger(en) ? en : n, "snap:" + ev.id, touched, records) === "pending") anyPending = true;
      }
      return anyPending ? "pending" : "ok";
    } catch { return "invalid"; }
  }

  private processInner(inner: Event, epoch: number, outerId: string, touched: Set<string>, records: [string, unknown][]): ProcessResult {
    if (!inner || inner.kind !== KIND_INNER) return "invalid";
    if (this.graph.has(inner.id)) return "dup";
    if (!verifyEvent(inner)) return "invalid";
    let body: EntryBody;
    try { body = JSON.parse(inner.content); } catch { return "invalid"; }
    if (typeof body.entryId !== "string" || inner.tags.find((t) => t[0] === "entry")?.[1] !== body.entryId) return "invalid";
    if (body.type !== "fact" && body.type !== "page") return "invalid";
    const member = this.resolveAuthor(inner.pubkey, inner.created_at);
    if (!member) return "pending";
    if (!this.isValidAuthorAt(member, epoch, inner.created_at)) return this.isRemoved(member) ? "invalid" : "pending";
    const v: EntryVersion = {
      entryId: body.entryId, type: body.type, title: String(body.title ?? ""), body: String(body.body ?? ""),
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [], links: Array.isArray(body.links) ? body.links.map(String) : [],
      source: body.source ?? "human", prev: body.prev, deleted: body.deleted || undefined, merges: body.merges,
      id: inner.id, author: inner.pubkey, authorMember: member, createdAt: inner.created_at, epoch,
    };
    if (v.prev === undefined) delete v.prev;
    if (v.deleted === undefined) delete v.deleted;
    if (v.merges === undefined) delete v.merges;
    this.graph.add(v);
    touched.add(v.entryId);
    const rec: VersionRecord = { o: outerId, i: inner, e: epoch, m: member };
    records.push([this.prefix + "v/" + inner.id, rec]);
    return "ok";
  }

  // ---------- publishing helpers ----------
  private async publish(ev: Event, relays = this.relays) {
    const res = await this.pool.publish(ev, relays);
    if (!res.ok.length) throw new Error(`publish failed on all relays (${res.failed.join(", ")})`);
    return res;
  }
  private async publishAndApply(ev: Event, relays = this.relays) {
    await this.publish(ev, relays);
    await this._ingest([ev]);
  }

  private grantFor(withRoot: boolean): KeyGrant {
    return {
      bucketId: this.bucketId, name: this.name, relays: this.relays, admins: this.admins(),
      epochs: this.allEpochs(), ...(withRoot && this.st.rootSecret ? { rootSecret: this.st.rootSecret } : {}),
    };
  }
  private async sendGrant(recipientPk: Hex, withRoot: boolean) {
    await this.publish(wrapGrant(this.grantFor(withRoot), this.identity.sk, recipientPk));
  }

  private requireAdmin() {
    if (!this.isAdmin()) throw new Error("admin only");
  }

  private async publishRoster(mut: (r: RosterBody) => void, newEpoch?: { n: number; key: Uint8Array }) {
    if (!this.roster) throw new Error("no roster");
    const body: RosterBody = structuredClone(this.roster);
    mut(body);
    const oldRelays = this.relays;
    const created_at = Math.max(now(), this.lastRosterAt + 1);
    if (newEpoch) body.epoch = newEpoch.n;
    body.prev = this.rosterEventId;
    body.updatedAt = created_at;
    const key = newEpoch ? newEpoch.key : this.keyFor(body.epoch);
    const ev = this.identity.sign({
      kind: KIND_ROSTER, created_at,
      tags: [["d", this.rosterD], ["g", this.g], ["epoch", String(body.epoch)]],
      content: symEncrypt(key, JSON.stringify(body)),
    });
    this.lastRosterAt = created_at;
    await this.publishAndApply(ev, [...new Set([...oldRelays, ...body.relays])]);
  }

  // ---------- lifecycle ----------
  static async create(opts: { identity: Identity; name: string; relays?: string[]; pool: RelayPool; store: Store }): Promise<Bucket> {
    const { identity, pool, store } = opts;
    const bucketId = randomHex(16);
    const relays = opts.relays?.length ? opts.relays : [...DEFAULT_RELAYS];
    const st = Bucket.freshState(bucketId, relays, [identity.pk], opts.name);
    st.rootSecret = randomHex(32);
    const b = new Bucket(identity, pool, store, st);
    const key0 = hexToBytes(randomHex(32));
    b.addKey(0, key0);
    const t = now();
    const body: RosterBody = {
      v: 1, bucketId, name: opts.name, epoch: 0, relays,
      members: [{ pk: identity.pk, role: "admin", addedAt: t, addedBy: identity.pk }], invites: [], updatedAt: t, removed: [],
    };
    // wrap to self first so other sessions of this identity can open the bucket
    await b.mutex.run(async () => {
      await pool.publish(wrapGrant({ bucketId, name: opts.name, relays, admins: [identity.pk], epochs: [{ n: 0, key: bytesToHex(key0) }], rootSecret: st.rootSecret }, identity.sk, identity.pk), relays);
      const ev = identity.sign({ kind: KIND_ROSTER, created_at: t, tags: [["d", b.rosterD], ["g", b.g], ["epoch", "0"]], content: symEncrypt(key0, JSON.stringify(body)) });
      b.lastRosterAt = t;
      await b.publishAndApply(ev, relays);
    });
    if (!b.roster) throw new Error("failed to create roster");
    return b;
  }

  static async open(opts: { identity: Identity; bucketId: Hex; pool: RelayPool; store: Store; adminHint?: Hex; relays?: string[]; offline?: boolean }): Promise<Bucket> {
    const { identity, pool, store, bucketId } = opts;
    const b = await Bucket.load(identity, pool, store, bucketId, () =>
      Bucket.freshState(bucketId, opts.relays?.length ? opts.relays : [...DEFAULT_RELAYS], opts.adminHint ? [opts.adminHint] : []));
    if (opts.relays?.length && !b.roster) b.relays = opts.relays;
    if (opts.adminHint && !b.st.rootAdmins.includes(opts.adminHint)) b.st.rootAdmins.push(opts.adminHint);
    if (!opts.offline) {
      try { await b.sync(); } catch (e) { if (!b.keys.size) throw e; }
    }
    if (!b.keys.size) throw new Error("no access: no key grant found for this identity");
    if (!b.roster) throw new Error("bucket roster not found");
    return b;
  }

  static async joinWithInvite(opts: { identity: Identity; link: string; name?: string; pool: RelayPool; store: Store }): Promise<Bucket> {
    const { identity, pool, store } = opts;
    const inv = parseInviteLink(opts.link);
    const relays = inv.relays.length ? inv.relays : [...DEFAULT_RELAYS];
    const b = await Bucket.load(identity, pool, store, inv.bucketId, () => Bucket.freshState(inv.bucketId, relays, [inv.adminPk], inv.name ?? ""));
    if (!b.st.rootAdmins.includes(inv.adminPk)) b.st.rootAdmins.push(inv.adminPk);
    b.st.tokenSk = inv.tokenSk;
    await b.sync();
    if (b.memberPk === identity.pk && b.myRole()) return b; // already in
    const tokenPk = getPublicKey(hexToBytes(inv.tokenSk));
    if (b.lockedOut) throw new Error("invite has been revoked or expired");
    if (!b.keys.size || !b.roster) throw new Error("invite not found (no key grant for this token)");
    const invite = b.roster.invites.find((i) => i.tokenPk === tokenPk);
    if (!invite) throw new Error("invite not found in roster");
    if (invite.revoked) throw new Error("invite has been revoked");
    if (invite.expiresAt && now() > invite.expiresAt) throw new Error("invite has expired");
    if (invite.singleUse && invite.usedBy?.length && !invite.usedBy.includes(identity.pk)) throw new Error("invite already used");
    const req: JoinRequest = { bucketId: b.bucketId, inviteId: invite.id, tokenSig: signTokenProof(inv.tokenSk, b.bucketId, identity.pk), name: opts.name };
    const ep = b.epoch;
    const x = symEncrypt(b.keyFor(ep), JSON.stringify({ inviteId: req.inviteId, tokenSig: req.tokenSig, name: req.name }));
    const ev = identity.sign({
      kind: KIND_JOIN, created_at: now(),
      tags: [["g", b.g], ["p", inv.adminPk], ["epoch", String(ep)], ["x", x]],
      content: nip44.v2.encrypt(JSON.stringify(req), nip44.getConversationKey(identity.sk, inv.adminPk)),
    });
    await b.mutex.run(() => b.publishAndApply(ev));
    if (!b.validJoins.has(identity.pk) && !b.roster?.members.some((m) => m.pk === identity.pk)) {
      throw new Error("invite already used");
    }
    return b;
  }

  static async requestAccess(opts: { identity: Identity; bucketId: Hex; adminPk: Hex; relays: string[]; name?: string; message?: string; pool: RelayPool; store?: Store }): Promise<void> {
    const { identity, bucketId, adminPk } = opts;
    const relays = opts.relays.length ? opts.relays : [...DEFAULT_RELAYS];
    const req: JoinRequest = { bucketId, name: opts.name, message: opts.message };
    const ev = identity.sign({
      kind: KIND_JOIN, created_at: now(),
      tags: [["g", bucketTag(bucketId)], ["p", adminPk]],
      content: nip44.v2.encrypt(JSON.stringify(req), nip44.getConversationKey(identity.sk, adminPk)),
    });
    const res = await opts.pool.publish(ev, relays);
    if (!res.ok.length) throw new Error("publish failed on all relays");
    if (opts.store) {
      const st = Bucket.freshState(bucketId, relays, [adminPk]);
      const existing = await opts.store.get(Bucket.stateKey(identity.pk, bucketId));
      if (!existing) {
        await opts.store.setMany([
          [Bucket.stateKey(identity.pk, bucketId), st],
          [Bucket.summaryKey(identity.pk, bucketId), { bucketId, name: "", role: "pending", relays } satisfies BucketSummary],
        ]);
      }
    }
  }

  /** Lists buckets known in this store. ADDITION: optional identityPk filter. */
  static async listMine(store: Store, identityPk?: Hex): Promise<BucketSummary[]> {
    const rows = await store.list<BucketSummary>(identityPk ? `s/${identityPk}/` : "s/");
    const m = new Map<string, BucketSummary>();
    for (const { value } of rows) {
      const o = m.get(value.bucketId);
      if (!o || (o.role === "pending" && value.role !== "pending")) m.set(value.bucketId, value);
    }
    return [...m.values()];
  }

  // ---------- sync ----------
  async sync(): Promise<void> {
    const recips = this.recipientKeys().map(([, pk]) => pk);
    const s = this.st.lastSync ? Math.max(0, this.st.lastSync - SYNC_OVERLAP) : undefined;
    const ws = this.st.lastWrapSync ? Math.max(0, this.st.lastWrapSync - WRAP_OVERLAP) : undefined;
    const startedAt = now();
    const filters: Filter[] = [
      { kinds: [KIND_WRAP], "#p": recips, ...(ws ? { since: ws } : {}) },
      { kinds: [KIND_ROSTER, KIND_DEVICES], "#g": [this.g] },
      { kinds: [KIND_JOIN, KIND_ENTRY, KIND_SNAPSHOT], "#g": [this.g], ...(s ? { since: s } : {}) },
    ];
    const relaysBefore = this.relays.join(",");
    const events = await this.pool.query(filters, this.relays);
    // wraps first (keys), then control, then entries
    events.sort((a, b) => rank(a.kind) - rank(b.kind));
    await this.ingest(events);
    let maxAt = this.st.lastSync;
    for (const e of events) if (e.kind !== KIND_WRAP && e.created_at <= startedAt + 60) maxAt = Math.max(maxAt, e.created_at);
    this.st.lastSync = maxAt;
    this.st.lastWrapSync = startedAt;
    await this.mutex.run(() => this.persist());
    // relay set changed via roster → pull from new relays too
    if (this.relays.join(",") !== relaysBefore) {
      const more = await this.pool.query(filters.map((f) => ({ ...f, since: undefined })), this.relays);
      more.sort((a, b) => rank(a.kind) - rank(b.kind));
      await this.ingest(more);
    }
  }

  live(onChange: () => void): () => void {
    const recips = this.recipientKeys().map(([, pk]) => pk);
    const t = now();
    const filters: Filter[] = [
      { kinds: [KIND_ENTRY, KIND_SNAPSHOT, KIND_JOIN, KIND_ROSTER, KIND_DEVICES], "#g": [this.g], since: t - 60 },
      { kinds: [KIND_WRAP], "#p": recips, since: t - WRAP_OVERLAP },
    ];
    let buf: Event[] = [];
    let scheduled = false;
    let closed = false;
    const flush = async () => {
      scheduled = false;
      const batch = buf;
      buf = [];
      batch.sort((a, b) => rank(a.kind) - rank(b.kind));
      try { if ((await this.ingest(batch)) && !closed) onChange(); } catch { /* ignore */ }
    };
    const unsub = this.pool.subscribe(filters, this.relays, (ev) => {
      buf.push(ev);
      if (!scheduled) { scheduled = true; setTimeout(flush, 0); }
    });
    return () => { closed = true; unsub(); };
  }

  // ---------- members (admin) ----------
  async createInvite(opts?: { label?: string; singleUse?: boolean; expiresInDays?: number; baseUrl?: string }): Promise<{ invite: Invite; link: string }> {
    return this.mutex.run(async () => {
      this.requireAdmin();
      const tokenSk = randomHex(32);
      const t = now();
      const invite: Invite = {
        id: randomHex(8), tokenPk: getPublicKey(hexToBytes(tokenSk)), createdAt: t, singleUse: opts?.singleUse ?? true,
        ...(opts?.expiresInDays ? { expiresAt: t + Math.round(opts.expiresInDays * 86400) } : {}),
        ...(opts?.label ? { label: opts.label } : {}),
      };
      await this.publishRoster((r) => { r.invites.push(invite); });
      await this.sendGrant(invite.tokenPk, false);
      const link = buildInviteLink({ bucketId: this.bucketId, adminPk: this.identity.pk, relays: this.relays, tokenSk, name: this.name }, opts?.baseUrl);
      return { invite, link };
    });
  }

  async revokeInvite(id: string): Promise<void> {
    return this.mutex.run(async () => {
      this.requireAdmin();
      if (!this.roster!.invites.some((i) => i.id === id)) throw new Error("unknown invite");
      // revoke + rotate so the token holder cannot read future data
      await this._rotate((r) => { const i = r.invites.find((x) => x.id === id); if (i) i.revoked = true; });
    });
  }

  pendingRequests(): JoinRequestView[] {
    if (!this.roster) return [];
    const out: JoinRequestView[] = [];
    for (const j of this.joins.values()) {
      if (this.roster.members.some((m) => m.pk === j.pk)) continue;
      if (this.isRemoved(j.pk) && (this.roster.removed ?? []).some((r) => r.pk === j.pk && r.at >= j.createdAt)) continue;
      out.push({ pk: j.pk, name: j.name, message: j.message, createdAt: j.createdAt, inviteId: j.inviteId, autoAccepted: this.validJoins.has(j.pk) });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async approve(pk: Hex, role: Role = "member"): Promise<void> {
    return this.mutex.run(async () => {
      this.requireAdmin();
      const j = this.joins.get(pk);
      await this.publishRoster((r) => {
        const ex = r.members.find((m) => m.pk === pk);
        if (ex) ex.role = role;
        else r.members.push({ pk, role, addedAt: now(), addedBy: this.identity.pk, ...(j?.name ? { name: j.name } : {}), ...(j?.inviteId && this.validJoins.has(pk) ? { viaInvite: j.inviteId } : {}) });
      });
      await this.sendGrant(pk, role === "admin");
    });
  }

  private async autoConvertJoins(): Promise<boolean> {
    if (!this.isAdmin() || !this.roster) return false;
    const toAdd = [...this.validJoins.values()].filter((j) => !this.roster!.members.some((m) => m.pk === j.pk) && !this.isRemoved(j.pk));
    if (!toAdd.length) return false;
    await this.publishRoster((r) => {
      for (const j of toAdd) {
        r.members.push({ pk: j.pk, role: "member", addedAt: j.createdAt, addedBy: this.identity.pk, viaInvite: j.inviteId, ...(j.name ? { name: j.name } : {}) });
        const inv = r.invites.find((i) => i.id === j.inviteId);
        if (inv) inv.usedBy = [...new Set([...(inv.usedBy ?? []), j.pk])];
      }
    });
    // give converted members a grant to their own identity (so they can open from other devices without the token)
    for (const j of toAdd) { try { await this.sendGrant(j.pk, false); } catch { /* best effort */ } }
    return true;
  }

  async removeMember(pk: Hex): Promise<void> {
    return this.mutex.run(async () => {
      this.requireAdmin();
      if (!this.roster!.members.some((m) => m.pk === pk) && !this.validJoins.has(pk)) throw new Error("not a member");
      if (pk === this.identity.pk && this.admins().length === 1) throw new Error("cannot remove the last admin");
      await this._rotate((r, n) => {
        r.members = r.members.filter((m) => m.pk !== pk);
        r.removed = [...(r.removed ?? []), { pk, epoch: n, at: now() }];
      });
    });
  }

  async setRole(pk: Hex, role: Role): Promise<void> {
    return this.mutex.run(async () => {
      this.requireAdmin();
      const m = this.roster!.members.find((x) => x.pk === pk);
      if (!m) throw new Error("not a member");
      if (m.role === "admin" && role !== "admin" && this.admins().length === 1) throw new Error("cannot demote the last admin");
      await this.publishRoster((r) => { r.members.find((x) => x.pk === pk)!.role = role; });
      if (role === "admin") await this.sendGrant(pk, true);
    });
  }

  async setRelays(relays: string[]): Promise<void> {
    if (!relays.length) throw new Error("at least one relay required");
    return this.mutex.run(async () => {
      this.requireAdmin();
      await this.publishRoster((r) => { r.relays = [...relays]; });
      this.relays = [...relays];
      await this.persist();
    });
  }

  async rotate(): Promise<void> {
    return this.mutex.run(async () => { this.requireAdmin(); await this._rotate(() => {}); });
  }

  /** New epoch: key, wraps to remaining members/devices/live invites, then roster under new key. Caller holds mutex. */
  private async _rotate(mut: (r: RosterBody, newEpoch: number) => void) {
    const n = Math.max(this.epoch, this.maxKeyEpoch()) + 1;
    const key = hexToBytes(randomHex(32));
    const draft: RosterBody = structuredClone(this.roster!);
    mut(draft, n);
    this.addKey(n, key);
    this.confirmed.set(n, key);
    const t = now();
    const memberPks = new Set(draft.members.map((m) => m.pk));
    // invite-joiners not yet converted (and not removed) keep access
    for (const j of this.validJoins.values()) if (!draft.removed?.some((r) => r.pk === j.pk) && !memberPks.has(j.pk)) {
      draft.members.push({ pk: j.pk, role: "member", addedAt: j.createdAt, addedBy: this.identity.pk, viaInvite: j.inviteId, ...(j.name ? { name: j.name } : {}) });
      memberPks.add(j.pk);
      const inv = draft.invites.find((i) => i.id === j.inviteId);
      if (inv) inv.usedBy = [...new Set([...(inv.usedBy ?? []), j.pk])];
    }
    const adminSet = new Set(draft.members.filter((m) => m.role === "admin").map((m) => m.pk));
    const grant = (root: boolean): KeyGrant => ({
      bucketId: this.bucketId, name: draft.name, relays: draft.relays, admins: [...adminSet], epochs: this.allEpochs(),
      ...(root && this.st.rootSecret ? { rootSecret: this.st.rootSecret } : {}),
    });
    const recipients = new Map<Hex, boolean>();
    for (const m of draft.members) recipients.set(m.pk, adminSet.has(m.pk));
    for (const [owner, { devices }] of this.deviceLists) {
      if (!memberPks.has(owner)) continue;
      for (const d of devices) if (!d.revoked && !recipients.has(d.pk)) { recipients.set(d.pk, false); this.st.deviceWrapped[d.pk] = n; }
    }
    for (const inv of draft.invites) {
      if (inv.revoked || (inv.expiresAt && inv.expiresAt < t) || (inv.singleUse && inv.usedBy?.length)) continue;
      if (!recipients.has(inv.tokenPk)) recipients.set(inv.tokenPk, false);
    }
    const relays = [...new Set([...this.relays, ...draft.relays])];
    const g0 = grant(false), g1 = grant(true);
    await Promise.all([...recipients].map(([pk, root]) => this.publish(wrapGrant(root ? g1 : g0, this.identity.sk, pk), relays)));
    await this.publishRoster((r) => { Object.assign(r, draft); }, { n, key });
  }

  async rename(name: string): Promise<void> {
    return this.mutex.run(async () => {
      this.requireAdmin();
      await this.publishRoster((r) => { r.name = name; });
    });
  }

  // ---------- devices ----------
  devices(memberPk?: Hex): DeviceInfo[] {
    const pk = memberPk ?? this.memberPk ?? this.identity.pk;
    return [...(this.deviceLists.get(pk)?.devices ?? [])];
  }

  private async publishDevices(devices: DeviceInfo[]) {
    const created_at = Math.max(now(), this.lastDevicesAt + 1);
    this.lastDevicesAt = created_at;
    const ev = this.identity.sign({
      kind: KIND_DEVICES, created_at,
      tags: [["d", blind(this.loc, "devices/" + this.identity.pk)], ["g", this.g], ["epoch", String(this.epoch)]],
      content: symEncrypt(this.keyFor(this.epoch), JSON.stringify({ devices })),
    });
    await this.publishAndApply(ev);
  }

  private requireMemberIdentity() {
    if (!this.myRole() || this.memberPk !== this.identity.pk) throw new Error("only a member identity (not a device) can manage devices");
  }

  async addDevice(pk: Hex, label: string, kind: "browser" | "agent"): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(pk)) throw new Error("invalid device pubkey");
    return this.mutex.run(async () => {
      this.requireMemberIdentity();
      const list = this.devices().filter((d) => d.pk !== pk);
      list.push({ pk, label, kind, addedAt: now() });
      await this.publishDevices(list);
      await this.sendGrant(pk, false);
      this.st.deviceWrapped[pk] = this.maxKeyEpoch();
      await this.persist();
    });
  }

  async revokeDevice(pk: Hex): Promise<void> {
    return this.mutex.run(async () => {
      this.requireMemberIdentity();
      const t = now();
      const list = this.devices().map((d) => (d.pk === pk ? { ...d, revoked: true, revokedAt: t } : d));
      if (!list.some((d) => d.pk === pk)) throw new Error("unknown device");
      await this.publishDevices(list);
      delete this.st.deviceWrapped[pk];
      if (this.isAdmin()) await this._rotate(() => {});
    });
  }

  private async rewrapToMyDevices() {
    if (this.memberPk !== this.identity.pk || !this.myRole()) return;
    const max = this.maxKeyEpoch();
    const todo = this.devices().filter((d) => !d.revoked && (this.st.deviceWrapped[d.pk] ?? -1) < max);
    if (!todo.length) return;
    const grant = this.grantFor(false);
    for (const d of todo) {
      try { await this.publish(wrapGrant(grant, this.identity.sk, d.pk)); this.st.deviceWrapped[d.pk] = max; } catch { /* retry next time */ }
    }
    await this.persist();
  }

  // ---------- memory ----------
  entries(): Entry[] {
    const out: Entry[] = [];
    for (const e of this.graph.all()) if (!e.head.deleted) out.push(e);
    return out.sort((a, b) => b.head.createdAt - a.head.createdAt);
  }
  /** Returns the entry (also tombstoned ones: check head.deleted). */
  get(entryId: string): Entry | undefined { return this.graph.get(entryId); }

  search(q: string, opts?: { type?: EntryType; tag?: string; source?: "human" | "agent"; limit?: number }): Entry[] {
    const filter = (e: Entry) =>
      !e.head.deleted &&
      (!opts?.type || e.head.type === opts.type) &&
      (!opts?.tag || e.head.tags.includes(opts.tag)) &&
      (!opts?.source || (opts.source === "human" ? e.head.source === "human" : e.head.source.startsWith("agent")));
    let res: Entry[];
    if (!q.trim()) res = this.entries().filter(filter);
    else {
      res = [];
      for (const r of this.index.search(q)) { const e = this.graph.get(r.id); if (e && filter(e)) res.push(e); }
    }
    return opts?.limit ? res.slice(0, opts.limit) : res;
  }

  tags(): { tag: string; count: number }[] {
    const m = new Map<string, number>();
    for (const e of this.graph.all()) if (!e.head.deleted) for (const t of new Set(e.head.tags)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  backlinks(entryId: string): Entry[] {
    return this.entries().filter((e) => e.entryId !== entryId && e.head.links.includes(entryId));
  }

  /** ADDITION: current heads of an entry (≥2 means conflict). */
  heads(entryId: string): EntryVersion[] { return this.graph.heads(entryId); }

  async write(input: { entryId?: string; type: EntryType; title: string; body: string; tags?: string[]; links?: string[]; source?: EntryBody["source"]; prev?: Hex; deleted?: boolean }): Promise<EntryVersion> {
    if (new TextEncoder().encode(input.body).length > MAX_BODY_BYTES) throw new Error(`entry body exceeds ${MAX_BODY_BYTES} bytes`);
    if (input.type !== "fact" && input.type !== "page") throw new Error("invalid entry type");
    return this.mutex.run(async () => {
      if (!this.roster || this.lockedOut) throw new Error("no access to this bucket");
      const member = this.memberPk;
      if (!member || !this.isValidAuthorAt(member, this.epoch, now())) throw new Error("not a member of this bucket");
      const entryId = input.entryId ?? randomHex(12);
      const existing = this.graph.get(entryId);
      let prev = input.prev;
      let merges: Hex[] | undefined;
      if (prev === undefined && existing) {
        const heads = this.graph.heads(entryId);
        prev = existing.head.id;
        const others = heads.filter((h) => h.id !== prev).map((h) => h.id);
        if (others.length) merges = others;
      }
      const body: EntryBody = {
        entryId, type: input.type, title: input.title, body: input.body, tags: [...new Set(input.tags ?? [])], links: [...new Set(input.links ?? [])],
        source: input.source ?? "human", ...(prev ? { prev } : {}), ...(input.deleted ? { deleted: true } : {}), ...(merges ? { merges } : {}),
      };
      const n = this.epoch;
      const key = this.keyFor(n);
      const inner = this.identity.sign({ kind: KIND_INNER, created_at: Math.max(now(), existing ? existing.head.createdAt : 0), tags: [["entry", entryId], ["epoch", String(n)]], content: JSON.stringify(body) });
      const plain = JSON.stringify(inner);
      if (plain.length > 65000) throw new Error("entry too large after encoding");
      const nonce = randomHex(16);
      const outer = finalizeEvent({
        kind: KIND_ENTRY, created_at: now(),
        tags: [["g", this.g], ["e2", blind(this.loc, "entry/" + entryId)], ["epoch", String(n)], ["n", nonce]],
        content: symEncrypt(key, plain),
      }, ephemeralKey(key, nonce));
      await this.publishAndApply(outer);
      const v = this.graph.get(entryId)?.versions.find((x) => x.id === inner.id);
      if (!v) throw new Error("write rejected by local validation");
      return v;
    });
  }

  async remove(entryId: string): Promise<void> {
    const e = this.graph.get(entryId);
    if (!e) throw new Error("unknown entry");
    if (e.head.deleted && !e.conflict) return;
    await this.write({ entryId, type: e.head.type, title: e.head.title, body: "", tags: [], links: [], source: e.head.source, deleted: true });
  }

  exportJSON(): string {
    return JSON.stringify({ bucketId: this.bucketId, name: this.name, exportedAt: now(), entries: this.entries() }, null, 2);
  }

  exportMarkdown(): { path: string; content: string }[] {
    const used = new Set<string>();
    return this.entries().map((e) => {
      const h = e.head;
      let path = `${h.type}s/${slugify(h.title)}.md`;
      if (used.has(path)) path = `${h.type}s/${slugify(h.title)}-${e.entryId.slice(0, 8)}.md`;
      used.add(path);
      const fm = [
        "---",
        `id: ${yamlStr(e.entryId)}`,
        `type: ${h.type}`,
        `title: ${yamlStr(h.title)}`,
        `tags: [${h.tags.map(yamlStr).join(", ")}]`,
        `links: [${h.links.map(yamlStr).join(", ")}]`,
        `source: ${yamlStr(h.source)}`,
        `author: ${yamlStr(h.authorMember)}`,
        `version: ${yamlStr(h.id)}`,
        `updated: ${yamlStr(new Date(h.createdAt * 1000).toISOString())}`,
        `created: ${yamlStr(new Date(e.versions[e.versions.length - 1]!.createdAt * 1000).toISOString())}`,
        ...(e.conflict ? ["conflict: true"] : []),
        "---",
        "",
      ].join("\n");
      return { path, content: fm + h.body + (h.body.endsWith("\n") ? "" : "\n") };
    });
  }

  /** Publishes the current heads (all entries incl. tombstones) as one or more kind 4452 chunks. */
  async snapshot(): Promise<void> {
    return this.mutex.run(async () => {
      if (!this.myRole()) throw new Error("no access");
      const inners: Event[] = [];
      for (const id of [...this.graph.entryIds()]) {
        for (const h of this.graph.heads(id)) {
          const rec = await this.store.get<VersionRecord>(this.prefix + "v/" + h.id);
          if (rec) inners.push(rec.i);
        }
      }
      const chunks: Event[][] = [];
      let cur: Event[] = [], size = 0;
      for (const ev of inners) {
        const s = JSON.stringify(ev).length + 1;
        if (cur.length && size + s > SNAPSHOT_CHUNK) { chunks.push(cur); cur = []; size = 0; }
        cur.push(ev); size += s;
      }
      if (cur.length) chunks.push(cur);
      const n = this.epoch, key = this.keyFor(n), snapId = randomHex(8), upTo = now();
      for (let i = 0; i < chunks.length; i++) {
        const nonce = randomHex(16);
        const ev = finalizeEvent({
          kind: KIND_SNAPSHOT, created_at: upTo,
          tags: [["g", this.g], ["epoch", String(n)], ["n", nonce], ["snap", snapId, String(i), String(chunks.length)]],
          content: symEncrypt(key, JSON.stringify({ entries: chunks[i], upTo })),
        }, ephemeralKey(key, nonce));
        await this.publish(ev);
        this.seenOuter.add(ev.id);
      }
    });
  }
}

function rank(kind: number) {
  return kind === KIND_WRAP ? 0 : kind === KIND_ROSTER ? 1 : kind === KIND_DEVICES ? 2 : kind === KIND_JOIN ? 3 : 4;
}
function pick(o: any): Partial<JoinInfo> {
  const out: Partial<JoinInfo> = {};
  if (typeof o?.inviteId === "string") out.inviteId = o.inviteId;
  if (typeof o?.tokenSig === "string") out.tokenSig = o.tokenSig;
  if (typeof o?.name === "string") out.name = o.name;
  if (typeof o?.message === "string") out.message = o.message;
  return out;
}

/** @internal test/perf hooks */
export const __internal = {
  versionKey: (identityPk: Hex, bucketId: Hex, innerId: Hex) => `b/${identityPk}/${bucketId}/v/${innerId}`,
};
