import { useEffect, useState } from "preact/hooks";
import QRCode from "qrcode";
import { Shell } from "../components/Shell";
import { Avatar, CopyButton, Dialog, Empty, useAction, useConfirm } from "../components/ui";
import { IPlus } from "../components/icons";
import type { Bucket, Invite, Member } from "../lib/core";
import { state, useBucket } from "../lib/state";
import { ago, fullDate, plural, shortNpub } from "../lib/format";
import { BucketGate } from "./BucketGate";
import { memberName } from "../lib/members";

export function Members({ bucketId }: { bucketId: string }) {
  const { bucket, error } = useBucket(bucketId);
  return (
    <Shell bucket={bucket} tab="members">
      <BucketGate bucket={bucket} error={error}>{bucket && <MembersView bucket={bucket} />}</BucketGate>
    </Shell>
  );
}

function inviteState(i: Invite): { label: string; cls: string; live: boolean } {
  if (i.revoked) return { label: "Revoked", cls: "", live: false };
  if (i.expiresAt && i.expiresAt * 1000 < Date.now() && i.expiresAt < 1e12) return { label: "Expired", cls: "", live: false };
  if (i.singleUse && (i.usedBy?.length ?? 0) > 0) return { label: "Used", cls: "", live: false };
  return { label: i.singleUse ? "Single use" : "Reusable", cls: "moss", live: true };
}

function MembersView({ bucket }: { bucket: Bucket }) {
  const admin = bucket.isAdmin();
  const me = state.identity?.pk;
  const roster = bucket.roster;
  const members = [...(roster?.members ?? [])].sort((a, b) => (a.role === b.role ? a.addedAt - b.addedAt : a.role === "admin" ? -1 : 1));
  const pending = admin ? safe(() => bucket.pendingRequests().filter((r) => !r.autoAccepted && !isDenied(bucket.bucketId, r.pk) && !roster?.members.some((m) => m.pk === r.pk)), []) : [];
  const invites = [...(roster?.invites ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const [inviteOpen, setInviteOpen] = useState(() => location.hash.includes("invite=1"));
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const adminCount = members.filter((m) => m.role === "admin").length;

  const remove = async (m: Member) => {
    const ok = await confirm.ask(`Remove ${memberName(bucket, m.pk)}?`, <>
      <p>Tribe will rotate the bucket key. They won't be able to read anything written from now on, and their devices and agents lose access too.</p>
      <p><b>Rotation is future-only.</b> Anything they already synced stays on their devices. If they had access to secrets, rotate those secrets separately.</p>
    </>, "Remove and rotate keys", true);
    if (ok) await run(() => bucket.removeMember(m.pk), "Member removed. Keys rotated.");
  };

  return (
    <>
      <div class="page-head">
        <div><h1>Members</h1><p>{plural(members.length, "person", "people")} · key epoch {bucket.epoch}</p></div>
        {admin && <button class="btn primary" onClick={() => setInviteOpen(true)}><IPlus size={16} />Invite</button>}
      </div>
      {!admin && <div class="banner indigo small"><div>Only admins can invite, approve or remove people.</div></div>}

      {admin && pending.length > 0 && (
        <>
          <h2 class="section-title">Waiting for approval <span class="badge amber">{pending.length}</span></h2>
          <div class="list">
            {pending.map((r) => (
              <div class="li">
                <Avatar pk={r.pk} name={r.name} />
                <div class="grow">
                  <div style={{ fontWeight: 600 }}>{r.name || shortNpub(r.pk)}</div>
                  <div class="small muted">{r.message ? `“${r.message}”` : "No message"} · {ago(r.createdAt)}</div>
                </div>
                <div class="row">
                  <button class="btn sm" disabled={busy} onClick={() => run(async () => { await deny(bucket, r.pk); }, "Request dismissed")}>Deny</button>
                  <button class="btn sm primary" disabled={busy} onClick={() => run(() => bucket.approve(r.pk, "member"), `${r.name || "Member"} approved`)}>Approve</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 class="section-title">People</h2>
      <div class="list">
        {members.map((m) => (
          <div class="li">
            <Avatar pk={m.pk} name={memberName(bucket, m.pk)} />
            <div class="grow">
              <div style={{ fontWeight: 600 }}>{memberName(bucket, m.pk)}{m.pk === me && <span class="muted" style={{ fontWeight: 400 }}> (you)</span>}</div>
              <div class="small muted"><span class="mono">{shortNpub(m.pk)}</span> · joined {ago(m.addedAt)}{m.viaInvite ? " via invite" : ""}</div>
            </div>
            <span class={`badge ${m.role === "admin" ? "moss" : ""}`}>{m.role === "admin" ? "Admin" : "Member"}</span>
            {admin && m.pk !== me && (
              <div class="row">
                {m.role === "member"
                  ? <button class="btn sm" disabled={busy} onClick={() => run(() => bucket.setRole(m.pk, "admin"), "Promoted to admin")}>Make admin</button>
                  : <button class="btn sm" disabled={busy || adminCount < 2} onClick={() => run(() => bucket.setRole(m.pk, "member"), "Changed to member")}>Make member</button>}
                <button class="btn sm danger" disabled={busy} onClick={() => void remove(m)}>Remove</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {admin && (
        <>
          <h2 class="section-title">Invites</h2>
          {invites.length === 0 ? <div class="panel"><Empty title="No invites yet" action={<button class="btn" onClick={() => setInviteOpen(true)}>Create an invite</button>}>An invite link lets someone join straight away, without waiting for approval.</Empty></div> : (
            <div class="list">
              {invites.map((i) => {
                const s = inviteState(i);
                return (
                  <div class="li">
                    <div class="grow">
                      <div style={{ fontWeight: 600 }}>{i.label || "Untitled invite"}</div>
                      <div class="small muted">Created {ago(i.createdAt)}{i.expiresAt ? ` · expires ${fullDate(i.expiresAt)}` : " · never expires"} · used {i.usedBy?.length ?? 0}×</div>
                    </div>
                    <span class={`badge ${s.cls}`}>{s.label}</span>
                    {s.live && <button class="btn sm danger" disabled={busy} onClick={() => run(() => bucket.revokeInvite(i.id), "Invite revoked")}>Revoke</button>}
                  </div>
                );
              })}
            </div>
          )}
          <h2 class="section-title">Keys</h2>
          <div class="panel spread" style={{ flexWrap: "wrap" }}>
            <p class="small muted grow" style={{ minWidth: 220 }}>Rotate if a device may be compromised. New entries use a fresh key that only current members and devices receive.</p>
            <button class="btn" disabled={busy} onClick={async () => {
              if (await confirm.ask("Rotate keys now?", <p>Everyone currently in the bucket gets the new key automatically. Older entries stay readable.</p>, "Rotate keys"))
                await run(() => bucket.rotate(), "Keys rotated");
            }}>Rotate keys now</button>
          </div>
        </>
      )}
      {inviteOpen && <InviteDialog bucket={bucket} onClose={() => { setInviteOpen(false); if (location.hash.includes("?")) history.replaceState(null, "", location.hash.split("?")[0]); }} />}
      {confirm.node}
    </>
  );
}

async function deny(bucket: Bucket, pk: string) {
  // Core has no deny(); requests are just ignored. Remember the dismissal locally.
  const b = bucket as unknown as { deny?: (pk: string) => Promise<void> };
  if (typeof b.deny === "function") return b.deny(pk);
  try {
    const k = `tribe.denied.${bucket.bucketId}`;
    const set = new Set<string>(JSON.parse(localStorage.getItem(k) ?? "[]"));
    set.add(pk); localStorage.setItem(k, JSON.stringify([...set]));
  } catch {}
  dismissed.add(pk);
}
const dismissed = new Set<string>(); // in-memory for demo
export function isDenied(bucketId: string, pk: string) {
  if (dismissed.has(pk)) return true;
  try { return (JSON.parse(localStorage.getItem(`tribe.denied.${bucketId}`) ?? "[]") as string[]).includes(pk); } catch { return false; }
}

function InviteDialog({ bucket, onClose }: { bucket: Bucket; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [single, setSingle] = useState(true);
  const [days, setDays] = useState("7");
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (link) QRCode.toDataURL(link, { margin: 1, width: 360, errorCorrectionLevel: "L" }).then(setQr, () => setQr(null));
  }, [link]);

  if (link) return (
    <Dialog title="Invite ready" onClose={onClose} actions={<button class="btn primary" onClick={onClose}>Done</button>}>
      <div class="invite-result">
        <div class="qr">{qr ? <img src={qr} alt="QR code for the invite link" /> : <div class="skeleton" style={{ width: "100%", height: "100%" }} />}</div>
        <div class="stack">
          <p class="small muted">Send this link privately. It contains the key that lets someone join{single ? ", and works once" : ""}.</p>
          <div class="linkbox">{link}</div>
          <CopyButton text={link} label="Copy link" class="btn primary" />
        </div>
      </div>
    </Dialog>
  );
  return (
    <Dialog title="Create invite" onClose={onClose} actions={<>
      <button class="btn" onClick={onClose}>Cancel</button>
      <button class="btn primary" disabled={busy} onClick={() => run(async () => {
        const r = await bucket.createInvite({ label: label.trim() || undefined, singleUse: single, expiresInDays: days === "0" ? undefined : Number(days), baseUrl: location.origin + location.pathname });
        setLink(r.link);
      })}>{busy ? "Creating…" : "Create invite"}</button>
    </>}>
      <label class="field"><span>Label</span><input class="input" value={label} onInput={(e) => setLabel(e.currentTarget.value)} placeholder="Who is it for?" /><span class="hint">Only admins see this.</span></label>
      <label class="field"><span>Expires</span>
        <select class="input" value={days} onChange={(e) => setDays(e.currentTarget.value)}>
          <option value="1">In 1 day</option><option value="7">In 7 days</option><option value="30">In 30 days</option><option value="0">Never</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" checked={single} onChange={(e) => setSingle(e.currentTarget.checked)} /><span>Single use<br /><span class="small muted">The first person to join uses it up.</span></span></label>
    </Dialog>
  );
}

function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
