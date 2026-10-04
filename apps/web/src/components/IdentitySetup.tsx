import { useState } from "preact/hooks";
import { Identity } from "../lib/core";
import { adoptIdentity, state, unlock } from "../lib/state";
import { parseSecret } from "../lib/bech32";
import { passkeySupported, PrfUnsupportedError } from "../lib/keystore";
import { toast } from "../lib/toast";
import { CopyButton, useAction } from "./ui";
import { IKey, IPasskey, ILock } from "./icons";

/**
 * Create / import an identity. Steps: choose → backup (new keys only) → protect.
 * Used by the welcome screen and inline on the join route.
 */
export function IdentitySetup({ compact }: { compact?: boolean }) {
  const [step, setStep] = useState<"choose" | "import" | "backup" | "protect">("choose");
  const [id, setId] = useState<Identity | null>(null);
  const [nsecIn, setNsecIn] = useState("");
  const [saved, setSaved] = useState(false);
  const [reveal, setReveal] = useState(false);
  const { busy, run } = useAction();

  if (step === "choose") return (
    <div class="choice">
      <button class="btn primary lg block" onClick={() => { setId(Identity.generate()); setStep("backup"); }}>
        <IKey />Create a new identity
      </button>
      <button class="btn lg block" onClick={() => setStep("import")}>I already have an nsec</button>
      {!compact && <p class="small muted">Your identity is a Nostr key pair made on this device. Nobody else, including us, ever sees the secret half.</p>}
    </div>
  );

  if (step === "import") return (
    <form class="stack" onSubmit={(e) => {
      e.preventDefault();
      try { setId(Identity.fromSecret(parseSecret(nsecIn))); setNsecIn(""); setStep("protect"); }
      catch (err) { toast(err instanceof Error ? err.message : "That is not a valid nsec.", "error"); }
    }}>
      <label class="field"><span>Secret key</span>
        <input class="input mono" type="password" autoComplete="off" spellcheck={false} placeholder="nsec1…" value={nsecIn} onInput={(e) => setNsecIn(e.currentTarget.value)} />
        <span class="hint">nsec or 64-character hex. It stays in this browser.</span>
      </label>
      <div class="row"><button class="btn" type="button" onClick={() => setStep("choose")}>Back</button><button class="btn primary grow" disabled={!nsecIn.trim()}>Import key</button></div>
    </form>
  );

  if (step === "backup" && id) return (
    <div class="stack">
      <h2>Back up your secret key</h2>
      <p class="muted small">If you lose this browser and this key, you lose access to every bucket. Store it in a password manager.</p>
      <div class={`secret-box ${reveal ? "" : "blur"}`} onClick={() => setReveal(true)} title={reveal ? "" : "Click to reveal"}>{id.nsec()}</div>
      <div class="row wrap">
        <button class="btn sm" onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Reveal"}</button>
        <CopyButton text={id.nsec()} label="Copy nsec" />
      </div>
      <label class="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} /><span>I saved my secret key somewhere safe.</span></label>
      <button class="btn primary block" disabled={!saved} onClick={() => setStep("protect")}>Continue</button>
    </div>
  );

  if (step === "protect" && id) {
    const passkey = passkeySupported() && state.mode === "live";
    return (
      <div class="stack">
        <h2>Protect it on this device</h2>
        <p class="muted small">A passkey encrypts your key with your fingerprint, face or security key. You unlock Tribe with it each session.</p>
        {passkey && (
          <button class="btn primary lg block" disabled={busy} onClick={() => run(async () => {
            try { await adoptIdentity(id, "passkey", `tribe-${id.npub().slice(5, 13)}`); }
            catch (e) {
              if (e instanceof PrfUnsupportedError) throw new Error("This passkey can't encrypt keys (no PRF support). Store it locally instead, or try another authenticator.");
              throw e;
            }
          })}><IPasskey />{busy ? "Waiting for passkey…" : "Protect with passkey"}</button>
        )}
        <button class={passkey ? "btn block" : "btn primary lg block"} disabled={busy} onClick={() => run(() => adoptIdentity(id, "local"))}>
          Store locally (less secure)
        </button>
        <p class="small muted">Stored locally, the key sits unencrypted in this browser's storage. Anyone with access to this browser profile can read it.</p>
      </div>
    );
  }
  return null;
}

export function UnlockScreen() {
  const { busy, run } = useAction();
  return (
    <div class="center-screen">
      <div class="unlock">
        <ILock size={36} />
        <h1>Unlock Tribe</h1>
        <p class="muted">Your key is protected by a passkey on this device.</p>
        <button class="btn primary lg block" disabled={busy} onClick={() => run(unlock)}><IPasskey />{busy ? "Waiting for passkey…" : "Unlock with passkey"}</button>
      </div>
    </div>
  );
}
