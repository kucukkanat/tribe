import { useState } from "preact/hooks";
import { Shell } from "../components/Shell";
import { CopyButton, Empty, useAction, useConfirm } from "../components/ui";
import { IBot, IChip } from "../components/icons";
import { connectString, rootAdminOf, type Bucket, type DeviceInfo } from "../lib/core";
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

export const mcpConfig = (connect: string) =>
  JSON.stringify({ mcpServers: { tribe: { command: "bunx", args: ["tribe-mcp", "serve", "--connect", connect] } } }, null, 2);
export const claudeCodeCmd = (connect: string) => `claude mcp add tribe -- bunx tribe-mcp serve --connect "${connect}"`;
const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

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
  const [client, setClient] = useState<"claude" | "json">("claude");
  const connect = connectString(bucket.bucketId, rootAdminOf(bucket) ?? me, bucket.relays);
  const initCmd = `bunx tribe-mcp init --label ${shellQuote(label.trim() || "my-agent")}`;
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
        <ol class="small pair-steps">
          <li>
            <p>On the machine where your agent runs, create its key. It prints an npub.</p>
            <label class="field" style={{ marginBottom: 6 }}><span>Agent name</span><input class="input" value={label} onInput={(e) => setLabel(e.currentTarget.value)} placeholder="e.g. claude-code-laptop" /></label>
            <div class="row"><pre class="snippet wrap grow" style={{ margin: 0 }}>{initCmd}</pre><CopyButton text={initCmd} /></div>
          </li>
          <li>
            <p>Paste that npub here to give the agent its own key to this bucket.</p>
            <form class="stack" onSubmit={(e) => {
              e.preventDefault();
              void run(async () => { await bucket.addDevice(parsePubkey(npub), label.trim() || "agent", "agent"); setPaired(true); setNpub(""); }, "Agent paired");
            }}>
              <label class="field"><span>Agent npub</span><input class="input mono" value={npub} onInput={(e) => setNpub(e.currentTarget.value)} placeholder="npub1…" spellcheck={false} aria-invalid={!!pkErr} />
                {pkErr && <span class="hint" style={{ color: "var(--rust)" }}>{pkErr}</span>}</label>
              <div><button class="btn primary" disabled={!npub.trim() || !!pkErr || busy}>{busy ? "Pairing…" : "Pair agent"}</button></div>
            </form>
          </li>
          <li>
            <p>{paired ? "Paired. Now connect your agent:" : "Connect your agent to this bucket:"}</p>
            <div class="tabs-mini" role="group" aria-label="Agent client" style={{ marginBottom: 6 }}>
              <button type="button" class="btn sm" aria-pressed={client === "claude"} onClick={() => setClient("claude")}>Claude Code</button>
              <button type="button" class="btn sm" aria-pressed={client === "json"} onClick={() => setClient("json")}>MCP config (JSON)</button>
            </div>
            {client === "claude" ? (
              <div class="stack" style={{ gap: 6 }}>
                <div class="spread"><span class="small muted">Run in a terminal</span><CopyButton text={claudeCodeCmd(connect)} /></div>
                <pre class="snippet wrap">{claudeCodeCmd(connect)}</pre>
              </div>
            ) : (
              <div class="stack" style={{ gap: 6 }}>
                <div class="spread"><span class="small muted">Add to your agent's MCP config</span><CopyButton text={mcpConfig(connect)} /></div>
                <pre class="snippet">{mcpConfig(connect)}</pre>
              </div>
            )}
            <p class="hint" style={{ marginTop: 6 }}>The connection string holds only the bucket ID, admin public key and relays. It contains no secrets.</p>
          </li>
        </ol>
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
