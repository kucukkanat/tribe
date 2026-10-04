import MiniSearch from "minisearch";
import type { Entry } from "./types.ts";

interface Doc { id: string; title: string; body: string; tags: string[] }

export class SearchIndex {
  private ms: MiniSearch<Doc>;
  constructor() {
    this.ms = new MiniSearch<Doc>({
      fields: ["title", "body", "tags"],
      storeFields: [],
      extractField: (doc, f) => (f === "tags" ? (doc.tags ?? []).join(" ") : (doc as any)[f]),
      searchOptions: { boost: { title: 3, tags: 2 }, prefix: true, fuzzy: 0.2, combineWith: "AND" },
    });
  }
  private doc(e: Entry): Doc { return { id: e.entryId, title: e.head.title, body: e.head.body, tags: e.head.tags }; }
  /** Insert/replace/remove entry depending on head.deleted. */
  update(e: Entry) {
    if (this.ms.has(e.entryId)) this.ms.discard(e.entryId);
    if (!e.head.deleted) this.ms.add(this.doc(e));
  }
  addAll(entries: Iterable<Entry>) {
    const docs: Doc[] = [];
    for (const e of entries) { if (this.ms.has(e.entryId)) this.ms.discard(e.entryId); if (!e.head.deleted) docs.push(this.doc(e)); }
    this.ms.addAll(docs);
  }
  search(q: string): { id: string; score: number }[] {
    return this.ms.search(q).map((r) => ({ id: String(r.id), score: r.score }));
  }
  clear() { this.ms.removeAll(); }
}
