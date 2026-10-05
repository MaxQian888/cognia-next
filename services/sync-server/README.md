# Sync Worker — account sync's device registry and enrollment

The server half of account sync phase 2 (ADR-0215, protocol
[`account-sync-protocol.mdx`](../../docs/content/docs/en/data/account-sync-protocol.mdx) §2–5):
a Cloudflare Worker with one SQLite Durable Object (`SyncSpace`) per account
space. It stores the signed device registry, the current epoch's sealed keys
and enrollment requests. It never sees a key or a device name in the clear,
and syncs no data yet (phase 3).

| Environment | Host                     | Accepts tokens from (`iss`)             | Web origins                                       |
| ----------- | ------------------------ | --------------------------------------- | ------------------------------------------------- |
| production  | `sync.cognia.cn`         | `https://id.cognia.cn/api/auth`         | `https://app.cognia.cn`                           |
| staging     | `sync-staging.cognia.cn` | `https://id-staging.cognia.cn/api/auth` | `https://app-staging.cognia.cn`, `localhost:3000` |
| dev         | `localhost:8788`         | `http://localhost:8787/api/auth`        | `http://localhost:3000`                           |

## What it does, and what it refuses

**Who is calling.**

- Every route but `GET /v1/health` needs the identity Worker's access token: this environment's `iss`, `aud` `https://sync.cognia.cn`, `typ` `at+jwt`, ES256, a first-party client (`cognia-app`, `cognia-web`) and a `usr_` subject.
- The JWKS comes through the `IDENTITY` service binding, cached 10 minutes and refetched on an unknown `kid` (at most once a minute).
- The space is `spaceId = SHA-256(label(space) ‖ iss ‖ sub)`, so staging, production and a self-hosted issuer never share one.
- Routes that act as a device also need `Cognia-Device-Proof`, a signature by that device's registry key over the method, path, body hash and time (±120 s). Every answer carries `Cognia-Server-Time`.
- A revoked device is refused (`403 device_revoked`) before anything is read. It can still read the signed registry, where it finds its own revocation.

**What it enforces.** These are the rules the clients also check, from `packages/sync-protocol` (linked, not copied):

- `validateAppend` on every entry; a stale entry answers `409 head_moved`.
- A complete envelope set on every new epoch: the active devices plus recovery, each sealed to the registry's key. An approval adds exactly the new device's envelope.
- The recovery add arrives in one batch with the new device's rotation.
- The approval is commit-then-reveal:
  - The new device's nonce must match its commitment.
  - Only the device that posted the approver nonce may append the `add-device`.
  - The appended device and `transcriptHash` must match the request.
- At most 3 waiting devices and 10 requests an hour per space. Requests expire after 15 minutes; finished ones are deleted an hour later (Durable Object alarm).

**Routes** (`/v1/`): `health`, `space`, `space/genesis`, `registry` (GET `?after=`, POST), `envelopes/self`, `envelopes/recovery`, `enroll/requests` (POST, GET), `enroll/requests/:id` (GET, DELETE) and its `nonce`, `reveal`, `deny`. `src/routes.ts` is the list; anything else is a 404 before authentication.

**Account deletion.** `SyncAdmin` (a named entrypoint, never routed over HTTP) has `purgeSpace(userId)`. The identity Worker calls it through its `SYNC_ADMIN` binding when an account's cooling-off ends, and it deletes the whole space.

## Develop

```bash
cd services/sync-server
pnpm install
pnpm dev          # http://localhost:8788; reads the dev identity Worker's JWKS at localhost:8787
pnpm test         # vitest in workerd: flows, refusals, alarms, purge, frozen protocol vectors
pnpm typecheck
pnpm build        # dry-run bundle into dist/
```

The app points at a sync host through `NEXT_PUBLIC_COGNIA_SYNC_URL`.

## Provision and deploy

There are no secrets to set. The identity Worker of the same environment must already exist (`IDENTITY` binding).

1. Deploy through `deploy.yml` (target `sync-worker`, or `workers`/`all`). The job tests the Worker, then deploys. To do it by hand:
   ```bash
   pnpm deploy:staging      # or: pnpm deploy
   ```
2. Then deploy the identity Worker, whose `SYNC_ADMIN` binding needs this Worker to exist. `deploy.yml` orders the two jobs this way.
3. The custom domains `sync.cognia.cn` and `sync-staging.cognia.cn` are declared in `wrangler.toml` and created on deploy.

**Smoke test:**

```bash
curl https://sync-staging.cognia.cn/v1/health      # {"ok":true,"protocolVersion":1}
curl -i https://sync-staging.cognia.cn/v1/space    # 401 unauthorized
```

## Operate

- **Migrations.** The Durable Object's SQLite schema is created with `IF NOT EXISTS` on first use. The class migration tag `sync-space-v1` in `wrangler.toml` stays forever.
- **Rollback.** `wrangler rollback [--env staging]`. The schema only ever gains tables or columns.
- **Misconfiguration.** A bad `ISSUER`, `SYNC_AUDIENCE` or `WEB_ORIGINS` makes every request answer `503 server_misconfigured`, with the reason in the log.
- Incidents: [`docs/runbooks/sync-worker.md`](../../docs/runbooks/sync-worker.md).
