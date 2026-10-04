import { useMemo, useState } from "preact/hooks";
import { IdentitySetup, UnlockScreen } from "../components/IdentitySetup";
import { Logo } from "../components/icons";
import { useAction } from "../components/ui";
import { Bucket, parseInviteLink } from "../lib/core";
import { adoptBucket, getPool, getStore, refreshBuckets, setSync, useApp } from "../lib/state";
import { shortNpub } from "../lib/format";
import { go } from "../lib/router";

export function Join({ blob }: { blob: string }) {
  const app = useApp();
  const [name, setName] = useState("");
  const { busy, run } = useAction();
  const info = useMemo(() => { try { return parseInviteLink(blob); } catch { return null; } }, [blob]);

  if (app.phase === "locked") return <UnlockScreen />;

  return (
    <div class="center-screen">
      <div style={{ width: "min(460px, 100%)" }} class="stack-lg">
        <a class="brand" href="#/" style={{ padding: 0 }}><Logo size={22} />Tribe</a>
        {!info ? (
          <div class="panel stack"><h1>This invite link is broken</h1><p class="muted">It may have been cut off when it was copied. Ask the admin to send it again.</p><a class="btn" href="#/">Go to Tribe</a></div>
        ) : (
          <div class="panel stack">
            <p class="small muted">You're invited to</p>
            <h1 style={{ fontFamily: "var(--serif)", fontWeight: 600 }}>{info.name || "a Tribe bucket"}</h1>
            <p class="small muted">Admin <span class="mono">{shortNpub(info.adminPk)}</span> · {info.relays.length} relays</p>
            {app.phase !== "ready" ? (
              <div class="stack" style={{ marginTop: 8 }}>
                <p>First, set up your identity on this device.</p>
                <IdentitySetup compact />
              </div>
            ) : (
              <form class="stack" style={{ marginTop: 8 }} onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const b = await Bucket.joinWithInvite({ identity: app.identity!, link: blob, name: name.trim() || undefined, pool: getPool(), store: await getStore() });
                  adoptBucket(b);
                  setSync(b.bucketId, { state: "ok", at: Date.now() });
                  await refreshBuckets();
                  go(`/b/${b.bucketId}`);
                }, "Joined. Welcome in.");
              }}>
                <label class="field"><span>Your name, as teammates will see it</span><input class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="e.g. Alex Chen" /></label>
                <button class="btn primary lg block" disabled={busy}>{busy ? "Joining…" : "Join bucket"}</button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
