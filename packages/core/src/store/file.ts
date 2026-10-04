import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Event } from "nostr-tools";
import { MemoryStore } from "./memory.ts";

export type { Store } from "./types.ts";

/**
 * Node/Bun store: a single JSON file (default ~/.tribe/store.json). All data is kept in memory and
 * flushed (debounced, atomic rename) on writes. Call `flush()` before exit to be safe.
 * Note: SPEC mentions one file per bucket; a single file works for multi-bucket listMine. Pass a path to override.
 */
export class FileStore extends MemoryStore {
  readonly path: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  debounceMs: number;
  constructor(path?: string, opts?: { debounceMs?: number }) {
    super();
    this.path = path ?? join(process.env.TRIBE_HOME ?? join(homedir(), ".tribe"), "store.json");
    this.debounceMs = opts?.debounceMs ?? 200;
    if (existsSync(this.path)) {
      try {
        const data = JSON.parse(readFileSync(this.path, "utf8")) as { events: Event[]; kv: [string, unknown][] };
        for (const e of data.events ?? []) this.events.add(e);
        for (const [k, v] of data.kv ?? []) this.kv.set(k, v);
      } catch { /* corrupt file: start fresh */ }
    }
  }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs);
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ events: [...this.events.byId.values()], kv: [...this.kv.entries()] }));
    renameSync(tmp, this.path);
  }
  override async putEvents(events: Event[]) { await super.putEvents(events); this.schedule(); }
  override async set(k: string, v: unknown) { await super.set(k, v); this.schedule(); }
  override async setMany(e: [string, unknown][]) { await super.setMany(e); this.schedule(); }
  override async delete(k: string) { await super.delete(k); this.schedule(); }
}
