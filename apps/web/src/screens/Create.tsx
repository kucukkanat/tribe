import { useState } from "preact/hooks";
import { Shell } from "../components/Shell";
import { useAction } from "../components/ui";
import { IX, IPlus } from "../components/icons";
import { Bucket, RECOMMENDED_RELAYS } from "../lib/core";
import { adoptBucket, getPool, getStore, refreshBuckets, setSync, state } from "../lib/state";
import { go } from "../lib/router";

export function CreateBucket() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [relays, setRelays] = useState<string[]>(state.mode === "demo" ? ["wss://demo.relay.local"] : [...RECOMMENDED_RELAYS]);
  const [created, setCreated] = useState<Bucket | null>(null);
  const { busy, run } = useAction();
  const cleanRelays = relays.map((r) => r.trim()).filter(Boolean);
  const relaysValid = cleanRelays.length > 0 && cleanRelays.every((r) => /^wss?:\/\/.+/.test(r));

  return (
    <Shell bucket={null}>
      <h1 style={{ marginBottom: 20 }}>New bucket</h1>
      <ol class="steps">
        {["Name", "Relays", "Done"].map((s, i) => <li class={i === step ? "on" : i < step ? "done" : ""}>{s}</li>)}
      </ol>
      <div class="panel">
        {step === 0 && (
          <form class="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep(1); }}>
            <label class="field"><span>Bucket name</span>
              <input class="input" autoFocus value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="e.g. Platform team" maxLength={80} />
              <span class="hint">Members see this name. Relays don't: it's encrypted.</span>
            </label>
            <div class="row" style={{ justifyContent: "flex-end" }}><a class="btn" href="#/buckets">Cancel</a><button class="btn primary" disabled={!name.trim()}>Next</button></div>
          </form>
        )}
        {step === 1 && (
          <div class="stack">
            <div><h2>Where should it be stored?</h2><p class="small muted" style={{ marginTop: 4 }}>Encrypted events are published to every relay in this list. More relays means more redundancy.</p></div>
            {relays.map((r, i) => (
              <div class="relay-row">
                <input class="input mono grow" value={r} aria-label={`Relay ${i + 1}`} onInput={(e) => setRelays(relays.map((x, j) => (j === i ? e.currentTarget.value : x)))} />
                <button class="btn ghost" aria-label="Remove relay" onClick={() => setRelays(relays.filter((_, j) => j !== i))}><IX size={16} /></button>
              </div>
            ))}
            <div class="row wrap">
              <button class="btn sm" onClick={() => setRelays([...relays, "wss://"])}><IPlus size={14} />Add relay</button>
              <span class={`hint ${state.mode === "live" && cleanRelays.length < 3 ? "warn" : ""}`}>Use at least 3 relays. Public relays drop events and go offline.</span>
            </div>
            <div class="row" style={{ justifyContent: "space-between" }}>
              <button class="btn" onClick={() => setStep(0)}>Back</button>
              <button class="btn primary" disabled={!relaysValid || busy} onClick={() => run(async () => {
                const b = await Bucket.create({ identity: state.identity!, name: name.trim(), relays: cleanRelays, pool: getPool(), store: await getStore() });
                adoptBucket(b);
                setSync(b.bucketId, { state: "ok", at: Date.now() });
                await refreshBuckets();
                setCreated(b); setStep(2);
              })}>{busy ? "Creating…" : "Create bucket"}</button>
            </div>
          </div>
        )}
        {step === 2 && created && (
          <div class="stack">
            <h2>{created.name} is ready</h2>
            <p class="muted">You're its admin. Invite teammates now, or start adding knowledge and invite them later.</p>
            <div class="row wrap">
              <button class="btn primary" onClick={() => go(`/b/${created.bucketId}/members?invite=1`)}>Create first invite</button>
              <a class="btn" href={`#/b/${created.bucketId}`}>Open bucket</a>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
