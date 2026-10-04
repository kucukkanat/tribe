import { describe, expect, test } from "bun:test";
import { blind, hkdf32, randomHex, symDecrypt, symEncrypt, hexToBytes, Identity, wrapGrant, unwrapGrant, parseInviteLink, buildInviteLink, signTokenProof, verifyTokenProof } from "../src/index.ts";

describe("crypto", () => {
  test("sym roundtrip", () => {
    const k = hexToBytes(randomHex(32));
    const c = symEncrypt(k, "hello ✓");
    expect(symDecrypt(k, c)).toBe("hello ✓");
    expect(() => symDecrypt(hexToBytes(randomHex(32)), c)).toThrow();
  });
  test("hkdf + blind deterministic", () => {
    const k = hexToBytes("11".repeat(32));
    expect(hkdf32(k, "x")).toEqual(hkdf32(k, "x"));
    expect(hkdf32(k, "x")).not.toEqual(hkdf32(k, "y"));
    expect(blind(k, "a")).toMatch(/^[0-9a-f]{64}$/);
  });
  test("grant wrap/unwrap", () => {
    const a = Identity.generate(), b = Identity.generate(), c = Identity.generate();
    const w = wrapGrant({ bucketId: "ab", name: "n", relays: [], admins: [a.pk], epochs: [{ n: 0, key: "00".repeat(32) }] }, a.sk, b.pk);
    const u = unwrapGrant(w, b.sk, b.pk)!;
    expect(u.sender).toBe(a.pk);
    expect(u.grant.epochs[0]!.n).toBe(0);
    expect(unwrapGrant(w, c.sk, c.pk)).toBeNull();
  });
  test("invite link roundtrip + token proof", () => {
    const tokenSk = randomHex(32), admin = Identity.generate();
    const link = buildInviteLink({ bucketId: "b1", adminPk: admin.pk, relays: ["wss://x"], tokenSk, name: "Team ü" }, "https://x.github.io/tribe/");
    expect(link.startsWith("https://x.github.io/tribe/#/join/")).toBe(true);
    const p = parseInviteLink(link);
    expect(p).toEqual({ bucketId: "b1", adminPk: admin.pk, relays: ["wss://x"], tokenSk, name: "Team ü" });
    expect(parseInviteLink(link.split("#/join/")[1]!).tokenSk).toBe(tokenSk);
    expect(() => parseInviteLink("garbage")).toThrow();
    const j = Identity.generate();
    const sig = signTokenProof(tokenSk, "b1", j.pk);
    const tokenPk = Identity.fromSecret(hexToBytes(tokenSk)).pk;
    expect(verifyTokenProof(tokenPk, "b1", j.pk, sig)).toBe(true);
    expect(verifyTokenProof(tokenPk, "b1", admin.pk, sig)).toBe(false);
  });
  test("identity", () => {
    const i = Identity.generate();
    expect(Identity.fromString(i.nsec()).pk).toBe(i.pk);
    expect(i.npub().startsWith("npub")).toBe(true);
    const ev = i.sign({ kind: 1, created_at: 1, tags: [], content: "x" });
    expect(ev.pubkey).toBe(i.pk);
  });
});
