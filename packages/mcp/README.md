# tribe-mcp

MCP server (stdio) that gives AI agents read/write access to a **Tribe** bucket — your team's end-to-end encrypted agent memory stored on public Nostr relays.

The agent runs as a **device** of a team member: it has its own key, is paired from the web app, inherits that member's access, and everything it writes is attributed to the member (`authorMember`) with `source: "agent:<label>"`.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 (the CLI is TypeScript run directly by Bun).

## 1. Create a device key

```sh
bunx tribe-mcp init --label claude-laptop
```

This writes `~/.tribe/device.json` (mode `0600`; never overwritten unless you pass `--force`) and prints:

```
  label : claude-laptop
  npub  : npub1…
  hex pk: 3f2a…
```

Set `TRIBE_HOME` to use a directory other than `~/.tribe`.

## 2. Pair it

In the Tribe web app: open your bucket → **Devices & Agents → Pair an agent** → paste the npub. This publishes your device list and wraps the bucket's epoch keys to the device.

Check it worked (bucket id is shown in the web app under Settings):

```sh
bunx tribe-mcp status --bucket <bucketId>
```

You should see the bucket name, epoch, the owning member and the entry count. If you see **"Not paired yet"**, the device key has no grant — repeat the pairing step (and make sure you pasted the npub from *this* machine).

## 3. Serve

```sh
bunx tribe-mcp serve --bucket <bucketId> [--relays wss://relay.damus.io,wss://nos.lol]
```

The server syncs on start, keeps a live relay subscription (plus a 5-minute resync), and caches decrypted state in `~/.tribe/<bucketId>.json`. Logs go to stderr only.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tribe": {
      "command": "bunx",
      "args": ["tribe-mcp", "serve", "--bucket", "<bucketId>"]
    }
  }
}
```

(If Claude Desktop can't find `bunx`, use its absolute path, e.g. `~/.bun/bin/bunx`.)

### Claude Code

```sh
claude mcp add tribe -- bunx tribe-mcp serve --bucket <bucketId>
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "tribe": { "type": "stdio", "command": "bunx", "args": ["tribe-mcp", "serve", "--bucket", "<bucketId>"] }
  }
}
```

### Any MCP client

Spawn `bunx tribe-mcp serve --bucket <bucketId>` and speak MCP over stdin/stdout. Optional env: `TRIBE_HOME`.

From a checkout of this repo, use `bun /path/to/tribe/packages/mcp/src/cli.ts serve …` instead of `bunx tribe-mcp`.

## Tools

| Tool | Args | Returns |
|---|---|---|
| `memory_search` | `query`, `type?` (`fact`\|`page`), `tag?`, `limit?` (10, max 50) | compact hits: `entryId, type, title, tags, snippet, author, updatedAt, conflict?`. Empty query lists by recency. |
| `memory_get` | `entryId` | full head: body, tags, links (with titles), backlinks, author, `versionCount`, `conflict` (+ conflicting versions) |
| `memory_write` | `entryId?`, `type?` (`fact`), `title`, `body`, `tags?`, `links?` | `entryId, versionId, created`. With `entryId` writes a new version (`prev` = current head); omitted tags/links are kept. |
| `memory_link` | `pageId`, `factIds[]` | appends links to a page (new version); no-op if all already linked |
| `memory_list_tags` | — | tags with counts |
| `memory_recent` | `limit?` (20, max 100) | most recently updated entries |

Limits: title ≤ 200 chars, body ≤ 60 KB, ≤ 20 tags (lowercased, `#` stripped), ≤ 500 links. Links must point at existing entries. Errors are returned as MCP tool errors with a hint on how to fix the call.

## Development

```sh
bun test packages/mcp             # handler tests + stdio e2e (uses --mock)
npx tsc --noEmit -p packages/mcp
bun packages/mcp/src/cli.ts serve --mock   # self-seeded in-memory bucket, no relays
```

`--mock` (hidden) creates an in-process MockPool, an admin, a bucket, pairs the device and seeds two entries, so the server is usable without any network.
