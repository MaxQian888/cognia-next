# cognia-share-worker

Cloudflare Worker for cognia's zero-knowledge public share links. Stores opaque
AES-GCM envelopes in **R2** and serializes per-share lifecycle changes in
**SQLite-backed Durable Objects**. **KV** retains legacy metadata for lazy migration
and the eventually consistent org discovery index. It never
sees the decryption key (that rides in the URL `#fragment`) and the payload's
`kind`/`mime` live inside the ciphertext, so the server is blind to content.

This is a standalone Node project (own `package.json` + lockfile), **not** part
of the app's pnpm workspace — install with `pnpm install --ignore-workspace`.

## API

| Method   | Path                    | Auth   | Purpose                                                                       |
| -------- | ----------------------- | ------ | ----------------------------------------------------------------------------- |
| `POST`   | `/v1/share`             | Bearer | Store an envelope, return `{ code, ownerToken, expiresAt }`                   |
| `GET`    | `/v1/share/:code`       | public | Return `{ envelope }`; enforces TTL / max-views / burn                        |
| `GET`    | `/v1/share/:code/stats` | Owner  | Owner view counts via `X-Owner-Token`; legacy rows fall back to Bearer        |
| `PATCH`  | `/v1/share/:code`       | Owner  | Renew with `{ ttlSeconds }`, return `{ expiresAt }`; capped by configured TTL |
| `DELETE` | `/v1/share/:code`       | Owner  | Revoke via `X-Owner-Token`; unknown codes return `204`                        |
| `*`      | (anything else)         | public | `404` — the viewer is the app's own `/share/view` route on Cloudflare Pages   |

Creates accept `Authorization: Bearer <SHARE_UPLOAD_SECRET>` or a verified
collaboration-plane grant. New shares return a per-share `ownerToken`;
stats/renew/delete accept that token in `X-Owner-Token`, or a grant for the share's
own org. Legacy rows created before owner tokens fall back to the global bearer
secret. Org listing/deletion require a matching org grant.
Reads are public but lifecycle-gated. Body cap: `MAX_BODY_BYTES` (default
10 MiB). Share lifetime is capped by `MAX_TTL_SECONDS` (default 30 days), even
when the creator omits `ttlSeconds`.

## Develop & test

```bash
pnpm install --ignore-workspace
pnpm test          # vitest + miniflare (R2/KV/Durable Objects local; no account needed)
pnpm typecheck
pnpm dev           # wrangler dev (local)
```

## Deploy (operator, once)

```bash
wrangler r2 bucket create cognia-shares
wrangler kv namespace create SHARE_KV        # paste the id into wrangler.toml
wrangler secret put SHARE_UPLOAD_SECRET      # the bearer the app stores in its keyring
wrangler deploy
```

The Worker is a pure JSON API scoped to `share.cognia.cn/v1/*`. The **viewer**
is the app's own `/share/view` route, deployed as a Cloudflare Pages static
export on the same host (`pages/README.md`) — Pages serves everything except
`/v1/*`, which this Worker route intercepts.

Set the app's `NEXT_PUBLIC_SHARE_URL` (or Settings → share URL) and the same
upload secret (Settings → share upload secret) to point at the deployed host
(`routes` in `wrangler.toml`, default `share.cognia.cn`).

The mandatory `SHARE_LIFECYCLE` binding and SQLite migration are configured for
both production and staging in `wrangler.toml`. Follow the
[shared lifecycle rollout notes](../README.md#worker-lifecycle-authority-migration)
when upgrading an existing deployment, including the restriction against mixed
traffic or rollback to an older KV-writing version. Existing R2 bytes and link
codes remain unchanged; lifecycle operations commit through one durable authority.
Creation persists cleanup intent before R2/index writes, so interrupted uploads
are reclaimed by the same retry alarm used for deletion.
