import { useState } from "preact/hooks";
import { Shell } from "../components/Shell";
import { CopyButton, Empty, useAction, useConfirm } from "../components/ui";
import { IBot, IChip } from "../components/icons";
import type { Bucket, DeviceInfo } from "../lib/core";
import { state, useBucket } from "../lib/state";
import { parsePubkey } from "../lib/bech32";
import { ago, shortNpub } from "../lib/format";
import { memberName } from "../lib/members";
import { BucketGate } from "./BucketGate";

export function Devices({ bucketId }: { bucketId: string }) {
  const { bucket, error } = useBucket(bucketId);
  return (
    <Shell bucket={bucket} tab="devices">
      <BucketGate bucket={bucket} error={error}>{bucket && <DevicesView bucket={bucket} />}</BucketGate>
    </Shell>
  );
}

export const mcpConfig = (bucketId: string) =>
  JSON.stringify({ mcpServers: { tribe: { command: "bunx", args: ["tribe-mcp", "serve", "--bucket", bucketId] } } }, null, 2);

function DevicesView({ bucket }: { bucket: Bucket }) {
  const me = state.identity!.pk;
  const mine = safe(() => bucket.devices(me), []);
  const active = mine.filter((d) => !d.revoked);
  const revoked = mine.filter((d) => d.revoked);
  const others = bucket.isAdmin()
    ? (bucket.roster?.members ?? []).filter((m) => m.pk !== me).flatMap((m) => safe(() => bucket.devices(m.pk), []).filter((d) => !d.revoked).map((d) => ({ d, owner: m.pk })))
    : [];
  const [npub, setNpub] = useState("");
  const [label, setLabel] = useState("");
  const [paired, setPaired] = useState(false);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  let pkErr: string | null = null;
  if (npub.trim()) { try { parsePubkey(npub); } catch (e) { pkErr = e instanceof Error ? e.message : "Invalid npub"; } }

  const revoke = async (d: DeviceInfo) => {
    if (await confirm.ask(`Revoke ${d.label}?`, <p>It stops receiving new keys{bucket.isAdmin() ? " and the bucket key is rotated now" : "; the key rotates the next time an admin rotates"}. What it already synced stays on that machine.</p>, "Revoke device", true))
      await run(() => bucket.revokeDevice(d.pk), "Device revoked");
  };

  return (
    <>
      <div class="page-head"><div><h1>Devices & agents</h1><p>Agents act on your behalf. Whatever they write is attributed to you.</p></div></div>

      <div class="panel stack">
        <div class="row"><IBot /><h2>Pair an agent</h2></div>
        <ol class="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, color: "var(--ink-2)" }}>
          <li>On the machine where your agent runs, run <code>bunx tribe-mcp init</code>. It prints an npub.</li>
          <li>Paste that npub here and give the agent a name you'll recognise.</li>
          <li>Add the MCP config below to Claude Code or your agent's config.</li>
        </ol>
        <form class="stack" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => { await bucket.addDevice(parsePubkey(npub), label.trim() || "agent", "agent"); setPaired(true); setNpub(""); setLabel(""); }, "Agent paired");
        }}>
          <label class="field"><span>Agent npub</span><input class="input mono" value={npub} onInput={(e) => setNpub(e.currentTarget.value)} placeholder="npub1…" spellcheck={false} aria-invalid={!!pkErr} />
            {pkErr && <span class="hint" style={{ color: "var(--rust)" }}>{pkErr}</span>}</label>
          <label class="field"><span>Name</span><input class="input" value={label} onInput={(e) => setLabel(e.currentTarget.value)} placeholder="e.g. claude-code on work laptop" /></label>
          <div><button class="btn primary" disabled={!npub.trim() || !!pkErr || busy}>{busy ? "Pairing…" : "Pair agent"}</button></div>
        </form>
        <div class="stack" style={{ gap: 8 }}>
          <div class="spread"><span class="small" style={{ fontWeight: 600 }}>{paired ? "Now add this to your agent's MCP config" : "MCP config"}</span><CopyButton text={mcpConfig(bucket.bucketId)} /></div>
          <pre class="snippet">{mcpConfig(bucket.bucketId)}</pre>
        </div>
      </div>

      <h2 class="section-title">Your devices</h2>
      {active.length === 0 ? <div class="panel"><Empty title="No devices paired">This browser uses your identity key directly. Paired agents show up here.</Empty></div> : (
        <div class="list">{active.map((d) => <DeviceRow d={d} onRevoke={() => void revoke(d)} busy={busy} />)}</div>
      )}
      {others.length > 0 && (
        <>
          <h2 class="section-title">Other members' devices</h2>
          <div class="list">{others.map(({ d, owner }) => <DeviceRow d={d} owner={memberName(bucket, owner)} />)}</div>
        </>
      )}
      {revoked.length > 0 && (
        <>
          <h2 class="section-title">Revoked</h2>
          <div class="list">{revoked.map((d) => <DeviceRow d={d} />)}</div>
        </>
      )}
      {confirm.node}
    </>
  );
}

function DeviceRow({ d, owner, onRevoke, busy }: { d: DeviceInfo; owner?: string; onRevoke?: () => void; busy?: boolean }) {
  return (
    <div class="li" style={d.revoked ? { opacity: 0.6 } : undefined}>
      {d.kind === "agent" ? <IBot size={22} /> : <IChip size={22} />}
      <div class="grow">
        <div style={{ fontWeight: 600 }}>{d.label}</div>
        <div class="small muted"><span class="mono">{shortNpub(d.pk)}</span> · {owner ? `${owner} · ` : ""}added {ago(d.addedAt)}</div>
      </div>
      <span class={`badge ${d.kind === "agent" ? "indigo" : ""}`}>{d.revoked ? "Revoked" : d.kind === "agent" ? "Agent" : "Browser"}</span>
      {onRevoke && !d.revoked && <button class="btn sm danger" disabled={busy} onClick={onRevoke}>Revoke</button>}
    </div>
  );
}

function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
