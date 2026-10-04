// Minimal bech32 (BIP-173) for npub/nsec <-> hex, so the web app does not
// depend on nostr-tools directly.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}
const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convert(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & maxv))) throw new Error("Invalid padding");
  return out;
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convert([...bytes], 8, 5, true);
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (chk >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}

export function bech32Decode(str: string): { hrp: string; bytes: Uint8Array } {
  const s = str.trim().toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1) throw new Error("Not a bech32 string");
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error("Invalid character");
    return i;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("Checksum mismatch");
  return { hrp, bytes: new Uint8Array(convert(data.slice(0, -6), 5, 8, false)) };
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(h: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(h) || h.length % 2) throw new Error("Invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const npubEncode = (pkHex: string) => bech32Encode("npub", fromHex(pkHex));

/** Accepts npub1… or 64-char hex; returns hex pubkey. */
export function parsePubkey(input: string): string {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  const { hrp, bytes } = bech32Decode(s);
  if (hrp !== "npub" || bytes.length !== 32) throw new Error("Expected an npub");
  return toHex(bytes);
}

/** Accepts nsec1… or 64-char hex; returns 32 secret bytes. */
export function parseSecret(input: string): Uint8Array {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return fromHex(s);
  const { hrp, bytes } = bech32Decode(s);
  if (hrp !== "nsec" || bytes.length !== 32) throw new Error("Expected an nsec");
  return bytes;
}
