// Local identity keystore (IndexedDB) with optional WebAuthn-PRF wrapping.
import { toHex, fromHex } from "./bech32";
import { Identity } from "./core";

export type KeyRecord =
  | { kind: "local"; pk: string; sk: string; createdAt: number }
  | { kind: "passkey"; pk: string; credId: string; salt: string; iv: string; wrapped: string; createdAt: number; /** v2: pk bound as AES-GCM AAD */ aad?: 1 };

const DB = "tribe-keystore";
const STORE = "kv";
const KEY = "identity";

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function loadRecord(): Promise<KeyRecord | null> {
  try { return ((await tx("readonly", (s) => s.get(KEY))) as KeyRecord | undefined) ?? null; }
  catch { return null; }
}
export const saveRecord = (r: KeyRecord) => tx("readwrite", (s) => s.put(r, KEY)).then(() => undefined);
export const clearRecord = () => tx("readwrite", (s) => s.delete(KEY)).then(() => undefined);

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);

export const passkeySupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

export class PrfUnsupportedError extends Error {
  constructor() { super("This passkey or browser does not support the PRF extension."); }
}

async function wrappingKey(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("tribe/keywrap/v1") },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

async function prfEval(credId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: buf(credId) }],
      userVerification: "required",
      extensions: { prf: { eval: { first: buf(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey prompt was dismissed.");
  const out = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!out) throw new PrfUnsupportedError();
  return out;
}

/** Create a passkey and wrap `sk` with a key derived from its PRF output. */
export async function protectWithPasskey(sk: Uint8Array, pk: string, label: string): Promise<KeyRecord> {
  if (!passkeySupported()) throw new PrfUnsupportedError();
  const salt = rand(32);
  const cred = (await navigator.credentials.create({
    publicKey: {
      // Pin the RP ID to this exact host (not a registrable parent domain).
      rp: { name: "Tribe", id: location.hostname },
      user: { id: rand(16), name: label, displayName: label },
      challenge: rand(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey creation was cancelled.");
  const ext = (cred.getClientExtensionResults() as PrfResults).prf;
  if (!ext || ext.enabled === false) throw new PrfUnsupportedError();
  const credId = new Uint8Array(cred.rawId);
  // Some authenticators only return PRF output on assertion, not on creation.
  const out = ext.results?.first ?? (await prfEval(credId, salt));
  const key = await wrappingKey(out);
  const iv = rand(12);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadFor(pk) }, key, buf(sk));
  return { kind: "passkey", pk, credId: b64(credId), salt: b64(salt), iv: b64(iv), wrapped: b64(wrapped), createdAt: Date.now(), aad: 1 };
}

const aadFor = (pk: string) => new TextEncoder().encode(`tribe/keywrap/v1|${pk.toLowerCase()}`);

/**
 * Unwrap the secret key. The record's pk is bound as AES-GCM additional data, and the
 * derived pubkey must equal the stored pk. Legacy records (no AAD) are accepted once and
 * re-wrapped with AAD; the upgraded record is returned so the caller can persist it.
 */
export async function unlockWithPasskey(r: Extract<KeyRecord, { kind: "passkey" }>): Promise<{ sk: Uint8Array; upgraded?: KeyRecord }> {
  const out = await prfEval(unb64(r.credId), unb64(r.salt));
  const key = await wrappingKey(out);
  const iv = unb64(r.iv);
  const ct = unb64(r.wrapped);
  let sk: Uint8Array | null = null;
  let legacy = false;
  try { sk = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aadFor(r.pk) }, key, ct)); }
  catch {
    if (r.aad) throw new Error("This passkey does not unlock the stored key.");
    try { sk = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct)); legacy = true; }
    catch { throw new Error("This passkey does not unlock the stored key."); }
  }
  let derived: string;
  try { derived = Identity.fromSecret(sk).pk; } catch { throw new Error("The stored key is corrupted."); }
  if (derived.toLowerCase() !== r.pk.toLowerCase()) throw new Error("The unlocked key does not match the stored identity. The key store may have been tampered with.");
  if (!legacy) return { sk };
  const niv = rand(12);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: niv, additionalData: aadFor(r.pk) }, key, buf(sk));
  return { sk, upgraded: { ...r, iv: b64(niv), wrapped: b64(wrapped), aad: 1 } };
}

export const localRecord = (sk: Uint8Array, pk: string): KeyRecord => ({ kind: "local", pk, sk: toHex(sk), createdAt: Date.now() });
export const localSecret = (r: Extract<KeyRecord, { kind: "local" }>) => fromHex(r.sk);
