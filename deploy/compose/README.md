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

| Command                                            | Brings up                          | Smoke tier       |
| -------------------------------------------------- | ---------------------------------- | ---------------- |
| `docker compose up`                                | signaling (7892), share (8787)     | `services`       |
| `docker compose --profile server up`               | + cognia-server (27890)            | `server`         |
| `docker compose --profile server --profile tls up` | + Caddy (80/443)                   | `tls`            |
| `docker compose --profile observability up`        | + Prometheus (9090)                | —                |
| `docker compose --profile logto up`                | + Logto IdP (3001/3002, pg, redis) | — (see LOGTO.md) |

For the `server` profile, `.env` additionally needs `COGNIA_MASTER_KEY`
(`openssl rand -hex 32`) — there is no OS keyring inside a container, so the
headless secret store (ADR-0059 W5) takes its master key from the environment.
Losing it makes the store (device JWTs, provider creds) unreadable.

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
