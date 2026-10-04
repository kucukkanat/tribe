import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { relayStatusOf, type Bucket, type RelayStatus } from "../lib/core";
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
  const [open, setOpen] = useState(false);
  const rs = app.mode === "demo" ? null : relayStatusOf(bucket);
  const down = rs ? rs.filter((r) => !r.ok).length : 0;
  const label =
    app.mode === "demo" ? "Demo relays (in memory)" :
    s.state === "syncing" ? "Syncing…" :
    s.state === "error" ? "Sync failed — retry" :
    s.at ? `Synced ${ago(Math.floor(s.at / 1000))}` : "Not synced yet";
  return (
    <div class="sync-wrap">
      <button class="sync" aria-expanded={open} title={s.error ?? `${plural(relays, "relay")}: ${bucket.relays.join(", ")}`} onClick={() => setOpen(!open)}>
        <span class={`dot ${app.mode === "demo" ? "ok" : s.state === "ok" && down ? "warn" : s.state}`} />
        <span>{label}<br /><span class="muted">{plural(relays, "relay")}{down ? ` · ${down} unreachable` : ""}</span></span>
      </button>
      {open && (
        <div class="sync-pop" role="dialog" aria-label="Relay status">
          {s.error && <p class="small" style={{ color: "var(--rust)", margin: "0 0 8px" }}>{s.error}</p>}
          <RelayList bucket={bucket} demo={app.mode === "demo"} status={rs} />
          {app.mode === "live" && <button class="btn sm block" style={{ marginTop: 8 }} onClick={() => void syncBucket(bucket)}>Sync now</button>}
        </div>
      )}
    </div>
  );
}

/** Per-relay status list (falls back to the plain URL list when core has no relayStatus). */
export function RelayList({ bucket, demo, status }: { bucket: Bucket; demo: boolean; status: RelayStatus[] | null }) {
  const rows: (RelayStatus | { url: string; ok?: undefined })[] = status ?? bucket.relays.map((url) => ({ url }));
  return (
    <ul class="relay-status">
      {rows.map((r) => {
        const st = demo ? "ok" : r.ok === undefined ? "idle" : r.ok ? "ok" : "error";
        const rr = r as RelayStatus;
        const detail = demo ? "in memory" : r.ok === undefined ? "unknown"
          : !r.ok ? (rr.lastError ?? "unreachable")
          : rr.read === undefined && rr.write === undefined ? "ok"
          : [rr.read !== undefined && `read ${rr.read ? "ok" : "failed"}`, rr.write !== undefined && `write ${rr.write ? "ok" : "failed"}`].filter(Boolean).join(" · ");
        return (
          <li><span class={`dot ${st}`} /><span class="mono grow" style={{ overflowWrap: "anywhere" }}>{r.url.replace(/^wss:\/\//, "")}</span><span class="small muted">{detail}</span></li>
        );
      })}
    </ul>
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
