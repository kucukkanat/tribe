import { useState } from "preact/hooks";
import { Shell } from "../components/Shell";
import { Dialog, Empty, Skeleton, useAction } from "../components/ui";
import { IPlus } from "../components/icons";
import { Bucket, parseInviteLink } from "../lib/core";
import { getPool, getStore, refreshBuckets, state, useApp } from "../lib/state";
import { parsePubkey } from "../lib/bech32";
import { go } from "../lib/router";
import { DEFAULT_RELAYS } from "../lib/core";

export function Buckets() {
  const app = useApp();
  const [link, setLink] = useState("");
  const [req, setReq] = useState(false);
  const list = app.buckets;

  const join = () => {
    const raw = link.trim();
    try {
      const blob = raw.includes("#/join/") ? raw.split("#/join/")[1]! : raw;
      parseInviteLink(raw);
      go(`/join/${blob}`);
    } catch { go(`/join/${raw}`); }
  };

  return (
    <Shell bucket={null}>
      <div class="page-head">
        <div><h1>Your buckets</h1><p>Each bucket is a separate, encrypted memory with its own members.</p></div>
        <a class="btn primary" href="#/create"><IPlus size={16} />New bucket</a>
      </div>
      {!list ? <Skeleton lines={3} /> : list.length === 0 ? (
        <div class="panel"><Empty title="No buckets yet" action={<a class="btn primary" href="#/create">Create your first bucket</a>}>
          Create a bucket for your team, or paste an invite link below.
        </Empty></div>
      ) : (
        <div class="list">
          {list.map((b) => (
            <a class="li" href={`#/b/${b.bucketId}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div class="grow">
                <div style={{ fontWeight: 620 }}>{b.name || "Unnamed bucket"}</div>
                <div class="small muted mono">{b.bucketId.slice(0, 12)}… · {b.relays.length} relays</div>
              </div>
              <span class={`badge ${b.role === "admin" ? "moss" : b.role === "pending" ? "amber" : ""}`}>{b.role === "pending" ? "Waiting for approval" : b.role === "admin" ? "Admin" : "Member"}</span>
            </a>
          ))}
        </div>
      )}

      <h2 class="section-title">Join a bucket</h2>
      <div class="panel stack">
        <form class="relay-row" onSubmit={(e) => { e.preventDefault(); if (link.trim()) join(); }}>
          <input class="input grow" placeholder="Paste an invite link" value={link} onInput={(e) => setLink(e.currentTarget.value)} />
          <button class="btn primary" disabled={!link.trim()}>Join</button>
        </form>
        <p class="small muted">No invite? <button class="btn ghost sm" style={{ padding: 0, minHeight: 0, color: "var(--moss)" }} onClick={() => setReq(true)}>Request access</button> with the bucket ID and an admin's npub.</p>
      </div>
      {req && <RequestAccess onClose={() => setReq(false)} />}
      {state.identity && <p class="small muted" style={{ marginTop: 24 }}>Signed in as <span class="mono">{state.identity.npub().slice(0, 18)}…</span></p>}
    </Shell>
  );
}

function RequestAccess({ onClose }: { onClose: () => void }) {
  const [bucketId, setB] = useState("");
  const [admin, setA] = useState("");
  const [name, setN] = useState("");
  const [msg, setM] = useState("");
  const { busy, run } = useAction();
  const valid = /^[0-9a-f]{32}$/i.test(bucketId.trim()) && admin.trim().length > 0;
  return (
    <Dialog title="Request access" onClose={onClose} actions={<>
      <button class="btn" onClick={onClose}>Cancel</button>
      <button class="btn primary" disabled={!valid || busy} onClick={() => run(async () => {
        const adminPk = parsePubkey(admin);
        await Bucket.requestAccess({ identity: state.identity!, bucketId: bucketId.trim().toLowerCase(), adminPk, relays: DEFAULT_RELAYS, name: name || undefined, message: msg || undefined, pool: getPool(), store: await getStore() });
        await refreshBuckets();
        onClose();
      }, "Request sent. An admin will see it under Members.")}>Send request</button>
    </>}>
      <p class="small muted">The admin sees your name and message and can approve you. Until then you can't read anything.</p>
      <label class="field"><span>Bucket ID</span><input class="input mono" value={bucketId} onInput={(e) => setB(e.currentTarget.value)} placeholder="32 hex characters" /></label>
      <label class="field"><span>Admin npub</span><input class="input mono" value={admin} onInput={(e) => setA(e.currentTarget.value)} placeholder="npub1…" /></label>
      <label class="field"><span>Your name</span><input class="input" value={name} onInput={(e) => setN(e.currentTarget.value)} /></label>
      <label class="field"><span>Message (optional)</span><textarea class="textarea" style={{ minHeight: 70 }} value={msg} onInput={(e) => setM(e.currentTarget.value)} /></label>
    </Dialog>
  );
}
