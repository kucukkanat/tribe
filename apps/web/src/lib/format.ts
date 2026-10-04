import { npubEncode } from "./bech32";

export function ago(unixSec: number): string {
  const d = Math.max(0, Date.now() / 1000 - unixSec);
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 14) return `${Math.round(d / 86400)} d ago`;
  return new Date(unixSec * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
export const fullDate = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function shortNpub(pk: string): string {
  try { const n = npubEncode(pk); return n.slice(0, 10) + "…" + n.slice(-6); }
  catch { return pk.slice(0, 8) + "…"; }
}
export const shortId = (id: string) => (id.length > 14 ? id.slice(0, 6) + "…" + id.slice(-4) : id);

export async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  }
}

export function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bucket";
export const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const byteLen = (s: string) => new TextEncoder().encode(s).length;
