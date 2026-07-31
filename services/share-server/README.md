# cognia-share-server

Self-hosted public **share-link** service for cognia. Implements the same HTTP
contract as the Cloudflare Worker in [`worker/`](worker/), so the desktop/mobile
app can target it by setting `AppSettings.shareUrl` — no app changes required.
Implements ADR-0037.

It is the share-service counterpart to [`signaling-server/`](../signaling-server/):
a single static Rust binary (axum), the same security/observability posture, the
same `docker` / `fly` deployment story. The one structural difference is that
shares are **persistent**, so this server keeps a single-file SQLite database
instead of being stateless.

## What it does

A **blind store** for zero-knowledge artifacts. The browser encrypts a payload
client-side (AES-GCM); the decryption key rides only in the URL `#fragment` and
never reaches the server. This service stores the opaque envelope behind a short
unguessable code and enforces the lifecycle (TTL, max-views, burn-after-read,
revoke). It never sees the key or the plaintext.

API surface (all under `/v1`):

| Method    | Path                    | Auth   | Success                                           | Notes                                               |
| --------- | ----------------------- | ------ | ------------------------------------------------- | --------------------------------------------------- |
| `POST`    | `/v1/share`             | Bearer | `201 {code, ownerToken, expiresAt}`               | `413` over body cap, `400` bad json/envelope, `401` |
| `GET`     | `/v1/share/:code`       | public | `200 {envelope}`                                  | `404` if missing/expired/burned/revoked             |
| `GET`     | `/v1/share/:code/stats` | Owner  | `200 {viewCount, expiresAt?, revoked, maxViews?}` | `X-Owner-Token`; legacy rows fall back to Bearer    |
| `DELETE`  | `/v1/share/:code`       | Owner  | `204`                                             | hard delete; unknown codes return `204`             |
| `OPTIONS` | any                     | —      | `204` + CORS                                      | preflight                                           |
| `GET`     | `/healthz`              | —      | `200` JSON                                        | liveness probe                                      |
| `GET`     | `/metrics`              | —      | `200` Prometheus text                             | scrape endpoint                                     |

The viewer (`/share/view?c=…#k=…`) is the app's own route — this server is a
pure JSON API scoped to `/v1/*`, exactly like the Worker.

It does **not** do:

- **Decryption.** Envelopes are stored and served as opaque JSON text.
- **TLS termination.** Deploy behind a platform that handles TLS (Fly.io,
  Railway, an nginx front).

## Run locally

```bash
cd share-server
SHARE_UPLOAD_SECRET=$(openssl rand -hex 32) cargo run -- --bind 127.0.0.1:8787
# or:
SHARE_UPLOAD_SECRET=devsecret PORT=8787 cargo run
```

Then point the app at it: **Settings → Share** → set the server URL to
`http://localhost:8787` and paste the same upload secret (stored in the OS
keyring, never in IndexedDB).

## Run tests

```bash
cd share-server
cargo test --workspace          # unit + integration
cargo clippy --workspace --all-targets -- -D warnings
```

Integration tests boot a real server on an ephemeral port against a throwaway
SQLite file and drive it over HTTP with `reqwest`.

## Configuration

All via environment variables (mirrors the `SIGNALING_*` convention):

| Var                          | Default               | Purpose                                                           |
| ---------------------------- | --------------------- | ----------------------------------------------------------------- |
| `PORT` / `BIND_ADDR`         | `0.0.0.0:8787`        | Listen address (`BIND_ADDR` wins; PaaS injects `PORT`)            |
| `SHARE_DB_PATH`              | `./shares.sqlite`     | SQLite database file                                              |
| `SHARE_UPLOAD_SECRET`        | _(unset)_             | Bearer secret for create/delete/stats. **Unset ⇒ all writes 401** |
| `SHARE_MAX_BODY_BYTES`       | `10485760` (10 MiB)   | Max request body                                                  |
| `SHARE_MAX_TTL_SECONDS`      | `2592000` (30 days)   | Hard lifetime ceiling; every share expires at or before this      |
| `SHARE_ALLOWED_ORIGINS`      | _(unset = allow all)_ | Comma-separated `Origin` allowlist                                |
| `SHARE_TRUST_PROXY_HEADERS`  | `false`               | Trust `Fly-Client-IP` / first `X-Forwarded-For` for rate limits   |
| `SHARE_RATE_PER_SEC`         | `20`                  | Per-IP sustained request rate                                     |
| `SHARE_RATE_BURST`           | `40`                  | Per-IP burst bucket size                                          |
| `SHARE_REAPER_INTERVAL_SECS` | `60`                  | TTL sweep interval                                                |
| `RUST_LOG`                   | `info,share=info`     | Log filter                                                        |

## Deploy to Fly.io

```bash
cd share-server
flyctl volumes create share_data --size 1 --region iad
flyctl secrets set SHARE_UPLOAD_SECRET=$(openssl rand -hex 32)
flyctl launch --no-deploy --copy-config
flyctl deploy
```

The container listens on `$PORT` (default 8787); Fly's edge serves TLS, so
clients reach `https://<app>.fly.dev/v1/share`. The share database lives on the
`share_data` volume mounted at `/data` and survives restarts.

## Deploy from CI

`.github/workflows/deploy.yml` deploys both the Worker (`worker/`, via
`wrangler deploy`; staging = `--env staging` → `cognia-share-staging` on
`*.workers.dev` with its own `cognia-shares-staging` R2 bucket + KV namespace)
and the Fly app — manual dispatch only, gated by the `DEPLOY_ENABLED` repo
variable plus environment-scoped `CLOUDFLARE_API_TOKEN` / `FLY_API_TOKEN`
secrets. The KV namespace id is injected at deploy time from the
environment-scoped `CF_SHARE_KV_NAMESPACE_ID` variable (the tracked
`wrangler.toml` keeps the `REPLACE_WITH_KV_NAMESPACE_ID` placeholder). Fly
staging needs its own app + `share_data` volume (`FLY_SHARE_APP` variable).
See `CI_CD.md` → "Deploy (services)".

## Security

- **Bearer auth** with a length-independent constant-time comparison gates
  create; an unset secret rejects every create.
- **Per-share owner tokens** are minted on create and required via
  `X-Owner-Token` for stats/delete. Legacy rows without a token remain
  manageable with the global bearer secret, but tokenized rows do not accept
  the global secret for owner actions.
- **Hard TTL ceiling** applies to every share, even if the creator omits
  `ttlSeconds`, so a shared deployment cannot accumulate never-expiring rows.
- **Per-IP rate limiting** (token bucket) blunts share-code enumeration — the
  abuse control the Worker delegates to Cloudflare. By default, the limiter uses
  the TCP peer address; enable `SHARE_TRUST_PROXY_HEADERS` only behind a trusted
  proxy to honor `Fly-Client-IP` / the first `X-Forwarded-For` hop.
- **Body size cap** (`413`) and an optional **origin allowlist** (`403`).
- **No existence leak**: every gated read returns `404`, never distinguishing
  "expired" from "never existed".
- The store only ever holds client-encrypted, zero-knowledge envelopes.

## Architecture

```
src/main.rs       CLI + bootstrap (port/bind resolution, tracing)
src/server.rs     Config, AppState, router, graceful shutdown, /healthz, /metrics
src/handlers.rs   create / read / stats / delete (the HTTP analog of the Worker)
src/store.rs      single-file SQLite (r2d2 pool, atomic read-and-advance tx, reaper)
src/ip_limits.rs  per-IP token-bucket rate limiter + client-IP extraction
src/metrics.rs    atomic counters + hand-rolled Prometheus exposition
src/reaper.rs     periodic TTL sweep + idle-bucket pruning
core/             pure, side-effect-free logic (envelope validation, lifecycle
                  decision, code generation, timing-safe compare, token bucket)
```

A read runs inside one `BEGIN IMMEDIATE` transaction that both increments the
view counter and (when exhausted/expired) deletes the row — so a max-views share
can never be over-served under concurrency, which the Worker's split R2+KV store
could not guarantee.

## Metrics

`GET /metrics` exposes Prometheus counters: `share_created_total`,
`share_read_total`, `share_deleted_total`,
`share_rejected_total{reason="unauthorized|too_large|invalid|not_found|rate"}`,
the `share_active` gauge, and `share_uptime_seconds`.
