import { useEffect, useState } from "preact/hooks";

export type Route =
  | { name: "home" }
  | { name: "welcome" }
  | { name: "buckets" }
  | { name: "create" }
  | { name: "join"; blob: string }
  | { name: "knowledge"; bucketId: string }
  | { name: "entry"; bucketId: string; entryId: string }
  | { name: "edit"; bucketId: string; entryId: string }
  | { name: "new"; bucketId: string; type: "fact" | "page" }
  | { name: "members"; bucketId: string }
  | { name: "devices"; bucketId: string }
  | { name: "settings"; bucketId: string }
  | { name: "notfound" };

// The invite blob carries a secret token. Keep it in memory only and strip it from the
// URL immediately so it never lingers in history, bookmarks or screenshots of the address bar.
let inviteBlob = "";
function captureInvite(): void {
  const h = location.hash.replace(/^#/, "");
  if (!h.startsWith("/join/") || h.length <= 6) return;
  inviteBlob = h.slice(6);
  const url = new URL(location.href);
  url.hash = "#/join";
  history.replaceState(history.state, "", url.toString());
}

/** Forget the in-memory invite token (after a successful join). */
export function forgetInvite(): void { inviteBlob = ""; }

export function parse(hash: string): Route {
  const h = hash.replace(/^#/, "") || "/";
  if (h === "/join" || h.startsWith("/join/")) return { name: "join", blob: h.length > 6 ? h.slice(6) : inviteBlob };
  const p = h.split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
  if (p.length === 0) return { name: "home" };
  if (p[0] === "welcome") return { name: "welcome" };
  if (p[0] === "buckets") return { name: "buckets" };
  if (p[0] === "create") return { name: "create" };
  if (p[0] === "b" && p[1]) {
    const bucketId = p[1];
    if (!p[2]) return { name: "knowledge", bucketId };
    if (p[2] === "e" && p[3]) return p[4] === "edit" ? { name: "edit", bucketId, entryId: p[3] } : { name: "entry", bucketId, entryId: p[3] };
    if (p[2] === "new") return { name: "new", bucketId, type: p[3] === "page" ? "page" : "fact" };
    if (p[2] === "members") return { name: "members", bucketId };
    if (p[2] === "devices") return { name: "devices", bucketId };
    if (p[2] === "settings") return { name: "settings", bucketId };
  }
  return { name: "notfound" };
}

export const go = (path: string) => { location.hash = path; };
export const bucketPath = (id: string, rest = "") => `#/b/${id}${rest}`;
export const entryPath = (bid: string, eid: string) => `#/b/${bid}/e/${encodeURIComponent(eid)}`;

export function useRoute(): Route {
  const [r, set] = useState(() => { captureInvite(); return parse(location.hash); });
  useEffect(() => {
    const on = () => { captureInvite(); set(parse(location.hash)); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return r;
}
