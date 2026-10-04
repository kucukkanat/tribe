import type { Event, Filter } from "nostr-tools";

/** Persistence for raw events + key/value (decrypted cache, bucket state, summaries). */
export interface Store {
  putEvents(events: Event[]): Promise<void>;
  getEvent(id: string): Promise<Event | undefined>;
  queryEvents(filter: Filter): Promise<Event[]>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  setMany(entries: [string, unknown][]): Promise<void>;
  delete(key: string): Promise<void>;
  /** All key/values whose key starts with prefix. */
  list<T = unknown>(prefix: string): Promise<{ key: string; value: T }[]>;
}
