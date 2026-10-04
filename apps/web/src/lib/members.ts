import type { Bucket, Entry, EntryVersion } from "./core";
import { shortNpub } from "./format";

// Display names not carried by the roster (e.g. a bucket creator has none).
const LOCAL_NAMES_KEY = "tribe.names";
const localNames = new Map<string, string>();
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(LOCAL_NAMES_KEY) ?? "{}"))) localNames.set(k, String(v)); } catch {}
export function setLocalName(pk: string, name: string, persist = false) {
  localNames.set(pk, name);
  if (persist) try { localStorage.setItem(LOCAL_NAMES_KEY, JSON.stringify(Object.fromEntries(localNames))); } catch {}
}
export const localName = (pk: string) => localNames.get(pk);

export function memberName(b: Bucket, pk: string): string {
  const m = b.roster?.members.find((x) => x.pk === pk);
  return m?.name || localNames.get(pk) || shortNpub(pk);
}
export const isAgent = (v: EntryVersion) => v.source !== "human";
export const agentLabel = (v: EntryVersion) => (v.source.startsWith("agent:") ? v.source.slice(6) : "agent");

export function byline(b: Bucket, v: EntryVersion): string {
  const who = memberName(b, v.authorMember);
  return isAgent(v) ? `${agentLabel(v)} for ${who}` : who;
}
export const live = (es: Entry[]) => es.filter((e) => !e.head.deleted);
