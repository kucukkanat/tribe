import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import type { Hex } from "./types.ts";
import { hexToBytes } from "./crypto.ts";

export class Identity {
  readonly sk: Uint8Array;
  readonly pk: Hex;
  private constructor(sk: Uint8Array) {
    this.sk = sk;
    this.pk = getPublicKey(sk);
  }
  static generate(): Identity { return new Identity(generateSecretKey()); }
  static fromSecret(sk: Uint8Array): Identity { return new Identity(new Uint8Array(sk)); }
  /** ADDITION: accepts nsec or 64-char hex. */
  static fromString(s: string): Identity {
    s = s.trim();
    if (s.startsWith("nsec")) {
      const d = nip19.decode(s);
      if (d.type !== "nsec") throw new Error("not an nsec");
      return new Identity(d.data as Uint8Array);
    }
    return new Identity(hexToBytes(s));
  }
  /** ADDITION: parse an npub or 64-char hex pubkey to hex. */
  static parsePubkey(s: string): Hex {
    s = s.trim();
    if (s.startsWith("npub")) {
      const d = nip19.decode(s);
      if (d.type !== "npub") throw new Error("not an npub");
      return d.data as string;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error("invalid pubkey");
    return s.toLowerCase();
  }
  npub(): string { return nip19.npubEncode(this.pk); }
  nsec(): string { return nip19.nsecEncode(this.sk); }
  sign(t: EventTemplate): VerifiedEvent { return finalizeEvent(t, this.sk); }
}
