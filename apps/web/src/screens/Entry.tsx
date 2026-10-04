import { useMemo, useState } from "preact/hooks";
import { Shell } from "../components/Shell";
import { Empty, useAction, useConfirm } from "../components/ui";
import { IAlert, IBack, IBranch } from "../components/icons";
import type { Bucket, Entry, EntryVersion } from "../lib/core";
import { useBucket } from "../lib/state";
import { renderMarkdown, stripTitle } from "../lib/markdown";
import { ago, fullDate, plural, shortId } from "../lib/format";
import { byline, isAgent, memberName } from "../lib/members";
import { lineDiff } from "../lib/diff";
import { bucketPath, entryPath, go } from "../lib/router";
import { BucketGate } from "./BucketGate";

export function EntryScreen({ bucketId, entryId }: { bucketId: string; entryId: string }) {
  const { bucket, error } = useBucket(bucketId);
  return (
    <Shell bucket={bucket} tab="knowledge" wide>
      <BucketGate bucket={bucket} error={error}>{bucket && <EntryView bucket={bucket} entryId={entryId} />}</BucketGate>
    </Shell>
  );
}

/** Versions nobody points to via prev = current heads. */
export function headsOf(e: Entry): EntryVersion[] {
  const pointed = new Set(e.versions.map((v) => v.prev).filter(Boolean));
  return e.versions.filter((v) => !pointed.has(v.id)).sort((a, b) => b.createdAt - a.createdAt);
}

const Md = ({ src }: { src: string }) => <div class="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />;

function EntryView({ bucket, entryId }: { bucket: Bucket; entryId: string }) {
  const e = bucket.get(entryId);
  const [sel, setSel] = useState<string | null>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const versions = useMemo(() => (e ? [...e.versions].sort((a, b) => b.createdAt - a.createdAt) : []), [e]);

  if (!e) return <div class="panel"><Empty title="Entry not found" action={<a class="btn" href={bucketPath(bucket.bucketId)}>Back to knowledge</a>}>It may not have synced yet, or the link is wrong.</Empty></div>;

  const h = e.head;
  const viewing = versions.find((v) => v.id === sel) ?? h;
  const idx = versions.indexOf(viewing);
  const prevV = viewing.prev ? versions.find((v) => v.id === viewing.prev) : versions[idx + 1];
  const backlinks = (() => { try { return bucket.backlinks(entryId).filter((x) => !x.head.deleted); } catch { return []; } })();
  const linked = h.links.map((id) => bucket.get(id)).filter((x): x is Entry => !!x && !x.head.deleted);
  const heads = e.conflict ? (typeof bucket.heads === "function" ? [...bucket.heads(entryId)].sort((a, b) => b.createdAt - a.createdAt) : headsOf(e)) : [];

  // Omitting prev lets core supersede *all* current heads (prev = shown head, merges = the rest),
  // so the conflict actually closes; the content is the chosen version's.
  const keep = (v: EntryVersion) => run(async () => {
    await bucket.write({ entryId, type: v.type, title: v.title, body: v.body, tags: v.tags, links: v.links, source: "human" });
    setSel(null);
  }, "Conflict resolved");

  return (
    <>
      <div class="crumbs"><a href={bucketPath(bucket.bucketId)}><IBack size={14} style={{ verticalAlign: "-2px" }} /> Knowledge</a></div>
      {h.deleted && <div class="banner rust"><IAlert /><div>This entry was deleted {ago(h.createdAt)}. Earlier versions are still in its history.</div></div>}
      {e.conflict && !h.deleted && (
        <div class="banner amber">
          <IBranch class="amber-ink" />
          <div class="grow">
            <b>Two edits were made from the same version.</b>
            <p class="small" style={{ marginTop: 4 }}>Tribe shows the newest one by default. Pick the version to keep; the other stays in history.</p>
            <div class="heads">
              {heads.map((v) => (
                <div class={`head-opt ${v.id === h.id ? "current" : ""}`}>
                  <div class="spread small"><span><b>{byline(bucket, v)}</b> · {ago(v.createdAt)}{v.id === h.id && " · shown"}</span>
                    <button class="btn sm primary" disabled={busy} onClick={() => keep(v)}>Keep this version</button></div>
                  <div style={{ fontWeight: 600 }}>{v.title}</div>
                  <details><summary class="small muted">Changes from the common version</summary><VersionDiff bucket={bucket} entry={e} v={v} /></details>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <div class="entry-layout">
        <article>
          <p class="kind">{h.type === "page" ? "Page" : "Fact"}{viewing !== h && ` · viewing version from ${fullDate(viewing.createdAt)}`}</p>
          <h1 class="entry-title" style={{ marginTop: 6 }}>{viewing.title || "Untitled"}</h1>
          <div class="entry-byline">
            <span class={`prov ${isAgent(viewing) ? "agent" : ""}`}><i />{byline(bucket, viewing)}</span>
            <span title={fullDate(viewing.createdAt)}>{ago(viewing.createdAt)}</span>
            {viewing.tags.map((t) => <a class="tag" href={bucketPath(bucket.bucketId)} onClick={() => { try { sessionStorage.setItem("tribe.filters", JSON.stringify({ tag: t })); } catch {} }}>#{t}</a>)}
          </div>
          {viewing !== h ? (
            <div class="stack">
              <div class="row wrap"><button class="btn sm" onClick={() => setSel(null)}>Back to current</button>
                {prevV && <span class="small muted">Changes compared with the version before it</span>}</div>
              <VersionDiff bucket={bucket} entry={e} v={viewing} />
            </div>
          ) : <Md src={stripTitle(viewing.body, viewing.title)} />}
          {h.type === "page" && linked.length > 0 && viewing === h && (
            <div class="linked"><h3 style={{ marginBottom: 4 }}>Linked facts</h3>
              {linked.map((x) => <a href={entryPath(bucket.bucketId, x.entryId)}><span class="kind" style={{ fontFamily: "var(--sans)" }}>Fact</span>{x.head.title}</a>)}
            </div>
          )}
          {!h.deleted && (
            <div class="toolbar" style={{ marginTop: 32 }}>
              <a class="btn primary" href={`${entryPath(bucket.bucketId, entryId)}/edit`}>Edit</a>
              <button class="btn danger" disabled={busy} onClick={async () => {
                if (await confirm.ask("Delete this entry?", <p>Teammates and agents will stop seeing it. Its history stays in the bucket, and anyone can restore it by editing an old version.</p>, "Delete entry", true))
                  await run(async () => { await bucket.remove(entryId); go(`/b/${bucket.bucketId}`); }, "Entry deleted");
              }}>Delete</button>
            </div>
          )}
          {h.deleted && versions[1] && (
            <div class="toolbar" style={{ marginTop: 32 }}>
              <button class="btn" disabled={busy} onClick={() => { const v = versions.find((x) => !x.deleted)!; void run(() => bucket.write({ entryId, type: v.type, title: v.title, body: v.body, tags: v.tags, links: v.links, prev: h.id, source: "human" }), "Entry restored"); }}>Restore last version</button>
            </div>
          )}
        </article>
        <aside class="entry-aside">
          <section>
            <h4>History · {plural(versions.length, "version")}</h4>
            <ol class="timeline">
              {versions.map((v) => (
                <li class={`${isAgent(v) ? "agent" : ""} ${v.id === h.id ? "head" : ""}`}>
                  <button aria-pressed={v.id === viewing.id} onClick={() => setSel(v.id === h.id ? null : v.id)}>
                    {v.deleted ? "Deleted" : v.id === h.id ? "Current" : ago(v.createdAt)}
                    <br /><span class="muted small">{byline(bucket, v)} · {v.id === h.id ? ago(v.createdAt) : shortId(v.id)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h4>Referenced by</h4>
            {backlinks.length === 0 ? <p class="muted small">No pages link here yet.</p> : (
              <ul>{backlinks.map((x) => <li><a href={entryPath(bucket.bucketId, x.entryId)}>{x.head.title}</a></li>)}</ul>
            )}
          </section>
          <section>
            <h4>Details</h4>
            <ul class="small muted">
              <li>Author: {memberName(bucket, h.authorMember)}</li>
              <li>Key epoch {h.epoch}</li>
              <li class="mono" title={h.entryId}>ID {shortId(h.entryId)}</li>
            </ul>
          </section>
        </aside>
      </div>
      {confirm.node}
    </>
  );
}

function VersionDiff({ entry, v }: { bucket: Bucket; entry: Entry; v: EntryVersion }) {
  const base = v.prev ? entry.versions.find((x) => x.id === v.prev) : undefined;
  const a = base ? `# ${base.title}\n\n${base.body}` : "";
  const b = `# ${v.title}\n\n${v.body}`;
  const d = lineDiff(a, b);
  if (!base) return <p class="small muted">First version. Nothing to compare with.</p>;
  return <div class="diff" role="region" aria-label="Line diff">{d.map((l) => <div class={l.op}>{l.text || " "}</div>)}</div>;
}
