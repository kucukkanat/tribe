// Demo mode: everything runs against an in-memory MockPool + MemoryStore.
// We build the demo through the real core API (create, invite, join, write),
// so the demo exercises the same code paths as live mode.
import { Bucket, Identity, MemoryStore, type Pool, type Store } from "./core";
import { setLocalName } from "./members";

type Seed = { key: string; type: "fact" | "page"; title: string; body: string; tags: string[]; by: "maya" | "jonas" | "priya" | "agent"; links?: string[] };

const FACTS: Seed[] = [
  { key: "deploy-window", type: "fact", by: "maya", title: "Production deploys: Tue–Thu, 09:00–15:00 CET", tags: ["conventions", "deploy"],
    body: "We deploy to production only Tuesday to Thursday between 09:00 and 15:00 CET.\n\nOutside that window you need an explicit OK from the on-call lead in `#ops-oncall`. Fridays are for **merging to main only**, never for releasing." },
  { key: "pr-size", type: "fact", by: "jonas", title: "Keep pull requests under ~400 changed lines", tags: ["conventions", "review"],
    body: "Reviews above ~400 changed lines get rubber-stamped. Split by layer (schema → service → UI) and stack PRs instead.\n\nGenerated files (lockfiles, snapshots) don't count." },
  { key: "commit-style", type: "fact", by: "jonas", title: "Commit messages follow Conventional Commits", tags: ["conventions", "git"],
    body: "`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`. The release tool builds changelogs from these, so a wrong prefix means a wrong changelog." },
  { key: "flags", type: "fact", by: "priya", title: "Feature flags are removed within two sprints of 100% rollout", tags: ["conventions", "flags"],
    body: "Once a flag is at 100% for all markets, open a cleanup ticket the same day. Stale flags caused the March checkout outage (see *Incident: checkout 502s*)." },
  { key: "tz", type: "fact", by: "maya", title: "Store all timestamps as UTC; convert at the edge", tags: ["conventions", "data"],
    body: "Database columns are `timestamptz` and always written in UTC. Only the UI and exports convert to local time. Never compute business days in SQL." },
  { key: "pg-pool", type: "fact", by: "priya", title: "Postgres pool size is 20 per pod, not more", tags: ["database", "ops"],
    body: "With 12 pods at 20 connections we sit at 240 of the 300 allowed. Raising the pool size starves the migration job and the read replica sync." },
  { key: "migrations", type: "fact", by: "jonas", title: "Migrations must be backwards compatible for one release", tags: ["database", "deploy"],
    body: "Expand → migrate → contract. Never drop or rename a column in the same release that stops using it. Old pods are still running during rollout." },
  { key: "inc-checkout", type: "fact", by: "priya", title: "Incident: checkout 502s were caused by a stale feature flag", tags: ["incident", "checkout", "flags"],
    body: "**What happened:** a flag at 100% was still evaluated per request, and the flag service rate-limited us at peak.\n\n**Fix:** removed the flag, added a local cache with 30s TTL.\n\n**Learning:** flag lookups are a network dependency. Treat them like one." },
  { key: "inc-cert", type: "fact", by: "maya", title: "Incident: internal TLS cert expired on the payments gateway", tags: ["incident", "payments", "certificates"],
    body: "The cert was issued manually in 2024 and not in cert-manager. Alerts went to a deleted mailbox.\n\nAll certs now live in cert-manager; expiry alerts page the on-call rotation 14 days ahead." },
  { key: "inc-queue", type: "fact", by: "agent", title: "Incident: order-events consumer lag after partition rebalance", tags: ["incident", "kafka", "orders"],
    body: "Consumer lag spiked to 40k after a broker restart triggered a rebalance with `max.poll.interval.ms` at the default.\n\nSet `max.poll.interval.ms=600000` and reduced `max.poll.records` to 200 for the order-events consumer group." },
  { key: "kafka-keys", type: "fact", by: "agent", title: "Order events are keyed by orderId to keep per-order ordering", tags: ["kafka", "orders"],
    body: "Do not change the message key to customerId: consumers rely on per-order ordering for status transitions." },
  { key: "oncall-handover", type: "fact", by: "maya", title: "On-call handover happens Monday 10:00 in the team channel", tags: ["oncall", "process"],
    body: "Outgoing on-call posts: open incidents, silenced alerts, anything flaky. Incoming acknowledges in thread. No handover, no swap." },
  { key: "runbook-location", type: "fact", by: "priya", title: "Runbooks live next to the service, in /docs/runbook.md", tags: ["oncall", "docs"],
    body: "Not in the wiki. A runbook in the repo gets reviewed with the code that changes it." },
  { key: "alert-ownership", type: "fact", by: "jonas", title: "Every alert has an owning team label", tags: ["oncall", "alerts"],
    body: "Alerts without `team=` are dropped by Alertmanager routing on purpose. Add the label in the alert rule, not in the receiver." },
  { key: "api-versioning", type: "fact", by: "jonas", title: "Public APIs are versioned in the path: /v1, /v2", tags: ["api", "conventions"],
    body: "Header-based versioning confused partners and caches. Path versions only. Deprecate with a `Sunset` header and 6 months notice." },
  { key: "pagination", type: "fact", by: "agent", title: "List endpoints use cursor pagination, max page size 200", tags: ["api"],
    body: "Offset pagination broke on the orders table above ~2M rows. Use opaque cursors (`next`), cap `limit` at 200." },
  { key: "idempotency", type: "fact", by: "priya", title: "POST endpoints that create money movement require Idempotency-Key", tags: ["api", "payments"],
    body: "Keys are stored for 24h. A replay with the same key and a different body returns `422`, not the original response." },
  { key: "test-data", type: "fact", by: "agent", title: "Integration tests use the `fixtures/` factory, never prod snapshots", tags: ["testing", "data"],
    body: "Production snapshots contain personal data and are not allowed in CI, even anonymized. Use `fixtures/orders.ts` factories." },
  { key: "flaky", type: "fact", by: "agent", title: "Quarantine flaky tests with @flaky and a ticket link", tags: ["testing", "process"],
    body: "Tag the test `@flaky(TICKET-123)`. Quarantined tests still run nightly; they are only skipped on PR builds. Max 2 weeks in quarantine." },
  { key: "local-env", type: "fact", by: "jonas", title: "Local stack: `bun run dev:stack` starts Postgres, Kafka and the mocks", tags: ["onboarding", "tooling"],
    body: "Needs Docker with 8 GB memory. First run pulls ~3 GB of images. If Kafka fails to start, delete the `kafka-data` volume." },
  { key: "access", type: "fact", by: "maya", title: "New joiners request prod read access via the access portal", tags: ["onboarding", "security"],
    body: "Read access is approved by the team lead, write access needs a second approver from the platform team. Access expires after 90 days." },
  { key: "secrets", type: "fact", by: "priya", title: "Secrets come from Vault; never from .env files in the repo", tags: ["security", "conventions"],
    body: "`.env` is git-ignored and only for local mocks. CI and pods read from Vault via the sidecar." },
  { key: "agent-scope", type: "fact", by: "maya", title: "Agents may write facts but not edit pages", tags: ["agents", "process"],
    body: "Coding agents record what they learn as facts with `source: agent`. Humans curate pages. If an agent fact is wrong, edit it and say why." },
  { key: "agent-tests", type: "fact", by: "agent", title: "Run `bun test --filter changed` before proposing a change", tags: ["agents", "testing"],
    body: "Full suite takes ~9 minutes. The filtered run covers changed packages and their dependents and takes under a minute." },
  { key: "cache-ttl", type: "fact", by: "priya", title: "Product catalog cache TTL is 5 minutes", tags: ["performance", "catalog"],
    body: "Price changes must be visible within 5 minutes per the commercial agreement. Do not raise the TTL without asking pricing." },
  { key: "retry", type: "fact", by: "agent", title: "HTTP clients retry with exponential backoff, max 3 attempts", tags: ["api", "resilience"],
    body: "Base 200 ms, factor 2, full jitter. Only retry idempotent methods or requests with an Idempotency-Key." },
];

const PAGES: Seed[] = [
  { key: "page-oncall", type: "page", by: "maya", title: "On-call survival guide", tags: ["oncall", "guide"],
    links: ["oncall-handover", "runbook-location", "alert-ownership", "inc-cert", "inc-queue"],
    body: "# On-call survival guide\n\nYou are on call for a week, Monday to Monday. This page collects what we keep relearning.\n\n## Before your shift\n- Read the handover thread.\n- Check that your phone gets test pages.\n\n## During an incident\n1. Acknowledge the page.\n2. Open the runbook for the service.\n3. Post in `#ops-incidents` every 30 minutes, even if nothing changed.\n\n## Afterwards\nWrite the learning down as a fact in Tribe, tagged `incident`. Agents read these." },
  { key: "page-deploy", type: "page", by: "jonas", title: "How we ship", tags: ["deploy", "guide"],
    links: ["deploy-window", "migrations", "flags", "pr-size", "commit-style"],
    body: "# How we ship\n\nSmall PRs, backwards-compatible migrations, flags for anything risky, deploys in the window.\n\n| Step | Who |\n|---|---|\n| Review | Any teammate |\n| Merge | Author |\n| Deploy | Author, inside the window |\n| Flag rollout | Author + PM |" },
  { key: "page-onboarding", type: "page", by: "priya", title: "First week checklist", tags: ["onboarding", "guide"],
    links: ["local-env", "access", "secrets", "test-data"],
    body: "# First week checklist\n\n- [ ] Get the local stack running\n- [ ] Request prod read access\n- [ ] Pair with on-call for one incident review\n- [ ] Add one fact to Tribe that surprised you" },
];

const NAMES = { maya: "Maya Lindqvist", jonas: "Jonas Becker", priya: "Priya Raman", sam: "Sam Okafor" } as const;

/**
 * Core stamps events with Date.now(). To make the demo history look lived-in,
 * seed on a simulated clock starting ~6 weeks ago, then restore the real clock.
 */
export async function seedDemo(pool: Pool, store: Store): Promise<{ identity: Identity; bucket: Bucket }> {
  const realNow = Date.now;
  let t = realNow() - 44 * 86400_000;
  Date.now = () => t;
  // deterministic jitter so screenshots are stable-ish
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tick = (hours: number) => { t = Math.min(t + hours * 3600_000 * (0.6 + rnd() * 0.8), realNow() - 60_000); };
  try { return await seedInner(pool, store, tick); }
  finally { Date.now = realNow; }
}

async function seedInner(pool: Pool, store: Store, tick: (h: number) => void): Promise<{ identity: Identity; bucket: Bucket }> {
  const maya = Identity.generate();
  setLocalName(maya.pk, NAMES.maya);
  const admin = await Bucket.create({ identity: maya, name: "Platform team", pool, store });

  // Members join through real invites, each with their own store.
  const joinAs = async (who: keyof typeof NAMES, label: string) => {
    const id = Identity.generate();
    const { link } = await admin.createInvite({ label, singleUse: true, expiresInDays: 7, baseUrl: location.origin + location.pathname });
    tick(20);
    const b = await Bucket.joinWithInvite({ identity: id, link, name: NAMES[who], pool, store: new MemoryStore() });
    return { id, b };
  };
  const jonas = await joinAs("jonas", "Jonas");
  const priya = await joinAs("priya", "Priya");
  await admin.sync();
  // Make roster names nice, and promote Jonas to co-admin.
  try { await admin.setRole(jonas.id.pk, "admin"); } catch {}

  // An agent paired as Priya's device.
  const agentId = Identity.generate();
  await priya.b.sync();
  await priya.b.addDevice(agentId.pk, "claude-code on priya-mbp", "agent");
  let agent: Bucket | null = null;
  try {
    agent = await Bucket.open({ identity: agentId, bucketId: admin.bucketId, pool, store: new MemoryStore(), adminHint: maya.pk });
    await agent.sync();
  } catch (e) { console.warn("demo agent open failed; writing as Priya", e); }

  const writers: Record<Seed["by"], Bucket> = { maya: admin, jonas: jonas.b, priya: priya.b, agent: agent ?? priya.b };
  for (const w of new Set(Object.values(writers))) if (w !== admin) await w.sync();

  const ids = new Map<string, string>();
  for (const s of FACTS) {
    tick(28);
    const v = await writers[s.by].write({
      type: s.type, title: s.title, body: s.body, tags: s.tags,
      source: s.by === "agent" ? "agent:claude-code" : "human",
    });
    ids.set(s.key, v.entryId);
  }
  for (const s of PAGES) {
    tick(30);
    const v = await writers[s.by].write({
      type: "page", title: s.title, body: s.body, tags: s.tags, links: (s.links ?? []).map((k) => ids.get(k)!).filter(Boolean), source: "human",
    });
    ids.set(s.key, v.entryId);
  }

  tick(40);
  // History: a second version of the PR-size fact.
  await admin.sync();
  const pr = admin.get(ids.get("pr-size")!);
  if (pr) {
    await admin.write({ entryId: pr.entryId, type: "fact", title: pr.head.title, tags: [...pr.head.tags, "github"], prev: pr.head.id,
      body: pr.head.body + "\n\nUse the `stack` label so reviewers know the order." });
  }

  tick(30);
  // A conflict: Jonas and the agent both edit the Postgres pool fact from the same version.
  await jonas.b.sync();
  const pg = jonas.b.get(ids.get("pg-pool")!);
  if (pg) {
    await jonas.b.write({ entryId: pg.entryId, type: "fact", prev: pg.head.id, tags: pg.head.tags, title: "Postgres pool size is 25 per pod since the PgBouncer rollout",
      body: "PgBouncer in transaction mode sits in front of Postgres now, so each pod can hold 25 client connections. The 300 limit applies to PgBouncer's server pool, not pods." });
    tick(2);
    const w = writers.agent;
    await w.sync();
    await w.write({ entryId: pg.entryId, type: "fact", prev: pg.head.id, tags: [...pg.head.tags, "pgbouncer"], source: "agent:claude-code", title: pg.head.title,
      body: pg.head.body + "\n\nObserved during load test on 2026-09-30: at 22 per pod the migration job timed out acquiring a connection." });
  }

  tick(18);
  // A pending access request from someone without an invite.
  const sam = Identity.generate();
  try {
    await Bucket.requestAccess({ identity: sam, bucketId: admin.bucketId, adminPk: maya.pk, relays: admin.relays, name: NAMES.sam,
      message: "Joining the platform team from payments next week — Maya said to request access here.", pool });
  } catch (e) { console.warn("demo requestAccess failed", e); }

  // An open invite so the Members screen has something to show.
  try { await admin.createInvite({ label: "Design contractors", singleUse: false, expiresInDays: 14, baseUrl: location.origin + location.pathname }); } catch {}

  await admin.sync();
  return { identity: maya, bucket: admin };
}

