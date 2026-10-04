/**
 * Pure MCP tool handlers. Each takes a Bucket + context and returns plain JSON,
 * so they can be unit-tested without an MCP transport.
 */
import { z } from "zod";
import type { Bucket, Entry, EntryVersion } from "./core.ts";

export interface ToolContext {
  bucket: Bucket;
  /** Device label; entries are written with source `agent:<label>`. */
  label: string;
}

export class ToolError extends Error {}

// ---- limits -----------------------------------------------------------------
export const LIMITS = {
  titleMax: 200,
  bodyMaxBytes: 60_000, // SPEC: max entry body 60KB (nip44 cap is 65535)
  tagsMax: 20,
  tagMax: 48,
  linksMax: 500,
  searchMax: 50,
  recentMax: 100,
  snippetChars: 220,
};

// ---- schemas (raw zod shapes for McpServer.registerTool) ---------------------
const entryIdSchema = z.string().min(1).max(128);

export const schemas = {
  memory_search: {
    query: z.string().max(500).describe("Keywords to search for (title, body, tags). Use a few distinctive terms, not a full sentence. Empty string lists everything matching the filters."),
    type: z.enum(["fact", "page"]).optional().describe('Restrict to "fact" (small atomic knowledge) or "page" (longer doc that links facts).'),
    tag: z.string().max(LIMITS.tagMax).optional().describe("Only return entries carrying this tag (see memory_list_tags)."),
    limit: z.number().int().min(1).max(LIMITS.searchMax).optional().describe("Max results (default 10)."),
  },
  memory_get: {
    entryId: entryIdSchema.describe("Entry id returned by memory_search / memory_recent / memory_write."),
  },
  memory_write: {
    entryId: entryIdSchema.optional().describe("Omit to create a new entry. Pass an existing entryId to write a new version of it (fetch it with memory_get first and send the full updated body)."),
    type: z.enum(["fact", "page"]).optional().describe('"fact" (default for new entries): one atomic, self-contained piece of knowledge. "page": a longer write-up/runbook that links related facts.'),
    title: z.string().min(1).max(LIMITS.titleMax).describe("Short, specific, searchable title (e.g. \"Staging DB is Postgres 16 on db-stg-1\")."),
    body: z.string().max(LIMITS.bodyMaxBytes).describe("Markdown body. Full content of this version (not a diff). Max ~60KB."),
    tags: z.array(z.string().min(1).max(LIMITS.tagMax)).max(LIMITS.tagsMax).optional().describe("Lowercase topic tags, e.g. [\"infra\",\"postgres\"]. Reuse existing tags (memory_list_tags). On update, omit to keep current tags."),
    links: z.array(entryIdSchema).max(LIMITS.linksMax).optional().describe("Entry ids this entry links to (pages usually link facts). On update, omit to keep current links."),
  },
  memory_link: {
    pageId: entryIdSchema.describe("Entry id of a page."),
    factIds: z.array(entryIdSchema).min(1).max(LIMITS.linksMax).describe("Entry ids to append to the page's links (duplicates ignored)."),
  },
  memory_list_tags: {},
  memory_recent: {
    limit: z.number().int().min(1).max(LIMITS.recentMax).optional().describe("Max entries (default 20)."),
  },
} as const;

export const descriptions: Record<keyof typeof schemas, string> = {
  memory_search:
    "Search the team's shared, encrypted memory (facts and pages written by teammates and their agents). " +
    "Call this BEFORE answering questions about the team's systems, conventions, decisions, people or past incidents, " +
    "and before writing a new entry (to avoid duplicates — update the existing one instead). Keyword search; returns compact hits with snippets. Use memory_get for full content.",
  memory_get:
    "Fetch one memory entry in full: current version body, tags, links (with titles), backlinks (entries linking here), version count and conflict status.",
  memory_write:
    "Store durable team knowledge in shared memory. Use for facts worth remembering across sessions and teammates: decisions and their rationale, how-tos, gotchas, environment details, owners, conventions. " +
    "Do NOT store secrets/credentials, personal data, or transient chatter. Keep facts atomic (one idea each) with a specific title. " +
    "To update, pass entryId (a new version is appended; history is kept). Returns entryId and versionId.",
  memory_link:
    "Append links from a page to existing facts (creates a new version of the page). Use to organize related facts under a topic page.",
  memory_list_tags: "List all tags in team memory with usage counts. Use to pick consistent tags before writing and to discover topics.",
  memory_recent: "List the most recently updated memory entries (newest first). Useful to see what the team has been recording lately.",
};

// ---- helpers ------------------------------------------------------------------
const live = (e: Entry) => !e.head.deleted;

function authorOf(bucket: Bucket, v: EntryVersion): { pk: string; name?: string; source: string } {
  const m = bucket.roster?.members.find((x) => x.pk === v.authorMember);
  return { pk: v.authorMember, ...(m?.name ? { name: m.name } : {}), source: v.source };
}

function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

export function snippet(body: string, query: string, max = LIMITS.snippetChars): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, max - 1) + "…";
  const start = Math.max(0, at - Math.floor(max / 3));
  const end = Math.min(flat.length, start + max);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

function summarize(bucket: Bucket, e: Entry, query = "") {
  const h = e.head;
  return {
    entryId: e.entryId,
    type: h.type,
    title: h.title,
    tags: h.tags,
    snippet: snippet(h.body, query),
    author: authorOf(bucket, h),
    updatedAt: iso(h.createdAt),
    ...(e.conflict ? { conflict: true } : {}),
  };
}

function normTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const n = t.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
    if (!n) continue;
    if (n.length > LIMITS.tagMax) throw new ToolError(`Tag "${t}" is longer than ${LIMITS.tagMax} characters; use a shorter tag.`);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > LIMITS.tagsMax) throw new ToolError(`Too many tags (${out.length}); max ${LIMITS.tagsMax}.`);
  return out;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
}

function requireEntry(bucket: Bucket, entryId: string): Entry {
  const e = bucket.get(entryId);
  if (!e || e.head.deleted) {
    throw new ToolError(`No entry with id "${entryId}". Use memory_search or memory_recent to find valid entry ids.`);
  }
  return e;
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ---- handlers -----------------------------------------------------------------
type Infer<S extends Record<string, z.ZodTypeAny>> = z.infer<z.ZodObject<S>>;

export function memorySearch(ctx: ToolContext, args: Infer<typeof schemas.memory_search>) {
  const limit = Math.min(args.limit ?? 10, LIMITS.searchMax);
  const q = args.query.trim();
  const tag = args.tag ? args.tag.trim().toLowerCase().replace(/^#/, "") : undefined;
  let hits: Entry[];
  if (!q) {
    hits = ctx.bucket
      .entries()
      .filter(live)
      .filter((e) => (!args.type || e.head.type === args.type) && (!tag || e.head.tags.includes(tag)))
      .sort((a, b) => b.head.createdAt - a.head.createdAt);
  } else {
    hits = ctx.bucket.search(q, { type: args.type, tag, limit: limit * 2 }).filter(live);
  }
  const results = hits.slice(0, limit).map((e) => summarize(ctx.bucket, e, q));
  return {
    query: q,
    count: results.length,
    results,
    ...(results.length === 0
      ? { hint: "No matches. Try fewer or different keywords, drop the type/tag filter, or check memory_list_tags." }
      : {}),
  };
}

export function memoryGet(ctx: ToolContext, args: Infer<typeof schemas.memory_get>) {
  const e = requireEntry(ctx.bucket, args.entryId);
  const h = e.head;
  const linkInfo = h.links.map((id) => {
    const t = ctx.bucket.get(id);
    return t && !t.head.deleted ? { entryId: id, type: t.head.type, title: t.head.title } : { entryId: id, missing: true };
  });
  const backlinks = ctx.bucket
    .backlinks(e.entryId)
    .filter(live)
    .map((b) => ({ entryId: b.entryId, type: b.head.type, title: b.head.title }));
  const result: Record<string, unknown> = {
    entryId: e.entryId,
    versionId: h.id,
    type: h.type,
    title: h.title,
    body: h.body,
    tags: h.tags,
    links: linkInfo,
    backlinks,
    author: authorOf(ctx.bucket, h),
    updatedAt: iso(h.createdAt),
    versionCount: e.versions.length,
    conflict: e.conflict,
  };
  if (e.conflict) {
    const heads = conflictHeads(e);
    result.conflictingVersions = heads.map((v) => ({
      versionId: v.id,
      title: v.title,
      author: authorOf(ctx.bucket, v),
      createdAt: iso(v.createdAt),
      body: v.body,
    }));
    result.hint = "This entry has concurrent edits. Merge them and call memory_write with this entryId to resolve.";
  }
  return result;
}

/** Versions not superseded by any other version (a conflict = ≥2 of these). */
function conflictHeads(e: Entry): EntryVersion[] {
  const superseded = new Set(e.versions.map((v) => v.prev).filter(Boolean) as string[]);
  return e.versions.filter((v) => !superseded.has(v.id));
}

export async function memoryWrite(ctx: ToolContext, args: Infer<typeof schemas.memory_write>) {
  const title = args.title.trim().replace(/\s+/g, " ");
  if (!title) throw new ToolError("title must not be empty.");
  if (title.length > LIMITS.titleMax) throw new ToolError(`title is ${title.length} chars; max ${LIMITS.titleMax}. Put details in body.`);
  const body = args.body;
  const bytes = byteLen(body);
  if (bytes > LIMITS.bodyMaxBytes) {
    throw new ToolError(
      `body is ${bytes} bytes; max ${LIMITS.bodyMaxBytes}. Split it into several facts and a page that links them (memory_link).`,
    );
  }

  let existing: Entry | undefined;
  if (args.entryId) existing = requireEntry(ctx.bucket, args.entryId);

  const type = args.type ?? existing?.head.type ?? "fact";
  const tags = args.tags ? normTags(args.tags) : (existing?.head.tags ?? []);
  const links = args.links ? dedupe(args.links) : (existing?.head.links ?? []);
  if (links.length > LIMITS.linksMax) throw new ToolError(`Too many links (${links.length}); max ${LIMITS.linksMax}.`);
  if (existing && links.includes(existing.entryId)) throw new ToolError("An entry cannot link to itself.");
  const unknown = links.filter((id) => !ctx.bucket.get(id) && !(existing?.head.links ?? []).includes(id));
  if (unknown.length) {
    throw new ToolError(`Unknown link target(s): ${unknown.join(", ")}. Links must be existing entryIds (create the facts first).`);
  }

  const v = await ctx.bucket.write({
    ...(existing ? { entryId: existing.entryId, prev: existing.head.id } : {}),
    type,
    title,
    body,
    tags,
    links,
    source: `agent:${ctx.label}`,
  });
  return {
    entryId: v.entryId,
    versionId: v.id,
    created: !existing,
    type: v.type,
    title: v.title,
    ...(existing?.conflict ? { note: "Previous conflict resolved by this version." } : {}),
  };
}

export async function memoryLink(ctx: ToolContext, args: Infer<typeof schemas.memory_link>) {
  const page = requireEntry(ctx.bucket, args.pageId);
  if (page.head.type !== "page") {
    throw new ToolError(`Entry "${args.pageId}" is a ${page.head.type}, not a page. Create a page (memory_write type="page") and link facts to it.`);
  }
  const ids = dedupe(args.factIds);
  const missing = ids.filter((id) => !ctx.bucket.get(id) || ctx.bucket.get(id)!.head.deleted);
  if (missing.length) throw new ToolError(`Unknown entry id(s): ${missing.join(", ")}.`);
  if (ids.includes(page.entryId)) throw new ToolError("A page cannot link to itself.");
  const toAdd = ids.filter((id) => !page.head.links.includes(id));
  if (toAdd.length === 0) {
    return { entryId: page.entryId, versionId: page.head.id, added: [], links: page.head.links, note: "All ids were already linked; no new version written." };
  }
  const links = [...page.head.links, ...toAdd];
  if (links.length > LIMITS.linksMax) throw new ToolError(`Page would have ${links.length} links; max ${LIMITS.linksMax}.`);
  const h = page.head;
  const v = await ctx.bucket.write({
    entryId: page.entryId,
    prev: h.id,
    type: h.type,
    title: h.title,
    body: h.body,
    tags: h.tags,
    links,
    source: `agent:${ctx.label}`,
  });
  return { entryId: v.entryId, versionId: v.id, added: toAdd, links: v.links };
}

export function memoryListTags(ctx: ToolContext, _args: Record<string, never> = {}) {
  const tags = [...ctx.bucket.tags()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { count: tags.length, tags };
}

export function memoryRecent(ctx: ToolContext, args: Infer<typeof schemas.memory_recent>) {
  const limit = Math.min(args.limit ?? 20, LIMITS.recentMax);
  const list = ctx.bucket
    .entries()
    .filter(live)
    .sort((a, b) => b.head.createdAt - a.head.createdAt || (a.head.id < b.head.id ? 1 : -1))
    .slice(0, limit)
    .map((e) => summarize(ctx.bucket, e));
  return { count: list.length, results: list };
}

export const handlers = {
  memory_search: memorySearch,
  memory_get: memoryGet,
  memory_write: memoryWrite,
  memory_link: memoryLink,
  memory_list_tags: memoryListTags,
  memory_recent: memoryRecent,
} as const;

export type ToolName = keyof typeof handlers;
