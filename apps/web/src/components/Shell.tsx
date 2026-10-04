import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Bucket } from "../lib/core";
import { exitDemo, state, syncBucket, useApp } from "../lib/state";
import { ago, plural } from "../lib/format";
import { bucketPath } from "../lib/router";
import { IBook, IChip, IGear, IUsers, Logo, IGrid } from "./icons";

type Tab = "knowledge" | "members" | "devices" | "settings";

export function SyncStatus({ bucket }: { bucket: Bucket }) {
  const app = useApp();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  const s = app.sync[bucket.bucketId] ?? { state: "idle" as const };
  const relays = bucket.relays.length;
  const label =
    app.mode === "demo" ? "Demo relays (in memory)" :
    s.state === "syncing" ? "Syncing…" :
    s.state === "error" ? "Sync failed — retry" :
    s.at ? `Synced ${ago(Math.floor(s.at / 1000))}` : "Not synced yet";
  return (
    <button class="sync" title={s.error ?? `${plural(relays, "relay")}: ${bucket.relays.join(", ")}`} onClick={() => app.mode === "live" && void syncBucket(bucket)}>
      <span class={`dot ${app.mode === "demo" ? "ok" : s.state}`} />
      <span>{label}<br /><span class="muted">{plural(relays, "relay")}</span></span>
    </button>
  );
}

export function Shell({ bucket, tab, children, wide }: { bucket: Bucket | null; tab?: Tab; children: ComponentChildren; wide?: boolean }) {
  const app = useApp();
  const id = bucket?.bucketId;
  const conflicts = bucket ? safeCount(() => bucket.entries().filter((e) => e.conflict && !e.head.deleted).length) : 0;
  const pending = bucket?.isAdmin() ? safeCount(() => bucket.pendingRequests().filter((r) => !r.autoAccepted).length) : 0;
  const total = bucket ? safeCount(() => bucket.entries().filter((e) => !e.head.deleted).length) : 0;
  const nav: { t: Tab; href: string; label: string; icon: preact.JSX.Element; count?: string }[] = id ? [
    { t: "knowledge", href: bucketPath(id), label: "Knowledge", icon: <IBook />, count: total ? total.toLocaleString() : undefined },
    { t: "members", href: bucketPath(id, "/members"), label: "Members", icon: <IUsers />, count: pending ? `${pending} waiting` : undefined },
    { t: "devices", href: bucketPath(id, "/devices"), label: "Devices & agents", icon: <IChip /> },
    { t: "settings", href: bucketPath(id, "/settings"), label: "Settings", icon: <IGear /> },
  ] : [];
  return (
    <div class="shell">
      <aside class="side">
        <a class="brand" href="#/buckets"><Logo size={22} />Tribe</a>
        {bucket && (
          <a class="bucket-switch" href="#/buckets" title="Switch bucket">
            <b>{bucket.name}</b>
            <small>{bucket.isAdmin() ? "Admin" : "Member"} · {conflicts ? `${plural(conflicts, "conflict")}` : "no conflicts"}</small>
          </a>
        )}
        <nav class="nav" aria-label="Bucket">
          {nav.map((n) => (
            <a href={n.href} aria-current={tab === n.t ? "page" : undefined}>{n.icon}{n.label}{n.count && <span class="count">{n.count}</span>}</a>
          ))}
          {!bucket && <a href="#/buckets" aria-current="page"><IGrid />Buckets</a>}
        </nav>
        <div class="side-foot">
          {app.mode === "demo" && <div class="demo-flag"><span>Demo mode</span><button onClick={() => void exitDemo()}>Leave</button></div>}
          {bucket && <SyncStatus bucket={bucket} />}
        </div>
      </aside>
      <header class="topbar">
        <a class="brand" href="#/buckets" aria-label="All buckets"><Logo size={22} /></a>
        {bucket ? <a class="bucket-name" href="#/buckets">{bucket.name}</a> : <span class="grow" style={{ fontWeight: 620 }}>Tribe</span>}
        {app.mode === "demo" && <span class="badge indigo">Demo</span>}
        {bucket && <span class={`dot ${app.mode === "demo" ? "ok" : state.sync[bucket.bucketId]?.state ?? "idle"}`} title="Sync status" />}
      </header>
      <main class={`main ${bucket ? "" : "no-tabs"}`}><div class={wide ? "col wide" : "col"}>{children}</div></main>
      {bucket && (
        <nav class="tabbar" aria-label="Bucket">
          {nav.map((n) => <a href={n.href} aria-current={tab === n.t ? "page" : undefined}>{n.icon}<span>{n.label.split(" ")[0]}</span></a>)}
        </nav>
      )}
    </div>
  );
}

function safeCount(f: () => number): number { try { return f(); } catch { return 0; } }
