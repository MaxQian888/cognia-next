# Cognia public status service

Measures the official hosted relay (`signaling.cognia.cn`) and publishes it at
`https://status.cognia.cn/status/`. Decision record: ADR-0211. Plan and
deviations: `docs/plans/2026-10-02-signaling-public-status-implementation.md`.

| Package   | What                                                                                     | Commands                                        |
| --------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `worker/` | Cloudflare Worker `cognia-status`: D1 history, ingestion, incidents, mail, admin, assets | `pnpm test`, `pnpm typecheck`, `pnpm build`     |
| `probe/`  | External Node probe + read-only mirror (non-Cloudflare host)                             | `pnpm test`, `pnpm test:live`, `pnpm build`     |
| `admin/`  | Operator CLI `cognia-status-admin` (Access-authenticated)                                | `pnpm test`, `pnpm build`, `node dist/… --help` |

Each package is standalone (own `package.json` and lockfile); run
`pnpm install` inside it. All three bundle the shared contract from
`lib/status/` by relative path.

## What is measured

Every minute the Cron observer (`cf-cron`) runs, through the relay's public
route: `signalingHttp` (health body), `signalingAuth` (two synthetic peers
authenticate into a fresh room and exchange a signal) and `relayData`
(explicit data lane both ways). Every five minutes it repeats the protocol
checks with the exact `web`, `ios` and `android` Origins. Those runs are header
simulation, not device evidence. Until an external probe is enrolled the page
says "single observer".

## First deployment

Requires Workers Paid (D1 query budget, Cron CPU, Email Sending).

```bash
cd services/status-server/worker
pnpm install
# 1. D1 (already created for production: see wrangler.toml database_id)
pnpm run migrate                         # additive migrations, BEFORE the code
# 2. Secrets (values never committed; generate 32 random bytes each)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
wrangler secret put SUBSCRIBER_HMAC_KEYS   # {"h1":"<base64url>"}
wrangler secret put SUBSCRIBER_ENC_KEYS    # {"e1":"<base64url>"}
wrangler secret put IP_BUCKET_SECRET
wrangler secret put PROBE_SECRETS          # {} until an external probe is enrolled
wrangler secret put OPERATOR_ALERT_WEBHOOK # optional, fixed operator destination
# 3. Assets: from the repo root, after `pnpm build`
node scripts/build/build-status-site.mjs
# 4. Deploy (records the build SHA reported by /api/status/v1/healthz)
pnpm run deploy -- --var BUILD_SHA:$(git rev-parse HEAD)
```

CI does the same through `.github/workflows/deploy.yml`, target `status-worker`.

Smoke after deploy:

```bash
curl -s https://status.cognia.cn/api/status/v1/healthz
curl -s "https://status.cognia.cn/api/status/v1/snapshot?range=24h" | head -c 400
wrangler tail cognia-status            # cron_probe.*, cron.step_failed, ingest.*
```

## Activation order (plan §12)

1. Live page only: `FEATURE_INCIDENT_AUTOMATION=off`, `FEATURE_EMAIL=off`.
   Observer alerts still fire.
2. After a rehearsal of outage/unknown/recovery on staging, set
   `FEATURE_INCIDENT_AUTOMATION=on` in `wrangler.toml` and redeploy.
3. Mail (done 2026-10-02): `wrangler email sending enable status.cognia.cn`
   onboarded the **subdomain** (Cloudflare created its bounce MX, SPF, DKIM
   and `_dmarc` records under `status.cognia.cn`; the `cognia.cn` apex has no
   mail records and stays untouched). `[[send_email]] name = "EMAIL"`,
   `MAIL_FROM = "noreply@status.cognia.cn"` and `FEATURE_EMAIL=on` are in
   the production config. Confirm and unsubscribe with an operator-controlled
   mailbox after any sender change.

## Isolation from other services

The status Worker shares only the Cloudflare account with the relay, share
and update services: its own Worker, its own D1, no Durable Object, KV, R2 or
service bindings, `global_fetch_strictly_public`.

- Probes reach the relay only through its public route, each in a fresh
  synthetic room (no real user's room, peers or state is reachable). Each
  protocol run does cost the relay one short-lived Durable Object.
- Only `STATUS_ENV=production` may probe `signaling.cognia.cn`
  (`probeTargetAllowed` in `worker/src/probe/cron-probe.ts`); staging and
  development deployments probe nothing there. Staging's `SIGNALING_URL`
  names the staging relay.
- Page views invoke the Worker for the HTML, `/sw.js`, redirects and the API
  only (`run_worker_first` in `wrangler.toml`). Hashed files come straight
  from the asset layer with headers from the generated `_headers`, so a
  visitor surge does not consume the account's shared Worker requests.

## Operator access (Cloudflare Access)

Create an Access application for `status.cognia.cn/api/status/v1/admin/*` and
put its values in `[vars]`: `ACCESS_TEAM_DOMAIN`
(`https://<team>.cloudflareaccess.com`), `ACCESS_AUD`, and `ADMIN_EMAILS`.
While any of them is empty, every admin request answers 503. The Worker
validates the JWT itself (issuer, audience, signature, expiry, allowlist), so
a missing edge rule never opens the API.

```bash
cloudflared access login https://status.cognia.cn
node services/status-server/admin/dist/cognia-status-admin.mjs incident list
```

Every write prints a preview and asks before sending. Updates need
`--revision`, and a 409 prints the current revision.

## Enrolling the external probe

See `probe/deploy/README.md`. In short:

1. Generate a key secret.
2. Add it to `PROBE_SECRETS` under a new key ID.
3. Run `probe enroll` (with `--profile native:60:60 --profile web:-:300 …`).
4. Start the systemd unit or container.
5. Once its minutes arrive, run `probe set-reference <id> --effective-at <future minute>`.

Earlier history keeps its old reference.

## Rollback

- **A feature misbehaves:** switch `FEATURE_EMAIL` / `FEATURE_INCIDENT_AUTOMATION` off first. Observation and public reads continue.
- **Code:** `wrangler rollback` restores the Worker and its assets together. Migrations are additive and stay. Never restore the preview page as a fallback.
- **A probe breaks:** `probe disable <id>`. Its history stays, and coverage shows the gap.
- **Signaling is unaffected** by anything in this service.

## Budgets

- **D1 per Cron minute:** about 50–70 statements, enforced below 150 by `worker/src/budget.test.ts`.
- **D1 writes:** about 15k rows written per day.
- **Snapshot:** at most 256 KiB per range, cached at the edge for 30 s.
- **Retention:**

  | Data                                   | Kept     |
  | -------------------------------------- | -------- |
  | Raw runs                               | 14 days  |
  | Minute slots                           | 90 days  |
  | Hourly rollups                         | 8 days   |
  | Daily rollups                          | 400 days |
  | Admin audit                            | 180 days |
  | Delivery metadata                      | 30 days  |
  | Pending subscriptions                  | 24 h     |
  | Unsubscribed addresses (purged within) | 30 days  |
