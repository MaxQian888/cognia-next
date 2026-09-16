# Cognia self-host compose suite

Docker Compose deployment of the Cognia cloud services (ADR-0059). One
`docker-compose.yml` with profiles for the phase ladder.

> **Port migration note**: cognia-server moved from 7890 to **27890**
> (7890/7891 are the Clash proxy defaults and fail to bind on most dev
> hosts). Pre-migration installs must update `.env`
> (`COGNIA_PUBLIC_URL`), firewall rules, and **re-pair devices** — the old
> pair payloads advertise the dead port.

## Quick start

```bash
cd deploy/compose
cp .env.example .env
# edit .env: set SHARE_UPLOAD_SECRET (openssl rand -hex 32)

docker compose up -d --wait            # signaling + share
SHARE_UPLOAD_SECRET=... node ../../scripts/smoke/compose-smoke.mjs   # tier-1 smoke
```

## Profiles

| Command                                                                                                      | Brings up                            | Smoke tier       |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------- |
| `docker compose up`                                                                                          | signaling (7892), share (8787)       | `services`       |
| `docker compose --profile server up`                                                                         | + cognia-server (27890)              | `server`         |
| `docker compose --profile server --profile tls up`                                                           | + Caddy (80/443)                     | `tls`            |
| `docker compose --profile observability up`                                                                  | + Prometheus (9090)                  | —                |
| `docker compose --profile logto up`                                                                          | + Logto IdP (3001/3002, pg, redis)   | — (see LOGTO.md) |
| `docker compose -f docker-compose.yml -f docker-compose.t2.yml --profile server --profile remote-browser up` | + isolated default workspace runtime | `remote-browser` |

`pnpm audit:deploy-suite` (part of `check:all`) keeps this suite coherent:
Dockerfile bases against the Rust/Node/pnpm pins, every default image against
what `images.yml` publishes, and the multi-instance invariants below.

For the `server` profile, `.env` additionally needs `COGNIA_MASTER_KEY`
(`openssl rand -hex 32`) — there is no OS keyring inside a container, so the
headless secret store (ADR-0059 W5) takes its master key from the environment.
Losing it makes the store (Host signaling identities, provider credentials,
and other encrypted secrets) unreadable. Paired device private keys remain on
the client and five-minute access tokens are process-memory only.

The server-side WebRTC rendezvous uses `COGNIA_SIGNALING_URL`, which defaults
to the Compose-internal `ws://signaling:7892/signaling`. Browsers and mobile
clients must never receive that Docker DNS name: set
`COGNIA_PUBLIC_SIGNALING_URL` to the public `wss://<domain>/signaling` URL,
or leave it empty for `/api/auth/config` to derive the same-origin URL from the
Caddy forwarded host and scheme. Caddy routes `/signaling` to the signaling
service while keeping the remaining API and WebSocket paths on
`cognia-server`.

## Multiple instances on one host

Every instance is one directory with its own `.env`, and **`COGNIA_INSTANCE`**
is the single knob that keeps instances apart. It names the compose project
(so volumes, networks and container names get their own prefix), the T2
`<instance>_workspaces` volume, and the runner ownership label the server
stamps on the agent containers it creates (`COGNIA_DEPLOYMENT_ID`). Host
ports are all overridable; container ports never change, so the Caddyfile,
healthchecks and the smoke script stay as they are.

```bash
# second instance, published beside the first
mkdir -p ~/cognia-beta && cp deploy/compose/.env.example ~/cognia-beta/.env
# edit ~/cognia-beta/.env:
#   COGNIA_INSTANCE=beta
#   COGNIA_SERVER_PORT=27891  SIGNALING_PORT=7893  SHARE_PORT=8788
#   COGNIA_HTTP_PORT=8080     COGNIA_HTTPS_PORT=8443
#   COGNIA_PUBLIC_URL=https://beta.example        # what paired devices follow
#   COGNIA_DOMAIN=beta.example                    # tls profile
cd deploy/compose
docker compose --env-file ~/cognia-beta/.env --profile server up -d --wait
```

Rules that follow from how the pieces are scoped:

- **Do not rely on `docker compose -p <name>` alone.** It renames the
  project but not the T2 workspaces volume or the ownership label, so two
  instances would share agent workspaces and reap each other's runners.
  `COGNIA_INSTANCE` is what both derive from. `.env` is read from the
  directory the compose file lives in, so pass `--env-file` for any instance
  that is not the default one.
- **`COGNIA_BIND_ADDRESS=127.0.0.1`** keeps a secondary instance off the
  public interface when your own proxy fronts it.
- **Shared Docker daemon (T2).** Every runner container carries
  `cognia.deployment=<COGNIA_INSTANCE>`. The boot-time orphan sweep removes
  only containers with the same value, so instance A restarting never
  touches instance B's live agents. Containers created by a build that
  predates the label are left alone and logged at debug level; remove them by
  hand once (`docker ps -a --filter label=cognia.owner=cognia-external-agent`).
- **One live server per data volume.** `cognia-server serve` takes an
  exclusive advisory lock on `<data>/.cognia/headless-active.lock` and refuses
  to start while another process holds it. `docker compose up --scale
cognia-server=2` therefore fails the second replica on purpose: the brain
  owns the data (ADR-0059 D3), and two brains on one volume would diverge.
  Scale by adding instances (each with its own volume and `COGNIA_INSTANCE`),
  not replicas. The same rule holds on Kubernetes, see `deploy/k8s/README.md`.
- **Signaling and share are per instance** in this suite. To share one
  signaling service between instances, point the secondary instance's
  `COGNIA_SIGNALING_URL` / `COGNIA_PUBLIC_SIGNALING_URL` at the primary's and
  leave its own `signaling` service unpublished (`SIGNALING_PORT` on a
  loopback bind address).

## Smoke test

`scripts/smoke/compose-smoke.mjs` drives the running stack (Node 22, no extra
deps). `--tier services` (default) covers signaling + share; `--tier server`
and `--tier tls` cover the later profiles. The compose file path is resolved
against the repo root, so the script runs from any cwd.

```bash
SHARE_UPLOAD_SECRET=... node scripts/smoke/compose-smoke.mjs --tier services
```

Tiers `server`/`tls` shell into the container for the loopback-only steps
(pair, service token). The default transport is `docker compose exec`; set
`COGNIA_SMOKE_EXEC` to swap it (e.g. `kubectl exec` — see
`deploy/k8s/README.md`).

The nightly `Compose E2E` workflow also builds the Web image with its dedicated
test bridge and runs `pnpm test:e2e:web-headless`. That lane creates a real
Browser Vault, consumes a fresh cgnp3 Owner invitation through the `/pair` UI,
checks the SecurityStore grant snapshot, proves single-use-ticket WS delivery
and reconnect, observes a real WebRTC upgrade, forces HTTPS/WS fallback, reloads
and unlocks the Vault, completes a streamed chat turn through the real Headless
sidecar and a network-private deterministic Anthropic fixture, grants and
revokes a second real browser device, switches between two independent Headless
hosts and their isolated target databases, and exercises the exact-origin
CORS/PNA matrix. It also runs the actual popup PKCE callback against a local
OIDC discovery/JWKS/token fixture and verifies both the default multi-tenant
member grants and a `brain:admin` Owner registration. The fixtures and extra
hosts are defined only in `docker-compose.web-headless-e2e.yml`; the provider
fixture has no host port, while the OIDC fixture's loopback port exists only for
the browser test. None are part of the production topology. The test
configuration is isolated in `playwright.web-headless.config.ts`; it is not
part of the mock-backed default Playwright suite.

## T2 — split execution plane (`docker-compose.t2.yml`)

The T2 override moves external agents out of the main container into
per-agent `cognia-runner` containers (ADR-0059 D5, `ExecBackend::Container`):

```bash
docker compose -f docker-compose.yml -f docker-compose.t2.yml \
  --profile server up -d --wait
```

What it adds:

- **`docker-socket-proxy`** — the backend never touches the raw Docker
  socket; the proxy allows container lifecycle + image pull
  (`CONTAINERS`/`IMAGES`/`POST`), plus the read-only `/info` and the named
  volume API that runtime environment sandboxes use (`INFO`/`VOLUMES`, see
  below). `EXEC` and `BUILD` stay denied — the backend runs one container per
  agent with the agent as PID 1, it never uses the exec API.
- **`cognia_workspaces` volume** — shared between cognia-server (mounted at
  `/workspaces`) and the runners (each gets a volume-subpath mount of ONLY
  its own workspace). `COGNIA_WORKSPACES_VOLUME` must name the volume
  (fixed via `name:` in the override); without it the backend falls back to
  host-path binds, which cannot work from inside a container.
- **Runner image** — `COGNIA_RUNNER_IMAGE` (default
  `ghcr.io/maxqian888/cognia-runner:latest`). Pulled automatically on the
  first spawn if absent; pre-pull to avoid first-spawn latency.
- **Ownership label** — every runner carries
  `cognia.deployment=${COGNIA_INSTANCE}` (`COGNIA_DEPLOYMENT_ID` on the
  server). The orphan sweep at boot only removes runners with the same
  value, which is what lets two instances share one daemon.

Optional per-runner knobs (read by `container_backend.rs`, all env on the
`cognia-server` service): `COGNIA_RUNNER_SECCOMP` (profile JSON path),
`COGNIA_RUNNER_MEMORY_MB` (default 2048), `COGNIA_RUNNER_CPUS` (default 2),
`COGNIA_RUNNER_PIDS` (default 512), `COGNIA_RUNNER_NETWORK` (default
`bridge`).

Known limit: the fleet agent-monitor hook ingress is loopback-gated, so T2
runner agents (separate containers, separate loopback) are not visible to
fleet monitoring.

### Runtime environments (`docker-compose.runtime-environment.yml`)

Projects can run their agents in an approved, digest-pinned image of their own
(ADR-0182), with the agent CLIs injected from the release's agent bundle
(ADR-0183). It is off unless the operator turns it on; with it off, T2 runs
exactly as described above.

Two ways to turn it on:

- **Baseline file (recommended).** The overlay mounts
  `COGNIA_ENVIRONMENT_BASELINE_HOST_FILE` read-only and points
  `COGNIA_ENVIRONMENT_BASELINE_FILE` at it. The file is the whole deployment
  policy: the switch, the registry allowlist, the isolation floor, the size
  classes, the catalog entries and the agent bundle. A file that does not
  validate stops the server at boot rather than running without the isolation
  it asks for.
- **Legacy mapping.** Without a file, `COGNIA_SANDBOX_POOL_ENABLED=true`
  derives a single `legacy-env` entry from `COGNIA_RUNNER_IMAGE`, with the
  bundle from `COGNIA_AGENT_BUNDLE_IMAGE`. Only a digest-pinned bundle admits
  sandboxes, and a tag-only runner image (the default `:latest`) is refused
  with `image_digest_not_pinned` until it is pinned.

```bash
node scripts/smoke/compose-runtime-environment.mjs baseline \
  --bundle-image ghcr.io/<owner>/cognia-agent-bundle@sha256:<digest> \
  --out /tmp/environment-baseline.json
COGNIA_ENVIRONMENT_BASELINE_HOST_FILE=/tmp/environment-baseline.json \
  docker compose -f docker-compose.yml -f docker-compose.t2.yml \
  -f docker-compose.runtime-environment.yml --profile server up -d --wait
SHARE_UPLOAD_SECRET=... pnpm compose:smoke:runtime-environment --expect pool-on
```

The smoke pairs a device, checks the catalog and driver status, approves or
catalogs a musl image (`node:22-alpine`) and a glibc image without git
(`python:3.12-slim`), spawns `codex-acp` in each with a mandatory placement,
and checks the ACP round trip, the probe cache and the user the sandbox
actually ran as. `--expect pool-off` against a stack without the overlay
checks the off path: the environment commands answer `sandbox_pool_disabled`,
a spawn that requires isolation is refused, and one that does not runs on the
runner path with a `sandbox_fallback_pool_disabled` placement (that last check
needs `COGNIA_SMOKE_AGENT=1` on the server).

The plain-container tier is single-tenant: a baseline that declares
`multiTenant` needs the gVisor tier, which the server offers only when the
daemon has `runsc` registered (read from `/info`). Desktop local containers
stay dormant in this release.

### Experimental shared browser

The `remote-browser` profile adds a persistent `workspace-runtime-default`
container for the `default` workspace. It runs both external-agent children
and Playwright Chromium behind a private, secret-authenticated protocol; no
runtime, Playwright, or CDP port is published to the host. The runtime sees a
dedicated workspace volume, never the host filesystem or Docker socket.

Set `COGNIA_WORKSPACE_RUNTIME_SECRET` to at least 32 random characters and set
`COGNIA_REMOTE_BROWSER_ENABLED=true`, then start both `server` and
`remote-browser` profiles. The runtime writes its per-workspace secret into a
private named volume mounted read-only by `cognia-server`. Users must still
enable the experiment in Cognia settings. Add one identically isolated
service/volume/secret per additional workspace; do not mount the aggregate
`cognia_workspaces` volume into a runtime.

## Seccomp profile (`seccomp/cognia-userns.json`)

The `cognia-server` service runs under a tuned seccomp profile so the ADR-0028
sandbox (bubblewrap) can create user namespaces inside a **non-privileged**
container. It is `moby/moby` `v27.4.0`'s stock `default.json` with one scalpel
change: the namespace-creating syscalls (`clone`/`clone3`/`unshare`/`setns`/
`mount`/`umount2`/`pivot_root`/`sethostname`) are allowed unconditionally
instead of only under `CAP_SYS_ADMIN`. Everything else is stock. **Never**
combine with `--privileged`.

- **AppArmor hosts (Ubuntu):** also add `apparmor=unconfined` to the service's
  `security_opt` — bwrap's mount operations trip the default docker AppArmor
  profile. Docker Desktop / WSL2 has no AppArmor, so the dev machine needs
  nothing extra.
- **Omitting the profile:** the sandbox degrades honestly — tool execution
  routes through `UninstalledSandboxBackend` (a hard deny with a "setup
  required" surface), never a silent bypass.

Verify bwrap works under the profile:

```bash
docker run --rm --security-opt seccomp=deploy/compose/seccomp/cognia-userns.json \
  debian:bookworm-slim sh -c "apt-get update >/dev/null 2>&1 && apt-get install -y bubblewrap >/dev/null 2>&1 && bwrap --unshare-all --ro-bind / / true && echo bwrap-ok"
```

**Regenerating** the profile after a moby release: re-download
`profiles/seccomp/default.json` at the target tag, drop the standalone
`clone3` ERRNO entry, and append the unconditional namespace-syscall allow
block (see the `_comment` field and the git history of this file).

## Connector webhooks (server profile)

Cloud installs receive platform webhooks (Telegram / Slack / Discord / Lark /
WeChat OA) **directly on the front door** at
`/connectors/webhook/<adapter_type>/<adapter_id>` (ADR-0059 F4) — no
cloudflared tunnel required, unlike desktop installs. The routes sit outside
JWT auth (each platform's HMAC/signature + replay guard is the auth), inside
the per-source-IP rate limit and body cap. The brain registers adapters via
the service-scope `connectors_register` RPC; unregistered adapter ids answer
a deterministic `404 {"error":"adapter not registered"}` (what the tier-2
smoke asserts). Point the platform's webhook URL at your public
`https://<domain>/connectors/webhook/...` (through Caddy when the `tls`
profile is up).

## Lark / Feishu entry surfaces (server profile)

Web SSO, entry-link resolve, message-shortcut import and JSSDK signing live at
`/integrations/lark/*` on `cognia-server` (ADR-0091). Caddy already proxies
that prefix, but the server needs to know its own public origin to build the
OAuth `redirect_uri` — it cannot infer it, because the value has to match what
is registered in the Feishu console byte for byte.

| Variable                           | When                          | Value                            |
| ---------------------------------- | ----------------------------- | -------------------------------- |
| `COGNIA_LARK_PUBLIC_BASE`          | any Lark deployment           | `https://${COGNIA_DOMAIN}`       |
| `COGNIA_LARK_WEB_BASE`             | web app on a different origin | `https://app.example`            |
| `NEXT_PUBLIC_COGNIA_LARK_API_BASE` | web app on a different origin | the companion origin, build-time |

The first two are runtime env on `cognia-server` and are validated at startup:
a value that cannot work (no scheme, plaintext `http://` on a public host, a
query string or fragment, embedded credentials) **aborts the boot** with the
variable named, instead of 503-ing later inside a Feishu client. Warnings —
loopback origins, a `WEB_BASE` with no `PUBLIC_BASE` behind it — print and
start anyway.

The third is baked into the static export at image-build time, so a
split-origin deployment must rebuild the `caddy` image (add it as a build
`ARG`/`ENV` in `Dockerfile.web`) rather than setting it in `.env`.
Same-origin installs — the reference stack, where Caddy serves both — need
none of that: leave `COGNIA_LARK_WEB_BASE` empty and the browser uses relative
URLs.

Console configuration, verification matrix and rollback:
[`docs/runbooks/lark-entry-surfaces.md`](../../docs/runbooks/lark-entry-surfaces.md).

## Caddy (tls profile)

Terminates public ACME TLS and reverse-proxies to `cognia-server`'s
self-signed HTTPS on the internal network (browsers can't pin the self-signed
fingerprint; Capacitor still connects directly to `:27890`). We deliberately do
**not** add a plaintext mode to `cognia-server` — re-encrypting on the compose
network costs nothing and keeps the front door's TLS surface unchanged. Set
`COGNIA_DOMAIN` to a real hostname for Let's Encrypt, or leave it `localhost`
to use Caddy's internal CA for local testing.
