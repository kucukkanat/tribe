# Tribe

Tribe is an encrypted, shared memory for a team and its coding agents. People add short **facts** and longer **pages** in a static web app; agents read and write the same memory through an MCP server (`bunx tribe-mcp`). Everything is end-to-end encrypted and stored on public Nostr relays. There is no Tribe backend.

## Architecture

All crypto, sync, roster and search logic lives in `@tribe/core` (`packages/core`) and is shared by the web app (`apps/web`, Preact + Vite, hash routing, deployable to any static host) and the MCP server (`packages/mcp`). Each bucket has a random `bucketId` and a sequence of symmetric **epoch keys**. Content is encrypted with NIP-44 v2 under the current epoch key and published under throwaway signing keys, with relay-facing tags blinded by HMAC so a relay that doesn't know the bucket id can't link events to it. Epoch keys reach members and their agent devices as NIP-59 gift wraps. The local client decrypts into a cache and runs keyword search there (MiniSearch). See [SPEC.md](SPEC.md) for exact formats.

Event kinds:

- `30450` **roster**: addressable, signed by an admin. Encrypted member list, roles, invites, relays and removal history.
- `4450` **entry version**: one version of a fact or page. Wraps an inner event (kind `4453`, never published in plain) signed by the author's identity or agent device key.
- `4451` **join request**: joiner → admin, NIP-44 to the admin, proves possession of the invite token.
- `30451` **device list**: addressable, signed by a member. That member's paired browsers and agents.
- `4452` **snapshot**: optional compacted set of current heads.
- `1059` **gift wrap**: NIP-59 wrap carrying a `KeyGrant` (rumor kind `4459`) with epoch keys for one recipient.

## Security model

What Tribe protects:

- Relays and anyone else without a bucket key see only ciphertext: no titles, bodies, tags, member names or bucket names.
- Each entry version is signed by its author (or their paired agent), so members can tell who wrote what.
- Removing a member or revoking a device rotates to a new epoch key that they don't receive.
- In the browser, your identity key can be wrapped with a passkey (WebAuthn PRF). The wrap is bound to your public key, and an unlock is only accepted if the decrypted key matches it.
- The web app ships a strict Content Security Policy (no inline or third-party scripts, no remote images, connections only to `wss:` relays), and rendered Markdown is sanitized with DOMPurify.

Honest limits:

- **Revocation only affects the future.** A removed member keeps whatever they already synced and the old epoch keys. Nothing is re-encrypted.
- **Relays see metadata.** They see event timing, sizes and kinds, the blinded bucket tag, the public keys that join requests and gift wraps are addressed to, and the IP addresses of connecting clients. Anyone who knows a `bucketId` can find that bucket's ciphertext.
- **Availability depends on public relays.** They can drop events, rate-limit you or go offline. Use at least 3 relays. In our real-relay tests, `relay.damus.io` banned bursts and didn't return gift wraps, so new buckets default to `nos.lol`, `relay.primal.net`, `nostr.mom` and `relay.snort.social`.
- **Browser storage belongs to the origin.** GitHub Pages *project* sites (`<user>.github.io/<repo>`) share one origin with every other project of that user, and any of those pages can read Tribe's IndexedDB, including an identity key stored without a passkey. For production, deploy on a dedicated origin: a custom domain, or a user/org site (`<user>.github.io` itself). Passkeys are registered to the exact hostname.
- An agent's key is stored on the agent's machine. Anyone with access to that machine can read the bucket until you revoke the device.
- Members can see each other's public keys and names, and admins can see all members' devices.

## Quick start

1. **Try the demo.** Open the app with `?demo=1` (or click "Try the demo"). It runs on in-memory relays with a seeded team bucket. Nothing is published.
2. **Create a bucket.** Set up your identity (protect it with a passkey if your browser supports PRF, and back up your `nsec`), then go to *New bucket*, choose a name and keep 3 or more relays.
3. **Invite teammates.** *Members → Invite* creates a single-use link and a QR code. The link carries a secret token in the URL fragment, which is never sent to a server, and the app removes it from the address bar as soon as the link is opened. The teammate opens it, sets up an identity and joins. An admin confirms pending requests in *Members*.
4. **Pair an agent.** In *Devices & agents*:
   1. On the agent's machine, run `bunx tribe-mcp init --label <name>`. It prints an npub.
   2. Paste the npub into the app and click *Pair agent*.
   3. Connect your agent with the connection string the app shows, which looks like `tribe://<bucketId>?admin=<pk>&relays=...`. For Claude Code:
      ```sh
      claude mcp add tribe -- bunx tribe-mcp serve --connect "tribe://<bucketId>?admin=<pk>&relays=wss%3A%2F%2Fnos.lol,..."
      ```
      For other clients, add this to the MCP config:
      ```json
      {"mcpServers":{"tribe":{"command":"bunx","args":["tribe-mcp","serve","--connect","<connection string>"]}}}
      ```

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun test                    # core unit tests (packages/core)
bun run typecheck           # tsc -b across the workspace
cd apps/web && bun run dev  # web app at http://localhost:5173 (CSP disabled in dev only)
cd apps/web && bun run build && bun run preview   # production build with CSP, at :4173
bun run e2e:real            # end-to-end against real public relays (needs network)
```

## Deploy to GitHub Pages

`.github/workflows/pages.yml` builds `apps/web` and publishes `apps/web/dist` on every push to `main`/`master`. Enable it under **Settings → Pages → Source: GitHub Actions**. The build uses relative asset paths (`base: "./"`), so it works on both a project path and a custom domain.

For anything beyond evaluation, give Tribe its own origin. Add a custom domain under **Settings → Pages** (a `CNAME` file is not needed with Actions deploys), or host it from a `<user>.github.io` / `<org>.github.io` repository. See the shared-origin note above.
