# Identity Worker — the official Cognia account

The OIDC issuer behind the optional official Cognia account (ADR-0215 §2):
Better Auth 1.7 with its OAuth 2.1 provider and JWT plugins on Cloudflare
Workers + D1.

| Environment | Issuer (`iss`)                          | D1                        | Web origins                                       |
| ----------- | --------------------------------------- | ------------------------- | ------------------------------------------------- |
| production  | `https://id.cognia.cn/api/auth`         | `cognia-identity`         | `https://app.cognia.cn`                           |
| staging     | `https://id-staging.cognia.cn/api/auth` | `cognia-identity-staging` | `https://app-staging.cognia.cn`, `localhost:3000` |
| dev         | `http://localhost:8787/api/auth`        | local                     | `http://localhost:3000`                           |

Access tokens for the sync API (`resource=https://sync.cognia.cn`) are ES256
`at+jwt` with a `kid`. Their `sub` is the person's `usr_` id, and
`cognia-tenant-auth::oidc` verifies them. ID tokens and UserInfo carry
`cognia_identities`, the person's linked sign-ins (Feishu as
`{provider:"lark", tenant, subject: union_id}`).

## What it does, and what it refuses

**Clients.**

- There are exactly two, both seeded by `migrations/0002_first_party_clients.sql`.
- `cognia-app` (desktop, phone, CLI) redirects to `cn.cognia.app:/auth/callback`, or to loopback `http://127.0.0.1/callback` on any port.
- `cognia-web` uses the official web app's `/logto/callback`. Its URIs are reconciled from `WEB_ORIGINS` at runtime.
- Both are public PKCE clients and skip the consent screen.
- Client and resource management is closed: privileges deny everything, and dynamic registration is off.

**Routes.**

- Only the routes in `src/route-allowlist.ts` reach Better Auth: discovery, JWKS, the authorization-code flow, consent, logout, social sign-in and its callbacks.
- Everything else under `/api/auth` returns 404. That covers password sign-up, client CRUD, account linking and the jwt plugin's `/token`.

**Sign-in.**

- Social only: Feishu (self-built app, keyed `<tenant_key>:<union_id>`), GitHub, Google and Apple. Each is offered only when all of its secrets are set.
- Provider tokens are discarded before they are written. The issuer keeps who the person is, never access to their provider account.
- Two sign-ins merge into one person only when both providers verified the same email. Feishu never vouches for an email; its accounts carry a `.invalid` placeholder.

**Pages.**

- `/sign-in`, `/consent`, `/error` and `/signed-out`, served in English or Chinese with a per-request CSP nonce.
- The apps pass `provider=<id>` on the authorize request, so the sign-in page goes straight to that provider.

**CORS.** Only for `WEB_ORIGINS`, on token, revoke, userinfo, JWKS, discovery and `/api/account/deletion`. Never with credentials.

**Account deletion.**

- `GET`/`POST`/`DELETE /api/account/deletion` with a bearer access token.
- Requesting a deletion also needs an ID token from a sign-in at most 10 minutes old.
- After a 7-day cooling-off period the hourly cron purges the person: tokens, consents, sessions, linked accounts and the user. The `account_deletion` row stays as the record.
- First the person's sync space is deleted through the `SYNC_ADMIN` service binding (the sync Worker's `SyncAdmin` entrypoint, `services/sync-server`). Staging binds it; production binds it once `cognia-sync` is deployed. Without the binding no hook runs.

**Rate limits.** Better Auth's limiter, counted in D1, per `cf-connecting-ip`.

## Develop

```bash
cd services/identity-server
pnpm install
cp .dev.vars.example .dev.vars        # set BETTER_AUTH_SECRETS (+ any provider)
pnpm migrate:local                    # local D1
pnpm dev                              # http://localhost:8787 (wrangler --env dev)
pnpm test                             # vitest in workerd + D1, providers stubbed
pnpm typecheck
```

For a provider to work locally, register
`http://localhost:8787/api/auth/callback/<feishu|github|google|apple>` with it.
The app reaches the dev issuer through `NEXT_PUBLIC_COGNIA_ID_ISSUER` (and, for
the desktop host, `COGNIA_OFFICIAL_ISSUER`).

### Schema changes

D1 is reachable only from a Worker, so Better Auth's CLI cannot migrate it.
After changing anything in `src/auth.ts` that affects the schema (a plugin, an
option that adds a table or column):

```bash
pnpm schema:generate <snake_case_name>   # writes migrations/NNNN_<name>.sql
```

The script replays the checked-in migrations into `node:sqlite` and writes only
what is missing. `src/auth.test.ts` ("schema") fails while a migration is
missing, and CI also re-runs the generator.

## Provision an environment

Run once per environment. Use `--env staging` and the `-staging` names for staging.

```bash
wrangler d1 create cognia-identity --location apac
#   → set the GitHub environment variable CF_IDENTITY_D1_DATABASE_ID to its id
#     (deploy.yml injects it into wrangler.toml)
wrangler secret put BETTER_AUTH_SECRETS        # "1:$(openssl rand -base64 36)"
wrangler secret put FEISHU_APP_ID              # and FEISHU_APP_SECRET
wrangler secret put GITHUB_CLIENT_ID           # and GITHUB_CLIENT_SECRET
wrangler secret put GOOGLE_CLIENT_ID           # and GOOGLE_CLIENT_SECRET
wrangler secret put APPLE_SERVICE_ID           # APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (p8)
```

**Redirect URIs to register with each provider:**

| Provider | Redirect URI                                    | Notes                                                           |
| -------- | ----------------------------------------------- | --------------------------------------------------------------- |
| Feishu   | `https://id.cognia.cn/api/auth/callback/feishu` | Developer console → Security → Redirect URLs. No scopes needed. |
| GitHub   | `https://id.cognia.cn/api/auth/callback/github` | OAuth App.                                                      |
| Google   | `https://id.cognia.cn/api/auth/callback/google` | Web client; scopes `openid email profile`.                      |
| Apple    | `https://id.cognia.cn/api/auth/callback/apple`  | Services ID with Sign in with Apple; domain `id.cognia.cn`.     |

**Custom domains** (`id.cognia.cn`, `id-staging.cognia.cn`) are declared in `wrangler.toml` and created on deploy.

**Deploy** through `deploy.yml` (target `identity-worker`). The workflow tests the Worker, injects the D1 id, applies migrations, and then deploys. To do it by hand:

```bash
pnpm migrate:staging && pnpm deploy:staging
```

**Smoke test:**

```bash
curl https://id-staging.cognia.cn/api/auth/.well-known/openid-configuration
curl https://id-staging.cognia.cn/api/auth/jwks        # ES256 keys with alg + kid
```

## Operate

- **Secret rotation.** Prepend a new version to `BETTER_AUTH_SECRETS` (`"2:<new>,1:<old>"`) and redeploy. New data uses version 2, and data under version 1 still decrypts. Drop the old version only after every session and encrypted JWKS key from it has expired.
- **Signing keys.** ES256 keys rotate lazily every 30 days. An old key stays in the JWKS for 7 more days, longer than any token it signed (15-minute access tokens, 10-hour ID tokens). Verifiers re-fetch on an unknown `kid`.
- **Deletion cron.** Runs hourly at minute 17. A failed purge stays `pending` and is retried on the next run; the Worker logs the failure.
- **Rollback.** `wrangler rollback [--env staging]`. Migrations are additive; never edit an applied one.
- **Misconfiguration.** An invalid variable or secret makes every request answer `503 server_misconfigured`, with the reason in the Worker log, instead of issuing tokens under a wrong issuer.

## Known limits

- Until Cognia has a Feishu marketplace (ISV) app, only the self-built login app's own tenant can sign in with Feishu.
- Mainland China reaches Cloudflare with higher latency. Login redirects are the most sensitive step.
