import { useMemo, useState } from "preact/hooks";
import { Shell } from "../components/Shell";
import { Empty, useAction, useDebounced } from "../components/ui";
import { IX, ISearch, IBack } from "../components/icons";
import type { Bucket, EntryType } from "../lib/core";
import { MAX_BODY_BYTES } from "../lib/core";
import { useBucket } from "../lib/state";
import { renderMarkdown } from "../lib/markdown";
import { byteLen } from "../lib/format";
import { bucketPath, entryPath, go } from "../lib/router";
import { BucketGate } from "./BucketGate";

export function EditorScreen({ bucketId, entryId, type }: { bucketId: string; entryId?: string; type?: EntryType }) {
  const { bucket, error } = useBucket(bucketId);
  return (
    <Shell bucket={bucket} tab="knowledge" wide>
      <BucketGate bucket={bucket} error={error}>{bucket && <Editor bucket={bucket} entryId={entryId} newType={type ?? "fact"} />}</BucketGate>
    </Shell>
  );
}

function Editor({ bucket, entryId, newType }: { bucket: Bucket; entryId?: string; newType: EntryType }) {
  const existing = entryId ? bucket.get(entryId) : undefined;
  const h = existing?.head;
  const [type, setType] = useState<EntryType>(h?.type ?? newType);
  const [title, setTitle] = useState(h?.title ?? "");
  const [body, setBody] = useState(h?.body ?? "");
  const [tags, setTags] = useState<string[]>(h?.tags ?? []);
  const [links, setLinks] = useState<string[]>(h?.links ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const { busy, run } = useAction();
  const preview = useDebounced(body, 150);
  const html = useMemo(() => renderMarkdown(preview), [preview]);
  const bytes = byteLen(body);
  const over = bytes > MAX_BODY_BYTES;

  if (entryId && !existing) return <div class="panel"><Empty title="Entry not found" /></div>;

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, "").toLowerCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft("");
  };
  const save = () => run(async () => {
    const v = await bucket.write({
      entryId, type, title: title.trim(), body, tags, links: type === "page" ? links : [], source: "human",
      // If nobody else wrote meanwhile, let core pick prev (and merge any open conflict heads);
      // otherwise pin prev to the version we edited so a concurrent edit surfaces as a conflict.
      prev: h && bucket.get(h.entryId)?.head.id !== h.id ? h.id : undefined,
    });
    go(entryPath(bucket.bucketId, v.entryId).slice(1));
  }, entryId ? "Saved new version" : type === "page" ? "Page created" : "Fact added");

  const back = entryId ? entryPath(bucket.bucketId, entryId) : bucketPath(bucket.bucketId);
  return (
    <form class="editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div class="crumbs"><a href={back}><IBack size={14} style={{ verticalAlign: "-2px" }} /> {entryId ? "Back to entry" : "Knowledge"}</a></div>
      <div class="spread">
        <h1>{entryId ? "Edit" : type === "page" ? "New page" : "New fact"}</h1>
        {!entryId && (
          <div class="seg" role="group" aria-label="Type">
            <button type="button" aria-pressed={type === "fact"} onClick={() => setType("fact")}>Fact</button>
            <button type="button" aria-pressed={type === "page"} onClick={() => setType("page")}>Page</button>
          </div>
        )}
      </div>
      <input class="input title-input" placeholder={type === "page" ? "Page title" : "The fact, in one line"} value={title} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Title" maxLength={200} />
      <div class="spread show-sm">
        <div class="seg tabs-mini" role="group" aria-label="View">
          <button type="button" aria-pressed={pane === "edit"} onClick={() => setPane("edit")}>Write</button>
          <button type="button" aria-pressed={pane === "preview"} onClick={() => setPane("preview")}>Preview</button>
        </div>
      </div>
      <div class={`split show-${pane}`}>
        <div class="textarea-wrap"><textarea class="textarea code" value={body} onInput={(e) => setBody(e.currentTarget.value)} placeholder="Markdown supported" aria-label="Body" /></div>
        <div class="preview prose" aria-label="Preview" dangerouslySetInnerHTML={{ __html: html || '<p class="muted">Preview appears here.</p>' }} />
      </div>
      <div class={`byte-count ${over ? "over" : ""}`}>{(bytes / 1024).toFixed(1)} KB of 60 KB{over && " — shorten the body or split it into several facts"}</div>
      <label class="field"><span>Tags</span>
        <div class="tag-input">
          {tags.map((t) => <span class="chip">#{t}<button type="button" aria-label={`Remove ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}><IX size={12} /></button></span>)}
          <input value={tagDraft} placeholder={tags.length ? "" : "Type a tag and press Enter"} onInput={(e) => setTagDraft(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(tagDraft); } else if (e.key === "Backspace" && !tagDraft && tags.length) setTags(tags.slice(0, -1)); }}
            onBlur={() => tagDraft && addTag(tagDraft)} list="tag-suggest" />
          <datalist id="tag-suggest">{(() => { try { return bucket.tags().slice(0, 50).map((t) => <option value={t.tag} />); } catch { return null; } })()}</datalist>
        </div>
      </label>
      {type === "page" && <LinkPicker bucket={bucket} selfId={entryId} links={links} setLinks={setLinks} />}
      <div class="row editor-actions" style={{ justifyContent: "flex-end", position: "sticky", bottom: 0, padding: "12px 0", background: "var(--paper)" }}>
        <a class="btn" href={back}>Cancel</a>
        <button class="btn primary" disabled={!title.trim() || over || busy}>{busy ? "Saving…" : entryId ? "Save new version" : type === "page" ? "Create page" : "Add fact"}</button>
      </div>
    </form>
  );
}

function LinkPicker({ bucket, selfId, links, setLinks }: { bucket: Bucket; selfId?: string; links: string[]; setLinks: (l: string[]) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 180);
  const results = useMemo(() => {
    const list = dq ? bucket.search(dq, { type: "fact", limit: 30 }) : bucket.entries().filter((e) => e.head.type === "fact").sort((a, b) => b.head.createdAt - a.head.createdAt).slice(0, 12);
    return list.filter((e) => !e.head.deleted && e.entryId !== selfId && !links.includes(e.entryId));
  }, [dq, links]);
  return (
    <div class="field"><span>Linked facts</span>
      {links.length > 0 && (
        <div class="list">
          {links.map((id) => {
            const e = bucket.get(id);
            return <div class="li"><span class="grow">{e?.head.title ?? <span class="muted mono">{id}</span>}</span>
              <button type="button" class="btn ghost sm" onClick={() => setLinks(links.filter((x) => x !== id))}>Remove</button></div>;
          })}
        </div>
      )}
      <div class="picker">
        <div class="search" style={{ borderBottom: "1px solid var(--line-2)" }}><ISearch /><input class="input" style={{ border: 0, minHeight: 42, fontSize: "0.92rem" }} placeholder="Search facts to link" value={q} onInput={(e) => setQ(e.currentTarget.value)} /></div>
        <div class="picker-results">
          {results.length === 0 ? <p class="small muted" style={{ padding: 12 }}>No more facts match.</p> :
            results.map((e) => <div class="li" role="button" tabIndex={0} onClick={() => setLinks([...links, e.entryId])} onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); setLinks([...links, e.entryId]); } }}>
              <span class="grow">{e.head.title}</span><span class="small muted">Link</span></div>)}
        </div>
      </div>
    </div>
  );
}
