import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Shell } from "../components/Shell";
import { Empty, Skeleton, useAction, useDebounced } from "../components/ui";
import { ISearch, IPlus, IBranch, IAlert } from "../components/icons";
import type { Bucket, Entry, EntryType } from "../lib/core";
import { MAX_BODY_BYTES, joinStatusOf } from "../lib/core";
import { useBucket } from "../lib/state";
import { excerpt, stripTitle } from "../lib/markdown";
import { ago, byteLen, plural } from "../lib/format";
import { byline, isAgent } from "../lib/members";
import { entryPath, bucketPath } from "../lib/router";
import { BucketGate } from "./BucketGate";

const WINDOW = 100;

export function Knowledge({ bucketId }: { bucketId: string }) {
  const { bucket, error } = useBucket(bucketId);
  return (
    <Shell bucket={bucket} tab="knowledge">
      <BucketGate bucket={bucket} error={error}>{bucket && <Feed bucket={bucket} />}</BucketGate>
    </Shell>
  );
}

type Filters = { type: EntryType | "all"; tag: string | null; source: "all" | "human" | "agent"; conflicts: boolean };
const FKEY = "tribe.filters";
const loadFilters = (): Filters => {
  try { return { type: "all", tag: null, source: "all", conflicts: false, ...JSON.parse(sessionStorage.getItem(FKEY) ?? "{}") }; }
  catch { return { type: "all", tag: null, source: "all", conflicts: false }; }
};

function Feed({ bucket }: { bucket: Bucket }) {
  const [q, setQ] = useState(() => { try { return sessionStorage.getItem("tribe.q") ?? ""; } catch { return ""; } });
  const [f, setF] = useState<Filters>(loadFilters);
  const [shown, setShown] = useState(WINDOW);
  const dq = useDebounced(q.trim(), 200);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => { try { sessionStorage.setItem(FKEY, JSON.stringify(f)); sessionStorage.setItem("tribe.q", q); } catch {} }, [f, q]);
  useEffect(() => setShown(WINDOW), [dq, f]);

  const all = bucket.entries();
  const tags = useMemo(() => { try { return bucket.tags().slice(0, 40); } catch { return []; } }, [all]);
  const conflictCount = all.filter((e) => e.conflict && !e.head.deleted).length;

  const results = useMemo(() => {
    let list: Entry[];
    if (dq) {
      list = bucket.search(dq, {
        type: f.type === "all" ? undefined : f.type, tag: f.tag ?? undefined,
        source: f.source === "all" ? undefined : f.source, limit: 50_000,
      });
    } else {
      list = [...all].sort((a, b) => b.head.createdAt - a.head.createdAt);
    }
    return list.filter((e) =>
      !e.head.deleted &&
      (f.type === "all" || e.head.type === f.type) &&
      (!f.tag || e.head.tags.includes(f.tag)) &&
      (f.source === "all" || (f.source === "agent") === isAgent(e.head)) &&
      (!f.conflicts || e.conflict));
  }, [all, dq, f]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((xs) => { if (xs.some((x) => x.isIntersecting)) setShown((n) => n + WINDOW); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [results.length > shown]);

  const set = (p: Partial<Filters>) => setF({ ...f, ...p });
  const anyFilter = f.type !== "all" || f.tag || f.source !== "all" || f.conflicts || dq;

  const js = joinStatusOf(bucket);
  return (
    <>
      {js?.status === "pending" && (
        <div class="banner indigo" role="status"><IAlert /><div><b>Waiting for an admin to confirm your invite</b><p class="small muted" style={{ margin: "4px 0 0" }}>Your join request was sent. Entries appear here once an admin approves it and shares the bucket key with you. Keep this tab open or come back later.</p></div></div>
      )}
      {js?.status === "rejected" && (
        <div class="banner rust" role="alert"><IAlert /><div><b>Your join request was declined</b><p class="small muted" style={{ margin: "4px 0 0" }}>{js.reason ? `${js.reason}. ` : ""}An admin declined the request, or the invite was revoked, expired or already used. Ask an admin for a new invite link.</p></div></div>
      )}
      <Composer bucket={bucket} />
      <div class="search">
        <ISearch />
        <input class="input" type="search" placeholder={`Search ${plural(all.filter((e) => !e.head.deleted).length, "entry", "entries")}`} value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Search knowledge" />
      </div>
      <div class="filters">
        <div class="seg" role="group" aria-label="Type">
          {(["all", "fact", "page"] as const).map((t) => <button aria-pressed={f.type === t} onClick={() => set({ type: t })}>{t === "all" ? "All" : t === "fact" ? "Facts" : "Pages"}</button>)}
        </div>
        <div class="seg" role="group" aria-label="Source">
          {(["all", "human", "agent"] as const).map((s) => <button aria-pressed={f.source === s} onClick={() => set({ source: s })}>{s === "all" ? "Anyone" : s === "human" ? "People" : "Agents"}</button>)}
        </div>
        {conflictCount > 0 && (
          <button class="chip toggle-chip" aria-pressed={f.conflicts} onClick={() => set({ conflicts: !f.conflicts })}>
            {plural(conflictCount, "conflict")}
          </button>
        )}
      </div>
      {tags.length > 0 && (
        <div class="chips" role="group" aria-label="Tags">
          {tags.map((t) => (
            <button class="chip" aria-pressed={f.tag === t.tag} onClick={() => set({ tag: f.tag === t.tag ? null : t.tag })}>#{t.tag}<span class="n">{t.count}</span></button>
          ))}
        </div>
      )}
      <div class="feed-meta">
        <span>{dq ? `${plural(results.length, "match", "matches")} for “${dq}”` : anyFilter ? plural(results.length, "entry", "entries") : "Most recent first"}</span>
        {anyFilter && <button class="btn ghost sm" onClick={() => { setQ(""); setF({ type: "all", tag: null, source: "all", conflicts: false }); }}>Clear filters</button>}
      </div>
      {results.length === 0 ? (
        all.length === 0 ? (
          <div class="panel"><Empty title="Nothing here yet">Add the first fact above: a convention, a gotcha, the reason behind a decision. Agents paired to this bucket can add facts too.</Empty></div>
        ) : <div class="panel"><Empty title="No matches">Try fewer words, or clear the filters.</Empty></div>
      ) : (
        <div class="entries">
          {results.slice(0, shown).map((e) => <EntryCard key={e.entryId} bucket={bucket} e={e} />)}
          {results.length > shown && <div ref={sentinel}><button class="btn block" onClick={() => setShown(shown + WINDOW)}>Show {Math.min(WINDOW, results.length - shown)} more</button></div>}
        </div>
      )}
    </>
  );
}

function EntryCard({ bucket, e }: { bucket: Bucket; e: Entry }) {
  const h = e.head;
  const agent = isAgent(h);
  return (
    <a class={`entry-card ${agent ? "agent" : ""} ${e.conflict ? "conflict" : ""}`} href={entryPath(bucket.bucketId, e.entryId)}>
      <h3>{h.title || "Untitled"}</h3>
      <p class="ex">{excerpt(stripTitle(h.body, h.title))}</p>
      <div class="meta">
        <span class="kind">{h.type === "page" ? `Page · ${plural(h.links.length, "link")}` : "Fact"}</span>
        <span class={`prov ${agent ? "agent" : ""}`}><i />{byline(bucket, h)}</span>
        <span>{ago(h.createdAt)}</span>
        {e.versions.length > 1 && <span>v{e.versions.length}</span>}
        {e.conflict && <span class="badge amber"><IBranch size={12} />Conflict</span>}
        {h.tags.slice(0, 4).map((t) => <span class="tag">#{t}</span>)}
      </div>
    </a>
  );
}

function Composer({ bucket }: { bucket: Bucket }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const { busy, run } = useAction();
  const over = byteLen(body) > MAX_BODY_BYTES;
  if (!open) return (
    <div class="composer">
      <button class="composer-closed" onClick={() => setOpen(true)}><IPlus size={16} />Add a fact the team should know…</button>
    </div>
  );
  const submit = () => run(async () => {
    await bucket.write({ type: "fact", title: title.trim(), body, tags: tags.split(/[,\s]+/).map((t) => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean), source: "human" });
    setTitle(""); setBody(""); setTags(""); setOpen(false);
  }, "Fact added");
  return (
    <form class="composer composer-open" onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && title.trim() && !over) void submit(); }}>
      <input class="input title" autoFocus placeholder="One-line fact, e.g. “Staging resets every Sunday 02:00 UTC”" value={title} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Title" maxLength={200} />
      <textarea class="textarea" placeholder="Details, context, the why (Markdown)" value={body} onInput={(e) => setBody(e.currentTarget.value)} aria-label="Body" />
      <input class="input" placeholder="Tags, comma separated" value={tags} onInput={(e) => setTags(e.currentTarget.value)} aria-label="Tags" />
      <div class="spread">
        <span class={`byte-count ${over ? "over" : ""}`}>{over ? "Too long: 60 KB max" : "⌘/Ctrl + Enter to save"}</span>
        <div class="row">
          <a class="btn ghost hide-sm" href={bucketPath(bucket.bucketId, "/new/page")}>Write a page instead</a>
          <button type="button" class="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button class="btn primary" disabled={!title.trim() || over || busy}>{busy ? "Saving…" : "Add fact"}</button>
        </div>
      </div>
    </form>
  );
}

export { Skeleton };
