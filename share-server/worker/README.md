# cognia-share-worker

Cloudflare Worker for cognia's zero-knowledge public share links. Stores opaque
AES-GCM envelopes in **R2** and per-share lifecycle counters in **KV**. It never
sees the decryption key (that rides in the URL `#fragment`) and the payload's
`kind`/`mime` live inside the ciphertext, so the server is blind to content.

This is a standalone Node project (own `package.json` + lockfile), **not** part
of the app's pnpm workspace — install with `pnpm install --ignore-workspace`.

## API

| Method   | Path                    | Auth   | Purpose                                                                     |
| -------- | ----------------------- | ------ | --------------------------------------------------------------------------- |
| `POST`   | `/v1/share`             | Bearer | Store an envelope, return `{ code, expiresAt }`                             |
| `GET`    | `/v1/share/:code`       | public | Return `{ envelope }`; enforces TTL / max-views / burn                      |
| `GET`    | `/v1/share/:code/stats` | Bearer | Owner view counts                                                           |
| `DELETE` | `/v1/share/:code`       | Bearer | Revoke                                                                      |
| `*`      | (anything else)         | public | `404` — the viewer is the app's own `/share/view` route on Cloudflare Pages |

Writes/deletes require `Authorization: Bearer <SHARE_UPLOAD_SECRET>`. Reads are
public but lifecycle-gated. Body cap: `MAX_BODY_BYTES` (default 10 MiB).

## Develop & test

```bash
pnpm install --ignore-workspace
pnpm test          # vitest + miniflare (R2/KV simulated; no account needed)
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
