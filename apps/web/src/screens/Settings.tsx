import { useState } from "preact/hooks";
import { RelayList, Shell } from "../components/Shell";
import { CopyButton, useAction, useConfirm } from "../components/ui";
import { IX, IPlus } from "../components/icons";
import { relayStatusOf, type Bucket } from "../lib/core";
import { exitDemo, lock, signOut, startDemo, state, useApp, useBucket } from "../lib/state";
import { download, slug } from "../lib/format";
import { BucketGate } from "./BucketGate";

export function Settings({ bucketId }: { bucketId: string }) {
  const { bucket, error } = useBucket(bucketId);
  return (
    <Shell bucket={bucket} tab="settings">
      <BucketGate bucket={bucket} error={error}>{bucket && <SettingsView bucket={bucket} />}</BucketGate>
    </Shell>
  );
}

/** GitHub Pages project sites (user.github.io/repo) share one origin with every other project of that user. */
function sharedOrigin(): boolean {
  return /\.github\.io$/i.test(location.hostname) && location.pathname.replace(/\/+$/, "").split("/").filter(Boolean).length > 0;
}

function SettingsView({ bucket }: { bucket: Bucket }) {
  const app = useApp();
  const admin = bucket.isAdmin();
  const [name, setName] = useState(bucket.name);
  const [relays, setRelays] = useState<string[]>(bucket.relays);
  const [reveal, setReveal] = useState(false);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const clean = relays.map((r) => r.trim()).filter(Boolean);
  const relaysChanged = clean.join("\n") !== bucket.relays.join("\n");
  const relaysValid = clean.length > 0 && clean.every((r) => /^wss?:\/\/.+/.test(r));

  const exportMd = () => {
    const files = bucket.exportMarkdown();
    const md = files.map((f) => `<!-- ${f.path} -->\n${f.content.trim()}\n`).join("\n---\n\n");
    download(`${slug(bucket.name)}.md`, md, "text/markdown");
  };

  return (
    <>
      <div class="page-head"><div><h1>Settings</h1><p>{bucket.name}</p></div></div>

      <div class="panel stack">
        <h2>Bucket</h2>
        <form class="relay-row" onSubmit={(e) => { e.preventDefault(); void run(() => bucket.rename(name.trim()), "Bucket renamed"); }}>
          <label class="field grow"><span>Name</span><input class="input" value={name} disabled={!admin} onInput={(e) => setName(e.currentTarget.value)} maxLength={80} /></label>
          {admin && <button class="btn" style={{ alignSelf: "end" }} disabled={busy || !name.trim() || name.trim() === bucket.name}>Rename</button>}
        </form>
        <div class="field"><span>Bucket ID</span><div class="row"><code class="grow" style={{ overflowWrap: "anywhere" }}>{bucket.bucketId}</code><CopyButton text={bucket.bucketId} /></div>
          <span class="hint">Share it with someone who wants to request access.</span></div>
      </div>

      <div class="panel stack">
        <h2>Relays</h2>
        <p class="small muted">Every member publishes to and reads from these relays.{!admin && " Only admins can change them."} Use at least 3.</p>
        {(() => { const rs = relayStatusOf(bucket); return rs && <div class="field"><span>Status</span><RelayList bucket={bucket} demo={app.mode === "demo"} status={rs} /></div>; })()}
        {relays.map((r, i) => (
          <div class="relay-row">
            <input class="input mono grow" value={r} disabled={!admin} aria-label={`Relay ${i + 1}`} onInput={(e) => setRelays(relays.map((x, j) => (j === i ? e.currentTarget.value : x)))} />
            {admin && <button class="btn ghost" aria-label="Remove relay" onClick={() => setRelays(relays.filter((_, j) => j !== i))}><IX size={16} /></button>}
          </div>
        ))}
        {admin && (
          <div class="row wrap">
            <button class="btn sm" onClick={() => setRelays([...relays, "wss://"])}><IPlus size={14} />Add relay</button>
            <span class="grow" />
            {relaysChanged && <button class="btn sm" onClick={() => setRelays(bucket.relays)}>Reset</button>}
            <button class="btn sm primary" disabled={!relaysChanged || !relaysValid || busy} onClick={() => run(() => bucket.setRelays(clean), "Relays saved")}>Save relays</button>
          </div>
        )}
      </div>

      <div class="panel stack">
        <h2>Export</h2>
        <p class="small muted">Decrypted copies of the current version of every entry. Keep exports somewhere safe; they are not encrypted.</p>
        <div class="row wrap">
          <button class="btn" onClick={() => download(`${slug(bucket.name)}.json`, bucket.exportJSON(), "application/json")}>Download JSON</button>
          <button class="btn" onClick={exportMd}>Download Markdown</button>
        </div>
      </div>

      <div class="panel stack">
        <h2>Your key</h2>
        <p class="small muted">Your secret key opens every bucket you belong to. Back it up once and never paste it into a website you don't trust.</p>
        {sharedOrigin() && (
          <p class="callout">
            This copy of Tribe runs on <b>{location.hostname}</b>, a shared GitHub Pages origin. Every project site under it can read this browser's storage for the site, including an unencrypted key. Back up your nsec, protect it with a passkey, and for real use deploy Tribe on its own origin (a custom domain or a user/org site).
          </p>
        )}
        {app.identity && (
          <>
            <div class="field"><span>Public key (npub)</span><div class="row"><code class="grow" style={{ overflowWrap: "anywhere" }}>{app.identity.npub()}</code><CopyButton text={app.identity.npub()} /></div></div>
            <div class="field"><span>Secret key (nsec)</span>
              <div class={`secret-box ${reveal ? "" : "blur"}`}>{reveal ? app.identity.nsec() : "nsec1" + "•".repeat(58)}</div>
              <div class="row wrap">
                <button class="btn sm" onClick={async () => { if (reveal) return setReveal(false); if (await confirm.ask("Show secret key?", <p>Make sure nobody can see your screen.</p>, "Show key")) setReveal(true); }}>{reveal ? "Hide" : "Reveal"}</button>
                {reveal && <CopyButton text={app.identity.nsec()} label="Copy nsec" />}
              </div>
            </div>
            <p class="small muted">Stored {app.mode === "demo" ? "in memory only (demo)" : app.record?.kind === "passkey" ? "encrypted with a passkey" : "unencrypted in this browser"}.</p>
          </>
        )}
        <div class="row wrap">
          {app.record?.kind === "passkey" && <button class="btn" onClick={() => { lock(); location.hash = "#/"; }}>Lock</button>}
          <button class="btn danger" onClick={async () => {
            if (await confirm.ask("Sign out of this browser?", <p>{app.mode === "demo" ? "The demo data is discarded." : "Your key is deleted from this browser. You need your nsec backup to get back in."}</p>, "Sign out", true)) {
              await signOut(); location.hash = "#/";
            }
          }}>Sign out</button>
        </div>
      </div>

      <div class="panel stack">
        <div class="spread"><h2>Demo mode</h2><span class={`badge ${app.mode === "demo" ? "indigo" : ""}`}>{app.mode === "demo" ? "On" : "Off"}</span></div>
        <p class="small muted">Demo mode runs on in-memory relays with a seeded team bucket. Nothing is published, and it resets when you reload.</p>
        <div>{app.mode === "demo"
          ? <button class="btn" onClick={() => void exitDemo()}>Leave demo</button>
          : <button class="btn" onClick={() => void startDemo()}>Switch to demo</button>}</div>
      </div>
      {confirm.node}
      <span hidden>{state.rev}</span>
    </>
  );
}
