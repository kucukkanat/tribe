import { nip44 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

export { bytesToHex, hexToBytes, randomBytes };

export function symEncrypt(key32: Uint8Array, plaintext: string): string {
  return nip44.v2.encrypt(plaintext, key32);
}
export function symDecrypt(key32: Uint8Array, payload: string): string {
  return nip44.v2.decrypt(payload, key32);
}
export function hkdf32(ikm: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, ikm, new Uint8Array(0), utf8ToBytes(info), 32);
}
export function blind(key32: Uint8Array, label: string): string {
  return bytesToHex(hmac(sha256, key32, utf8ToBytes(label)));
}
export function sha256Hex(s: string | Uint8Array): string {
  return bytesToHex(sha256(typeof s === "string" ? utf8ToBytes(s) : s));
}
export function randomHex(n: number): string {
  return bytesToHex(randomBytes(n));
}
export function locatorKey(bucketId: string): Uint8Array {
  return hkdf32(sha256(utf8ToBytes(bucketId)), "tribe/locator");
}
export function bucketTag(bucketId: string): string {
  return blind(locatorKey(bucketId), "bucket");
}
export function ephemeralKey(epochKey: Uint8Array, nonceHex: string): Uint8Array {
  return hkdf32(epochKey, "tribe/eph/" + nonceHex);
}
export function b64urlEncode(s: string): string {
  const bytes = utf8ToBytes(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
