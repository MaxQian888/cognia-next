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

For the `server` profile, `.env` additionally needs `COGNIA_MASTER_KEY`
(`openssl rand -hex 32`) — there is no OS keyring inside a container, so the
headless secret store (ADR-0059 W5) takes its master key from the environment.
Losing it makes the store (Host signaling identities, provider credentials,
and other encrypted secrets) unreadable. Paired device private keys remain on
the client and five-minute access tokens are process-memory only.

The server-side WebRTC rendezvous uses `COGNIA_SIGNALING_URL`, which defaults
to the Compose-internal `ws://signaling:7892/v2/signaling`. Browsers and mobile
clients must never receive that Docker DNS name: set
`COGNIA_PUBLIC_SIGNALING_URL` to the public `wss://<domain>/v2/signaling` URL,
or leave it empty for `/api/auth/config` to derive the same-origin URL from the
Caddy forwarded host and scheme. Caddy routes `/v2/signaling` to the signaling
service while keeping the remaining API and WebSocket paths on
`cognia-server`.

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
  socket; the proxy allows container lifecycle + image pull only
  (`CONTAINERS`/`IMAGES`/`POST`; `EXEC` stays denied — the backend runs one
  container per agent with the agent as PID 1, it never uses the exec API).
- **`cognia_workspaces` volume** — shared between cognia-server (mounted at
  `/workspaces`) and the runners (each gets a volume-subpath mount of ONLY
  its own workspace). `COGNIA_WORKSPACES_VOLUME` must name the volume
  (fixed via `name:` in the override); without it the backend falls back to
  host-path binds, which cannot work from inside a container.
- **Runner image** — `COGNIA_RUNNER_IMAGE` (default
  `ghcr.io/maxqian888/cognia-runner:latest`). Pulled automatically on the
  first spawn if absent; pre-pull to avoid first-spawn latency.

Optional per-runner knobs (read by `container_backend.rs`, all env on the
`cognia-server` service): `COGNIA_RUNNER_SECCOMP` (profile JSON path),
`COGNIA_RUNNER_MEMORY_MB` (default 2048), `COGNIA_RUNNER_CPUS` (default 2),
`COGNIA_RUNNER_PIDS` (default 512), `COGNIA_RUNNER_NETWORK` (default
`bridge`).

Known limit: the fleet agent-monitor hook ingress is loopback-gated, so T2
runner agents (separate containers, separate loopback) are not visible to
fleet monitoring.

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

## Caddy (tls profile)

Terminates public ACME TLS and reverse-proxies to `cognia-server`'s
self-signed HTTPS on the internal network (browsers can't pin the self-signed
fingerprint; Capacitor still connects directly to `:27890`). We deliberately do
**not** add a plaintext mode to `cognia-server` — re-encrypting on the compose
network costs nothing and keeps the front door's TLS surface unchanged. Set
`COGNIA_DOMAIN` to a real hostname for Let's Encrypt, or leave it `localhost`
to use Caddy's internal CA for local testing.
