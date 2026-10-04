# Logto IdP — self-host + seed guide (ADR-0059 multi-user OIDC)

Logto is the OpenID Connect identity provider for the **cloud/headless multi-user**
deployment. It is **not** used by the offline desktop app, which keeps its local
account gate. Logto governs multi-tenant device registration: the browser uses
PKCE, presents the organization-bound OIDC access token only to
`POST /api/auth/device/register`, and then uses its registered P-256 key to mint
five-minute DPoP-bound Companion access tokens. OIDC or device bearer tokens are
not accepted as a steady-state Companion shortcut.

The browser registration flow is available only when `COGNIA_LOGTO_ISSUER`,
`COGNIA_LOGTO_AUDIENCE`, and `COGNIA_LOGTO_WEB_CLIENT_ID` are all set.

---

## 1. Start Logto

For an isolated, loopback-only development instance, use section 9. The base
profile alone publishes on all interfaces unless `COGNIA_BIND_ADDRESS` is set.

```bash
cd deploy/compose
cp .env.example .env         # if you haven't already
# set LOGTO_DB_PASSWORD (openssl rand -hex 24) in .env
docker compose --profile logto up -d --wait
```

- Core / OIDC issuer host → <http://localhost:3001>
- Admin Console → <http://localhost:3002>

Logto requires **PostgreSQL 14+** and **Redis**; both are on the `logto` profile
(`logto-postgres`, `logto-redis`) and start automatically.

## 2. One-time seed (Admin Console, <http://localhost:3002>)

1. Create the admin account (first-run wizard).
2. **API resources → Create**
   - **API identifier** = the gateway audience, e.g. `https://brain.example.com/api`.
     This exact string becomes `COGNIA_LOGTO_AUDIENCE` **and** each client's
     `resource`. With a valid resource, Logto issues a **JWT** access token whose
     `aud` is this indicator (verifiable via JWKS).
   - **Permissions** → add the scopes your routes require, e.g. `brain:rpc`,
     `brain:read`, `brain:admin`.
3. **Applications → Create**
   - **Native app** (desktop + CLI): note the **App ID** (→ client `clientId`).
     Add redirect URIs: the loopback callback `http://127.0.0.1:<port>/callback`
     (the CLI callback server, `cli/src/mcp/oauth-callback-server.ts`) and the
     deep-link `cognia://logto/callback`. Also add
     `cn.cognia.app:/auth/callback`, the RFC 8252 callback the apps send to a
     non-Logto issuer (ADR-0215 §2); Logto clients do not use it yet, but
     registering it now means a later switch needs no console change.
     `pnpm logto:seed` registers both.
   - **SPA app** (web console): add the web redirect URI, e.g.
     `https://console.example.com/logto/callback`.
   - **M2M apps** (optional): one per internal service (brain ↔ share ↔
     signaling). They use the `client_credentials` grant, not this flow.
4. **Organizations** (optional, for multi-tenant): enable the feature, create an
   organization per tenant, add members, and define organization roles
   (`owner` / `member` / `agent-operator`). The **organization id** maps to a
   cognia tenant. When a client passes `organization_id` together with the
   `resource`, the token's `aud` stays the resource indicator and Logto adds an
   `organization_id` claim — which `oidc_device_context` maps to `account_id`.
5. **Connectors → Social connectors** (unified sign-in, ADR-0149): add GitHub
   and Feishu (and any other provider you want on the sign-in screen), then
   enable each one under **Sign-in experience → Sign-up and sign-in**. The
   connector **target** (`github`, `feishu`) is what
   `COGNIA_LOGTO_SOCIAL_PROVIDERS` lists and what the client passes as
   `direct_sign_in`, so a provider missing here is simply absent from the
   sign-in screen.

## 3. ⚠️ Issuer-consistency footgun (read before step 4)

A token's `iss` claim is **`${LOGTO_ENDPOINT}/oidc`**. The gateway checks
`iss == COGNIA_LOGTO_ISSUER` and fetches JWKS from that same URL, so:

- `COGNIA_LOGTO_ISSUER` **must equal** `${LOGTO_ENDPOINT}/oidc`, character for
  character, **and** be resolvable **from inside the `cognia-server`
  container**.
- The default `LOGTO_ENDPOINT=http://localhost:3001` works for a browser on the
  host but **`localhost` inside the container is the container itself** — the
  gateway can't reach Logto there. For anything beyond a browser-only test:
  - **Recommended:** put Logto behind the `tls` front door with a real domain,
    set `LOGTO_ENDPOINT=https://auth.example.com`, and
    `COGNIA_LOGTO_ISSUER=https://auth.example.com/oidc`. One URL, reachable by
    the browser, the CLI, and the container.
  - **Quick single-host alternative:** give both the browser and the container a
    shared name — set `LOGTO_ENDPOINT=http://logto:3001`, add a hosts entry so
    the browser resolves `logto`, and let the container use the compose-network
    DNS name `logto`. Then `COGNIA_LOGTO_ISSUER=http://logto:3001/oidc`.

## 4. Wire the gateway (`cognia-server`)

In `.env`:

```dotenv
COGNIA_LOGTO_ISSUER=https://auth.example.com/oidc     # == ${LOGTO_ENDPOINT}/oidc
COGNIA_LOGTO_AUDIENCE=https://brain.example.com/api   # the API resource identifier
COGNIA_LOGTO_WEB_CLIENT_ID=<Logto SPA App ID>          # returned by /api/auth/config
COGNIA_LOGTO_REQUIRED_SCOPES=brain:rpc                # optional baseline scope
# COGNIA_LOGTO_JWKS_TTL_SECS=600                       # optional (default 600)
COGNIA_LOGTO_NATIVE_CLIENT_ID=<Logto native App ID>    # desktop + CLI PKCE
COGNIA_LOGTO_SOCIAL_PROVIDERS=github,feishu           # connector targets to offer
```

Then restart with both profiles:

```bash
docker compose --profile server --profile logto up -d --wait
```

The OIDC token authorizes registration only. Steady-state HTTP calls use a
five-minute DPoP-bound access token; `/ws/events` and the other public socket
routes redeem a single-use ticket. `/connectors/webhook/*` keeps each
platform's HMAC/signature, while `/internal/*` requires the loopback-minted
service principal.

## 5. Wire the client (`lib/logto`)

```ts
import { loginToLogto } from "@/lib/logto/client"

const config = {
  issuer: "https://auth.example.com/oidc", // == COGNIA_LOGTO_ISSUER
  clientId: "<native App ID>",
  redirectUri: "http://127.0.0.1:9321/callback", // or cognia://logto/callback
  resource: "https://brain.example.com/api", // == COGNIA_LOGTO_AUDIENCE
  scopes: ["brain:rpc"],
  organizationId: "<org id>", // optional (multi-tenant)
}
const session = await loginToLogto(config, { openUrl, waitForCode })
// session.accessToken is submitted only while registering the P-256 device.
```

## 6. Wire the collaboration server (`collab-server`, unified sign-in)

The account plane (ADR-0149) lets the first person claim an empty deployment,
lets everyone else join through an invitation, and mirrors organizations and
memberships into Logto so tokens carry the right `organization_id`.

1. **Applications → Create → Machine-to-machine**: name it `cognia-collab` and
   under **Permissions** grant it the **Logto Management API** resource with the
   `all` scope. Note the App ID and App Secret.
2. **Organization template → Roles**: make sure the roles named by
   `COLLAB_LOGTO_OWNER_ROLE` and `COLLAB_LOGTO_MEMBER_ROLE` exist (defaults
   `owner` and `member`). The server assigns them when it mirrors a membership.
3. Mint the one-time bootstrap credential and keep only its hash in `.env`:

   ```bash
   CRED=$(openssl rand -base64 32)
   printf %s "$CRED" | sha256sum   # COLLAB_ACCOUNT_BOOTSTRAP_CREDENTIAL_SHA256
   echo "$CRED"                     # hand this to the first owner, out of band
   ```

4. In `.env`:

   ```dotenv
   COLLAB_ACCOUNT_BOOTSTRAP_ENABLED=true
   COLLAB_ACCOUNT_BOOTSTRAP_CREDENTIAL_SHA256=<hex from above>
   COLLAB_LOGTO_ENDPOINT=https://auth.example.com   # == LOGTO_ENDPOINT, not /oidc
   COLLAB_LOGTO_M2M_CLIENT_ID=<M2M App ID>
   COLLAB_LOGTO_M2M_CLIENT_SECRET=<M2M App Secret>
   # collab-server verifies the same tokens the gateway does
   COLLAB_OIDC_ISSUER=${COGNIA_LOGTO_ISSUER}
   COLLAB_OIDC_AUDIENCE=${COGNIA_LOGTO_AUDIENCE}
   COLLAB_GRANT_KEY=<openssl rand -hex 32>
   # what the gateway announces to clients in /api/auth/config
   COGNIA_COLLAB_URL=http://collab-server:8080          # the brain's route
   COGNIA_PUBLIC_COLLAB_URL=https://cognia.example.com/collab   # a browser's route (Caddy)
   COGNIA_WEB_ORIGIN=https://cognia.example.com         # invitation links
   ```

   `COGNIA_COLLAB_URL` is what makes the sign-in screen able to join at all:
   without it `/api/auth/config` carries no `collaboration` block and every
   sign-in stops at "no collaboration service". The tls profile's Caddy proxies
   `/collab/*` to `collab-server`, which keeps the browser on one origin. A
   deployment that puts the collaboration server on another origin sets
   `COLLAB_ALLOWED_ORIGINS=https://cognia.example.com` on collab-server
   instead (exact origins, never a wildcard).

5. Restart with all three profiles:

   ```bash
   docker compose --profile server --profile logto --profile collab up -d --wait
   ```

**Callback modes.** The web app redirects to `<web origin>/logto/callback` (the
SPA app). The CLI listens on a loopback port. The desktop app and the phone
send the browser to the deep link `cognia://logto/callback`, which the OS
hands back to the running app (the desktop also accepts the pasted address
when the browser never comes back). All three URIs must be registered on the
matching Logto application or Logto refuses the authorization request.

**Issuer kind.** `/api/auth/config` announces `oidc.issuerKind` (config
version 4) from `COGNIA_OIDC_ISSUER_KIND`. Leave it empty or `logto` for a
Logto issuer. Set `oidc` only for a different, standards-only issuer: the
apps then send none of Logto's parameters (`prompt=consent`,
`direct_sign_in`, the organizations scope, `organization_id`) and use the
native callback `cn.cognia.app:/auth/callback`. Any other value makes the
endpoint answer 503 rather than guess.

**Which deployment a client asks.** The web app built by `Dockerfile.web`
asks its own origin. A browser paired through `/pair` asks its paired host.
The desktop app and the phone know no host until the person names one in
**Settings → Cloud deployment** (or `/me/cloud-account` on the phone): the
gateway address plus, for a self-signed host, its certificate fingerprint.
The card fetches `/api/auth/config` and shows the sign-in methods before the
address is stored, and the sign-in gate takes over once it is.

**Rotation.** The bootstrap credential is consumed by the first successful
claim. After that, set `COLLAB_ACCOUNT_BOOTSTRAP_ENABLED=false` or mint a new
credential and replace the hash. Rotating the M2M secret is a restart with the
new value. Nothing else caches it.

## 7. Verify end-to-end

```bash
# Public discovery exposes the exact browser PKCE configuration:
curl -fsS https://<gateway>/api/auth/config
# Complete PKCE + device registration in the Web /pair flow, then verify that
# /api/whoami succeeds only with Bearer <5-minute access token> plus a DPoP
# proof bound to GET /api/whoami.
```

The gateway's own unit tests cover the validation matrix (signature, `iss`,
`aud`, `exp`, scope, org mapping) in
`crates/cognia-companion-security/src/oidc.rs`; the client + refresh + persistence are
covered under `lib/logto/`.

`node scripts/smoke/compose-smoke.mjs --tier cloud` checks the whole account
plane against a running stack: `/api/auth/config` announces a multi-tenant
deployment with a native client id and a collaboration service, collab-server
is healthy, and (given two tokens) a first person claims the deployment, mints
an invitation, and a second person accepts it into the same organization. The
CI lane's `tests/real-e2e/cloud-sign-in-gate.spec.ts` drives the same path
through the real browser gate.

## 8. Local real run (colima + compose)

A full stack on one Mac, with real GitHub and Feishu sign-in. Everything the
Admin Console used to ask for is done by `pnpm logto:seed`, except creating
the machine-to-machine application it authenticates with.

1. **Start Docker.** `colima start --cpu 4 --memory 8`, then confirm
   `docker compose version` answers.
2. **Give Logto one name the browser and the containers share.** Caddy does
   not front Logto, so the issuer must be reachable from both sides under the
   same string (section 3). Add `127.0.0.1 logto` to `/etc/hosts` and set
   `LOGTO_ENDPOINT=http://logto:3001` in `.env` (from `.env.example`, with
   `LOGTO_DB_PASSWORD` set). Then `docker compose --profile logto up -d --wait`.
3. **Create the M2M application** at <http://logto:3002>: Applications →
   Machine-to-machine, name `cognia-seed`, grant it the Logto Management API
   resource with the `all` scope. Note its App ID and App Secret.
4. **Seed everything else:**

   ```bash
   LOGTO_ENDPOINT=http://logto:3001 \
   LOGTO_M2M_CLIENT_ID=<m2m id> LOGTO_M2M_CLIENT_SECRET=<m2m secret> \
   COGNIA_LOGTO_AUDIENCE=https://localhost/api COGNIA_WEB_ORIGIN=https://localhost \
   LOGTO_GITHUB_CLIENT_ID=<GitHub OAuth App id> LOGTO_GITHUB_CLIENT_SECRET=<secret> \
   LOGTO_FEISHU_APP_ID=<Feishu app id> LOGTO_FEISHU_APP_SECRET=<secret> \
   pnpm logto:seed
   ```

   The script reads connector targets from Logto itself (in Logto 1.44, the
   Feishu factory ID is `feishu-web`, but its target is `feishu`), and prints
   the `COGNIA_LOGTO_*` and `COLLAB_*` lines for `.env`. It prints each provider's
   callback as `${LOGTO_ENDPOINT}/callback/<connector instance ID>` using the
   connector returned by Logto. Neither a factory ID nor a target is a callback
   ID. Adding a provider preserves existing password login, MFA, account-linking
   settings and other enabled providers.

5. **Finish `.env`:** paste the printed lines, add
   `COGNIA_DEPLOYMENT_MODE=multi-tenant`, `COGNIA_COLLAB_URL=http://collab-server:8080`,
   `COGNIA_PUBLIC_COLLAB_URL=https://localhost/collab`,
   `COGNIA_WEB_ORIGIN=https://localhost`, `COLLAB_GRANT_KEY=$(openssl rand -hex 32)`,
   and the bootstrap credential hash from section 6. Use the same M2M app
   for `COLLAB_LOGTO_M2M_CLIENT_ID` / `_SECRET`, or create a second one.
6. **Bring the stack up:**

   ```bash
   docker compose --profile logto --profile server --profile collab --profile tls up -d --wait
   node scripts/smoke/compose-smoke.mjs --tier cloud
   ```

   Tier `cloud` verifies discovery and the collaboration server. The claim,
   invite and accept legs need tokens: mint two through the Admin Console
   (or the CI fixture) and pass `COGNIA_SMOKE_OWNER_TOKEN`,
   `COGNIA_SMOKE_MEMBER_TOKEN` and `COGNIA_SMOKE_BOOTSTRAP_CREDENTIAL`.

7. **Web:** open <https://localhost>, create the local profile, and the
   sign-in screen offers GitHub and Feishu. Sign in, claim with the bootstrap
   credential, and invite a colleague from the workspace members panel. The
   link starts with `https://localhost/invite?token=`.
8. **Desktop:** `pnpm tauri dev`, Settings → Cloud deployment, enter
   `https://localhost` (and the Caddy certificate's SPKI fingerprint if it is
   not trusted by the machine), Check, Use. The gate appears, GitHub opens
   in the system browser, and `cognia://logto/callback` returns to the app
   without pasting. `host_bindings.user_id` in the security database is set
   afterwards, and `/devices` shows who the machine belongs to.
9. **Phone:** `pnpm build && pnpm mobile:sync`, open the iOS simulator, Me →
   Cloud account, enter the same address. The gate signs in through the
   in-app browser and the same deep link.

## 9. Isolated local development configuration (verified 2026-10-04)

The local overlay extends the existing Logto services; it does not replace the
main Cognia deployment. Its separate Compose project is `cognia-local-auth`.
It uses `deploy/compose/.env.logto.local` (ignored, mode 0600) instead of changing
the existing deployment's `.env`. The private directory
`~/.config/cognia/logto-local/` is mode 0700 and contains credentials and backups.

From the repository root:

```bash
rtk docker compose --env-file deploy/compose/.env.logto.local \
  -f deploy/compose/docker-compose.yml \
  -f deploy/compose/compose.local.logto.yaml up -d --wait logto
```

Specify **`logto`** explicitly: starting every profile service also starts
unrelated Cognia services. Never use `down -v` for this persistent installation.

| Setting                      | Local value                                                                |
| ---------------------------- | -------------------------------------------------------------------------- |
| Admin Console                | `http://localhost:3302`                                                    |
| OIDC issuer                  | `http://logto.localhost:3301/oidc`                                         |
| Cognia API resource          | `http://localhost:27890/api`                                               |
| Web callback                 | `http://localhost:3000/logto/callback`                                     |
| Native callback              | `cognia://logto/callback` (plus `cn.cognia.app:/auth/callback`, unused)    |
| CLI callback                 | `http://127.0.0.1:9321/callback` (Native loopback port variation verified) |
| Admin credentials            | `~/.config/cognia/logto-local/admin.json`                                  |
| Management credentials       | `~/.config/cognia/logto-local/management.json`                             |
| First-owner claim credential | `~/.config/cognia/logto-local/bootstrap-credential`                        |

`logto.localhost` resolves to loopback on this Mac and is a Docker network alias
for Logto. The same issuer string was verified from both the host and container.
Other computers/phones cannot use this loopback-only setup. HTTP here is strictly
for local development; remote use needs a shared HTTPS domain and new exact
redirect/origin allowlists.

### Images and container boundaries

The official latest release checked during setup was **Logto 1.44.0**, published
2026-09-30. The installed image was pulled from `ghcr.io/logto-io/logto` and its
embedded `@logto/core` version was verified. The env file pins its immutable
digest `sha256:847cdd2759ad60f61b9733af0ea352183c805681dff5c9f8140a80f52d8e1340`.
PostgreSQL 17 and Redis 7 use newly pulled patch images, also pinned by digest;
these retain the base deployment's supported major versions.

Both published ports bind **127.0.0.1**. PostgreSQL and Redis publish no host
ports and belong to an internal data network. The database password is mounted
as a secret file. Logto has a read-only root filesystem, dropped capabilities,
`no-new-privileges`, bounded memory/PIDs and rotated logs. Only `/tmp` and the
CLI's migration-staging directory are writable tmpfs mounts. The latest image
has no `curl`, so its health check uses Node's built-in `fetch`.

This is a single-machine development deployment: Compose secrets are local
files, the database bootstrap user retains administrative privileges, and the
Logto process runs as the upstream image's root user with all capabilities
dropped. Do not present it as a production-hardened deployment.

### Provisioned authentication policy

- Separate public **Native** and **SPA** applications; neither needs a client
  secret in Cognia. Exact callbacks and the SPA's `http://localhost:3000` origin.
- API scopes: `brain:rpc`, `brain:read`, `brain:admin`, `collab:read`, `collab:write`.
  Organization `owner` receives all five; `member` receives all except
  `brain:admin`. New users are not automatically made organization owners.
- A server-side M2M application has the Logto Management API `all` permission
  required by Cognia's collaboration adapter. Its secret expires after 90 days;
  rotate it before expiry and update the private env file. Never expose it to
  browser code or use it as an ordinary user token.
- Username/password sign-up and sign-in, minimum password length 14, at least
  three character types, breached-password/user-info/sequence rejection.
- Mandatory end-user **TOTP**, with **backup codes** enabled. Each real user
  enrolls their own authenticator during first sign-in and saves recovery codes.
  The temporary verification account and its TOTP material were removed.
- Lockout after five failed attempts, for 15 minutes; trusted-device bypass is
  disabled. Feishu was subsequently enabled as described in section 10.
  GitHub, SMTP, SMS and automatic social-account linking remain disabled.
- Access-token TTL is one hour. Refresh tokens rotate and expire after seven
  days. Cognia's own device access tokens retain their separate five-minute
  DPoP lifetime; a Logto token is not a replacement for that device protocol.

The end-user MFA policy is separate from the OSS **Admin Console** account.
The admin account currently uses the generated strong password on the
loopback-only console; its personal authenticator has not been enrolled.

### Compatibility fixes verified against the running image

`scripts/smoke/logto-seed.mjs` now binds API scopes to organization roles,
accepts plain-text `201 Created` responses from relation endpoints, configures
refresh-token issuance/rotation, and omits secret values from dry-run logs.
The seeder preserves existing redirect URIs and unrelated client metadata.

`lib/logto/client.ts` now sends **`prompt=consent`** together with
`offline_access` to a Logto issuer (every deployment that does not set
`COGNIA_OIDC_ISSUER_KIND=oidc`). Without consent, the live Native flow returned no refresh
token, preventing Cognia from adopting an organization. The SPA refresh-token
setting alone does not fix Native clients.

### Acceptance evidence and limits

Verified with the running local service and Cognia's actual `loginToLogto`,
`refreshLogtoToken`, `revokeLogtoToken`, and CLI callback server:

- Password login → TOTP enrollment → PKCE exchange → organization refresh.
- Fresh login rejects an invalid TOTP code and accepts a valid code.
- JWT signature verifies against JWKS (ES384), with matching issuer, audience,
  organization, expiry, and member permissions; `brain:admin` is absent.
- Unauthorized organization refresh is denied; revoked refresh tokens return
  `invalid_grant`; anonymous Management API requests return 401.
- SPA token POSTs accept the configured web origin and reject an untrusted
  origin without an allow-origin header. Preflight alone is not sufficient:
  Logto answers OPTIONS before the client-specific origin check.
- A PostgreSQL custom-format backup was restored into a separate temporary
  database and all three Cognia applications were checked before removing it.
  Backup: `~/.config/cognia/logto-local/logto-2026-10-04.dump` (0600).

Focused checks: 40 Jest tests across the Logto client, discovery and cloud
sign-in flow; 11 seed-script tests; scoped ESLint, Prettier and Compose validation.
No coverage run was requested. No whole-repository build/typecheck was run.

The Cognia gateway and collaboration service **were not started**: their
published images (`cognia-server:latest-full`, `cognia-collab:latest`) returned
`denied` from GHCR, and disk space was insufficient for a full Rust image build.
Their issuer/audience/client/M2M/first-owner settings are prepared in the isolated
env file, but `/api/auth/config`, first-owner claim, invitation acceptance,
device registration, and full Web/Tauri/mobile flows remain unverified.
The database restore check validates this backup, not automated backup scheduling.

### Update and recovery

Before changing Logto versions, take a fresh private `pg_dump -Fc`, record the
currently pinned digest, and test the new image against a restored database.
Use Logto's documented database alteration procedure for upgrades; startup's
`db seed -- --swe` initializes an empty database and does not replace migrations.
Do not blindly follow a moving `latest` tag on every restart.

During this setup, disk exhaustion caused Docker to stop and left an unpacked
image with empty `package.json` files despite a successful pull result. Only
the approved npm/pnpm download caches and that newly pulled broken image were
removed. After downloading it again, the embedded package versions and startup
were verified. Keep adequate disk headroom before updating images or databases.

Sources:

- [Logto 1.44.0 release](https://github.com/logto-io/logto/releases/tag/v1.44.0)
- [Official OSS deployment configuration](https://docs.logto.io/logto-oss/deployment-and-configuration)
- [Organization-level API authorization](https://docs.logto.io/authorization/organization-level-api-resources)
- [Offline access and consent](https://docs.logto.io/end-user-flows/sign-out)
- [Password policy](https://docs.logto.io/security/password-policy)
- [Security advisory fixed in 1.43.0](https://github.com/logto-io/logto/security/advisories/GHSA-crc8-q4hm-4564)

## 10. Local Feishu login (2026-10-04)

The existing Feishu application selected by the operator is **曼波**,
App ID `cli_a8f5eac646f1d00e`. No new application was created. Its existing
capabilities and permissions were preserved; only the Logto redirect was added
to its security settings. This is an internal application in the currently
selected Feishu enterprise, not a public cross-enterprise login application.

| Setting                    | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| Feishu developer console   | `https://open.feishu.cn/app/cli_a8f5eac646f1d00e/baseinfo` |
| Logto connector factory    | `feishu-web`                                               |
| Logto connector instance   | `x6dxc655l811`                                             |
| Social provider target     | `feishu`                                                   |
| Registered Feishu redirect | `http://logto.localhost:3301/callback/x6dxc655l811`        |
| Cognia configuration       | `COGNIA_LOGTO_SOCIAL_PROVIDERS=feishu`                     |

The credentials are in `~/.config/cognia/logto-local/feishu.json` (0600), outside
the repository. Connector metadata is in `feishu-connector.json`; the previous
sign-in experience was saved as `sign-in-exp.before-feishu.json`. Supply the
credentials as `LOGTO_FEISHU_APP_ID` / `LOGTO_FEISHU_APP_SECRET` when reusing the
existing seed script; never put the secret in `NEXT_PUBLIC_*`, shell history,
tracked files, or client code. The instance ID must be read again after creating
a replacement connector, then the corresponding redirect must be registered.

Password login, username collection, mandatory TOTP/backup codes, password and
lockout policies, and disabled automatic account linking were read back after
configuration and matched the previous policy. An existing password account is
not silently merged with a Feishu identity merely because profile fields match.

Live verification completed Feishu authorization, the registered callback,
username registration as `cognia_max`, and personal TOTP enrollment. The user
confirmed saving recovery codes. The Native PKCE callback verified the ID Token's
ES384 signature, issuer, audience, nonce and expiry, and confirmed refresh-token
issuance. Test access/refresh tokens were revoked immediately after verification.
The resulting Logto account has a Feishu identity; no organization membership
or administrative role was assigned by this setup.

Evidence is in `~/.config/cognia/logto-local/feishu-verification.json`; the updated
database backup is `logto-feishu-2026-10-04.dump` in the same private directory.
This backup includes the configured connector and real account and must be
protected as sensitive data. The earlier backup restore test is separate from
this newly created backup. The seed script's 13 focused tests, scoped ESLint,
Prettier, Compose validation and a live seed dry-run passed. This does not claim
that Gateway/Collab or mobile device access has been verified.

The callback is intentionally loopback-only. Complete the flow in a browser on
this Mac; opening that callback directly on a phone addresses the phone itself.
Public or multi-device deployment needs its own HTTPS endpoint and callback
registration. Feishu login does not require opening the Logto Admin Console to
the network or adding messaging/contacts permissions to this application.

Sources:

- [Official Logto Feishu connector setup](https://docs.logto.io/integrations/feishu-web)
- [Feishu application console](https://open.feishu.cn/app)
