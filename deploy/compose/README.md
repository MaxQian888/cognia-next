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

The `server` profile needs a master key. There is no OS keyring inside a
container, so the headless secret store (ADR-0059 W5) takes it from
`COGNIA_MASTER_KEY` in `.env` (`openssl rand -hex 32`), or, when that is empty,
from `/data/master.key` in the data volume. Create that file once with
`docker compose --profile server run --rm cognia-server init` (ADR-0224 A1); it
is never replaced. Losing the key makes the store (Host signaling identities,
provider credentials, and other encrypted secrets) unreadable, so back it up.
Paired device private keys remain on the client and five-minute access tokens
are process-memory only.

The server runs `serve --no-mdns`: multicast has no meaning on a container
network. Phones and desktops pair over the relay with
`docker compose exec cognia-server cognia-server pair`, which prints a
`cgnp4|…` invitation that works without a public domain.

### Production overlay

`compose.production.yaml` hardens the `server` profile for an operator-run
deployment (read-only root, dropped capabilities, resource limits) and
**requires** digest-pinned images, `COGNIA_PUBLIC_URL`, `COGNIA_CONFIG_REVISION`
and S3-compatible object backup. Secrets come from files, never from `.env`:
`COGNIA_SECRET_ROOT` is a host directory mounted read-only at
`/run/cognia-secrets`, holding

| File                             | Read as                                          |
| -------------------------------- | ------------------------------------------------ |
| `master-key`                     | `COGNIA_MASTER_KEY_FILE` (64 hex)                |
| `master-keys/<v>.key`            | versioned keys for `cognia-server rotate-key`    |
| `backup-keys/`                   | backup encryption keys (`COGNIA_BACKUP_KEY_DIR`) |
| `s3-access-key`, `s3-secret-key` | object-store credentials                         |
| `metrics-operator-token`         | the `/metrics` operator bearer                   |

and `SHARE_UPLOAD_SECRET_FILE` names the share service's upload secret. A
personal always-on host at home does not need this overlay: the base `server`
profile with `init` is the BYO path (ADR-0224).

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

- **`docker-proxy`** (`cognia-docker-proxy`, ADR-0224 A8) — the server never
  touches the raw Docker socket. Unlike a URL-prefix filter, the proxy reads
  request bodies: a container is created only with this deployment's labels
  (`cognia.owner`, `cognia.deployment=${COGNIA_INSTANCE}`), mounts only the
  workspaces volume and this deployment's agent bundle volumes, and never
  asks for privileged mode, host network / PID / IPC / UTS / user / cgroup
  namespaces, devices, extra capabilities beyond the five the agent
  supervisor adds back, or an unconfined security profile. Start, stop,
  exec and remove reach only containers carrying those labels; lists only
  show them. Exec is allowed into those containers (the sandbox pool's
  workspace runtime, port relay and service bridge need it). Image builds,
  networks, swarm, secrets and archive uploads are refused, so devcontainer
  builds (ADR-0186) do not run through it. Rootless Docker is recommended.
- **Sandbox pool on by default** — `COGNIA_SANDBOX_POOL_ENABLED` defaults to
  `true` here: dispatched work (Bots, scheduled tasks, phone turns, agent
  teams, plugin agents) runs in a container per task. Containers start only
  once `COGNIA_AGENT_BUNDLE_IMAGE` names a digest-pinned bundle (see
  [Runtime environments](#runtime-environments-docker-compose-runtime-environmentyml));
  until then an external agent whose project does not require isolation
  falls back to the server process, while a built-in turn's Bash, Edit and
  Write are refused (a headless host never runs them in its own process
  unless the project opts out with **Run as host processes on an always-on
  host**). Set the variable to `false` to keep external agents in the server
  process.
- **Task workspace root** — `COGNIA_TASK_WORKSPACE_EXECUTION_ROOT` moves task
  working copies (`executions/`, `scratch/`) to
  `/workspaces/.cognia-task-workspaces`, inside the workspaces volume, so a
  scheduled task's lease can be mounted into its container. The agent
  launcher follows the same variable.
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
`bridge`; `host` and `container:<id>` are refused).

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

### Network drives through SFTPGo (`compose.sftpgo.yaml`)

A live file share (ADR-0222) gives a person a WebDAV/SFTP sign-in for some
folders of one conversation. cognia-server can serve those itself (Settings →
Connectivity → Network drive), or hand them to a separately deployed
[SFTPGo](https://github.com/drakkan/sftpgo), which is the better fit on a
server that already fronts file transfer. The overlay adds SFTPGo next to the
T2 stack, with the shared `cognia_workspaces` volume mounted at
`/srv/sftpgo/workspaces`:

```bash
# .env: SFTPGO_ADMIN_PASSWORD=$(openssl rand -hex 16)
docker compose -f docker-compose.yml -f docker-compose.t2.yml \
  -f compose.sftpgo.yaml --profile server --profile sftpgo up -d --wait
```

Then, once:

1. Open the admin UI on `127.0.0.1:${SFTPGO_ADMIN_PORT:-8090}` (an SSH
   tunnel from elsewhere; it is never published wide), sign in as
   `SFTPGO_ADMIN_USERNAME`, turn on **Allow API key authentication** in your
   profile, and create an admin-scope API key.
2. In Cognia, Settings → Connectivity → Network drive → SFTPGo: admin API URL
   `http://sftpgo:8080`, the key, home directory base `/srv/sftpgo/homes`,
   path mapping `/workspaces` → `/srv/sftpgo/workspaces`, and the public SFTP
   host / WebDAV URL people should dial.

Cognia then creates one SFTPGo user per share credential, with a virtual
folder for each granted path only, the sensitive-file floor as denied
patterns, and the grant's expiry; revoking deletes it. A folder with no
mapping refuses the grant (`sftpgo_path_unmapped`) rather than exposing a
wider tree. SFTPGo runs as cognia-server's uid (10001) so a write grant can
change what agents created; `sftpgo-init` hands the state volumes over once.
Put the WebDAV port behind TLS (Caddy or your own proxy) before publishing
it: Windows will not send a password to a plain-HTTP WebDAV address.

SFTPGo is AGPL-3.0. It runs here as the unmodified upstream image, as its own
service, and is never bundled into the desktop app.

## Self-updates (`compose.host-updates.yaml`)

An always-on host updates itself (ADR-0224 A10), but a container cannot
replace its own image. This overlay runs `cognia-deploy-agent host-updates`
beside the server. It is the deploy agent's standalone host mode: no Ops
Controller and no enrollment, just this one stack.

```bash
# .env: COGNIA_COMPOSE_DIR=/absolute/path/to/deploy/compose
docker compose -f docker-compose.yml -f docker-compose.t2.yml \
  -f compose.host-updates.yaml --profile server up -d --wait
docker compose -f docker-compose.yml -f docker-compose.t2.yml \
  -f compose.host-updates.yaml --profile server run --rm host-updates host-updates adopt
```

`adopt` pins the image the server runs now, by its registry digest, as
`COGNIA_SERVER_IMAGE` in `.env`. Keep the overlay in every later command (set
`COMPOSE_FILE` in `.env`), or a plain `up` recreates the server without its
socket.

How an update runs:

1. The server finds a release for its channel and platform
   (`COGNIA_HOST_TARGET`, set by the image), waits until nothing is running,
   stops taking writes, and asks the agent over
   `/run/cognia-host-updates/agent.sock`. It sends its channel, rollout
   bucket and the version it expects, never an image.
2. The agent checks the signed catalog and the update Worker's rollout gate
   itself, refuses if it finds another version, and confirms that the Compose
   files take the server image from `COGNIA_SERVER_IMAGE`. Then it pulls
   `repository@digest`.
3. It records the old version's failed required runtimes, pins the digest in
   `.env`, and runs `docker compose up -d --no-deps cognia-server`. It uses the files,
   working directory and env files Compose recorded on the server container,
   with a cleared environment, so nothing but your own files decides the
   result.
4. It probes `/readyz` from inside the new container. Bootstrap completion,
   a healthy bridge, and no new required-runtime failures for 30 seconds commit
   the update. Required failures already present in the old version still make
   public readiness return 503, but do not block this trial. A refused brain
   (a server and brain from different builds), or failure to complete the trial
   within ten minutes, rolls back: the old digest is pinned again and the server
   recreated. **Host updates** on the owner's device shows the outcome.

Compose healthchecks use `/readyz` to gate `docker compose up --wait`. A failed
healthcheck does not restart the container: `restart: unless-stopped` reacts to
process exits, and no autoheal watcher is configured. The update agent deliberately
omits `--wait` so its trial can account for the pre-update failure baseline.
Use `/livez` for any external probe that restarts containers; a required-runtime
restart temporarily makes readiness fail without making the process dead.

What the agent may touch, and why it is safe to leave running:

- **The Docker socket** (hence root, with every capability dropped except
  `CHOWN` and `DAC_OVERRIDE`, which rewrite the `.env` line and hand the file
  back to its owner). It recreates only the server service.
- **One line of `.env`**: `COGNIA_SERVER_IMAGE`. Every other byte is kept, as
  are the file's owner and mode. The env file must live in this directory.
- **Its socket** is on a volume only it and the server mount. The agent checks
  each caller's uid (`COGNIA_HOST_UPDATES_ALLOWED_UIDS`, default the server
  image's 10001). A caller can at most ask for a release the catalog signs and
  the Worker is rolling for this host.
- **Its state** (`host_updates_state`): the swap in progress, so an agent
  restarted mid-update finishes or rolls back, and the catalog's trust state.

It trusts the root compiled into its build (`COGNIA_UPDATE_TRUST_ROOT` pins
another) and asks `COGNIA_UPDATE_URL` (default `https://update.cognia.cn`).
Watch it with `docker compose logs -f host-updates`. A Compose file that
hard-codes the server image cannot be updated this way, and the agent says so
instead of swapping anything.

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
