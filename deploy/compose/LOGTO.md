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
     deep-link `cognia://logto/callback`.
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
   ```

5. Restart with all three profiles:

   ```bash
   docker compose --profile server --profile logto --profile collab up -d --wait
   ```

**Callback modes.** The web app redirects to `<web origin>/logto/callback` (the
SPA app). The CLI listens on a loopback port. The desktop app sends the system
browser to the deep link `cognia://logto/callback` and asks the person to paste
the address it lands on. All three URIs must be registered on the matching
Logto application or Logto refuses the authorization request.

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
`src-tauri/src/companion_api/oidc.rs`; the client + refresh + persistence are
covered under `lib/logto/`.
