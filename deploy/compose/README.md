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

## Upgrading an existing collaboration database

Set `COLLAB_APP_DB_PASSWORD` to a dedicated password in the operator environment
and restart/recreate the collaboration service with the updated image and Compose
file: `docker compose --profile collab up -d --wait collab-server`. Keep the
existing `COLLAB_DB_PASSWORD` and database volume. On the next boot, the migrator
uses the admin `COLLAB_MIGRATION_DATABASE_URL` to run migrations, create
`cognia_collab_app` if absent, and grant its query privileges under the migration
lock. The query pool uses this ordinary `NOSUPERUSER NOBYPASSRLS` login. This also
works for existing volumes that contain only the Postgres admin role. Passwords
are set only when creating the role; rotating an existing role's password requires
an operator `ALTER ROLE` and updating `COLLAB_APP_DB_PASSWORD` together. The
Compose password defaults are for local use only; URL-encode reserved characters
in connection URLs (a long hexadecimal password avoids this issue).

`GET /health` includes `"rls": "enforced"` when the app connection is neither
SUPERUSER nor BYPASSRLS. A privileged app role refuses to start unless
`COLLAB_ALLOW_PRIVILEGED_DB_ROLE=true`; that override logs a warning on every
boot and health reports `"rls": "bypassed"`. Use the split migration/query URLs
to fix a refusal. This field reports database-role enforcement, not a full
authorization audit. The standalone bootstrap keeps using its admin
`COLLAB_BOOTSTRAP_DATABASE_URL` because it must bypass RLS.

For cross-tenant standing audits, run `cognia-collab-server audit-standing`
with `COLLAB_OPERATOR_DATABASE_URL` set to a role with BYPASSRLS (a superuser also
works) and the required table privileges. It falls back to `--database-url`
(or `COLLAB_DATABASE_URL`) when the operator URL is unset. Audits do not run DDL;
use `--apply` only to repair the reported standing in batches.

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

`--tier persons` pairs two people of one org into the multi-tenant
`cognia-server-cloud` (web-headless-e2e overlay). It checks the following:

- each person gets their own person-brain partition;
- HostState sessions are accepted without a Host admin lease;
- neither person sees the other's rows;
- runtime intents and model calls keep their dormancy codes, except tool-less member chat on a Host that advertises it (`claude.tool-less-chat`), where the pet answers `headless-host`;
- an org owner writes model keys, the agent allowlist and usage caps directly, sees metadata only, and a member is refused;
- member chat: without an org key a turn fails `model_access_unavailable`; with one, the member gets the fixture's reply through the org key and their usage grows; capped at 1 token, the turn ends `fatal-error` and spends nothing;
- `cognia-server persons list` shows both partitions, and `persons purge` empties one.

It needs the org and both people seeded first with `collab-bootstrap`, and the fixture provider profile (`tests/real-e2e/persons-provider-profiles.json`, mounted at `/fixture/`) imported with `cognia-server profiles import` before the Host starts or followed by a restart: a running Host projects only changes made through its own store. The Logto organization id must be included, because device registration matches the token's `organization_id` against it. The seed values the tier assumes are `COGNIA_SMOKE_PERSONS_ORG_ID`, `COGNIA_SMOKE_PERSONS_LOGTO_ORG` and `COGNIA_SMOKE_PERSONS`; `Compose E2E` tier 2 runs the seed step. Set `COGNIA_PERSONS_SERVER_URL` and `COGNIA_SMOKE_PERSONS_EXEC` to run the tier against a Host outside compose.

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

### Feature rollout policy

Run the server once to migrate before using the operator CLI. Set
`COLLAB_OPERATOR_DATABASE_URL` to the operator role's URL (or pass
`--database-url`). Rollout commands never run migrations and do not require
SUPERUSER or BYPASSRLS:

```sh
cognia-collab-server rollout show
cognia-collab-server rollout show --feature shared-chat
cognia-collab-server rollout apply --file policy.json --base-revision 0 \
  --operation-id rollout-2026-10-20-01 --reason 'Start the canary'
```

The JSON file uses the snake_case fields in the policy model, including
`feature_key`, `schema_version: 1`, `revision`, `phase`, `kill`,
`allow_org_ids`, `deny_org_ids`, `deny_workspace_ids`,
`percentage_basis_points`, optional `cohort_key`, `cohort_salt`,
`hash_version: 1`, `minimum_contract_version` and `requires`. Canary policies
require a non-empty salt. The apply uses compare-and-swap on `--base-revision`
and assigns the next revision. Repeating the same operation id and request
returns the original result; changed content conflicts. The authenticated
PostgreSQL `current_user` is recorded as principal.

Minimal operator grants (replace `collab_rollout_operator` with your role):

```sql
GRANT USAGE ON SCHEMA public TO collab_rollout_operator;
GRANT SELECT, INSERT, UPDATE ON deployment_feature_policies TO collab_rollout_operator;
GRANT SELECT, INSERT ON deployment_feature_policy_audit TO collab_rollout_operator;
```

Both tables are deployment-level and have no RLS. The application's role is
SELECT-only; the migrator revokes its write privileges after blanket grants
on every boot. Audit rows are append-only, with bounded change summaries.

## Multi-tenant Host

Set `COGNIA_DEPLOYMENT_MODE=multi-tenant`. Before serving, the Host requires a
`COGNIA_ENVIRONMENT_BASELINE_FILE` visible inside the container with
`multiTenant: true`, `sandboxPool.enabled: true`, and `isolationFloor` of
`gvisor` or `vm`. The existing catalog validator checks the baseline. The
reachable providers' placement tiers must attest that floor (Docker checks
registered OCI runtimes, including `runsc`; remote drivers use their tier probe).
With a provider set, preflight probes the default remote provider used by auto
placement and the other explicitly selectable members. It unions only healthy
answers; a weak local primary cannot hide a healthy remote VM, and a failed VM
provider cannot borrow a VM tier from configuration.
Mount the baseline file and configure the sandbox runtime/provider separately.
Configure `COGNIA_COLLAB_URL` and `COGNIA_COLLAB_SERVICE_CREDENTIAL` for standing
lookups; no standing or an unreachable collaboration plane grants no Host access.

`COGNIA_EXECUTION=disabled` boots a control-plane-only Host without a sandbox
runtime. Execution surfaces return `503 execution_isolation_unavailable` and
`/api/auth/config` reports `execution: "unavailable"`. Only `enabled` and
`disabled` are accepted; the default is `enabled`. Missing or empty Compose mode
uses `single-user`, preserving existing behavior. A stricter `multiTenant`
baseline remains allowed in single-user mode.

The disabled backend owns no process manager: even callers outside RPC cannot
spawn or send work. Boot-time orphan reaping and empty status/list reads need
no runtime. Disabled execution is independent of standing and applies to both
deployment modes and to device, owner and service scopes.

The policy uses resolved descriptor **arms**, after command alias resolution:

- `executionCapabilities` contains only `agent.worker`, the worker-only stream
  capability. The five manifest candidates are mixed: `agent.run` has
  `claude_sidecar_status`, `workflow.run` has `workflow_run_list`,
  `terminal.open` has `terminal_host_status`, `process.spawn` has `plugin_list`,
  and `host.execute` has deletion preparation/abort and approval bookkeeping.
  None can safely disable its whole capability. The other capabilities are
  also mixed; `client.read` and `client.write` separately use the dormant
  `host-data` class described below.
- `executionCommands` names the specific arms that launch/drive work or
  install/activate executable content. This includes internal `client.local`
  calls, plugin activation through `client.write`, Git subprocesses/hooks,
  and lazy process creation hidden behind some read-looking adapters. For
  example, Git status uses libgit2 and remains available; Git blame and stack
  capability probing invoke system Git and are disabled. GitHub runner status
  probes invoke `gh`; SFTP goes through `connect_or_spawn_terminal_host`.
- `nonExecutionCommands` contains explicit `{arm, reason}` exceptions to the
  suspicious-name guard. A name alone is not classification: `subscription`
  and `truncate` match the regex, but do not execute scripts or runs. Likewise,
  recording/listener tasks and stored metadata are distinct from workloads.

The co-located policy tests require every manifest arm matching
`spawn|exec|run|terminal|pty|shell|process|install|activate|launch|start|hook|python|script`
to be execution-gated or explicitly explained. Both lists must be unique,
disjoint and reference real arms; no regex default grants authority.

`/api/whoami`, `/api/catalog`, device/invitation/policy management, `/metrics`,
`/internal/catalog`, `/internal/events`, and `/ws/events` are not execution
routes. Their existing authentication/standing still applies. RPC routes
check each command, so reads in a mixed capability retain their standing checks
and the `host-data` refusal below. The main DataChannel and relay likewise admit
`host.observe` and gate RPCs individually.
Descriptor-less PTY, browser/ACP, worker and interactive remote-desktop streams
carry an explicit execution flag before attachment/ticket minting. This avoids
turning their shared observation capability into a blanket execution ban.

### Host-global overrides within mixed client capabilities

`commandOverrides` applies only in multi-tenant mode, before capability standing:
all eight arms below require `org-action` / `host.global-surfaces`. Single-user
standing remains unchanged, and the independent execution switch still applies.

| Arms                                           | Host-global effect / implementation evidence                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin_set_enabled`, `plugin_cogset_activate` | Reconcile the Host plugin manager/cogset; `lib/companion/desktop-write-source.ts:1840`, `:1882`, `lib/plugin/core/manager.ts:1622`. Both are execution commands. |
| `plugin_install_origin_record`                 | Writes Host installation provenance, without installing code; `desktop-write-source.ts:1856`. It is an explicit non-execution exception.                         |
| `mcp_set_enabled`, `mcp_set_tool_rules`        | Host MCP definitions, governance and config-sync jobs; `desktop-write-source.ts:1914`, `lib/db/mcp-servers.ts:154`.                                              |
| `skill_set_enabled`                            | Host skill status; `desktop-write-source.ts:1819`.                                                                                                               |
| `adapter_update_policy`                        | Host adapter configuration; `desktop-write-source.ts:1987`.                                                                                                      |
| `app_settings_update`                          | Host settings patch; `desktop-write-source.ts:2082`.                                                                                                             |

The override regression tests pin these eight real manifest arms as exceptions
to `host-data`, retaining their org standing requirement. `plugin_set_enabled`
without the org action returns `403 host_surface_forbidden`; unavailable
standing fails closed.
The `client` class remains for `client.local` bridge plumbing; Host-stored data
has its own class and must not be treated as client-local.

### Host data admission and routing (P5)

On a multi-tenant `cognia-server` with the person fleet installed, `host-data`
commands resolve only the authenticated device's OIDC-verified person binding
and require current non-guest organization standing. They execute in that
person's brain/account; request arguments cannot select another partition.
Desktop Hosts and servers without a fleet retain `403 host_data_unpartitioned`.
The eight Host-global overrides above still require `host.global-surfaces` and
use the operator brain. Single-user admission and routing are unchanged.

The operator brain retains its existing `service` token. Person children use
`person-brain`, which cannot pass service-trust checks or call service RPCs.
See [person lifecycle, sizing and purge](#multi-tenant-person-data-p5) below.

| Family                                                 | Multi-tenant Rust admission and route                                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messages, sessions, transcripts and history references | Person-specific messages/writes bridge. Storage/history only; agent-run replies remain refused. No degraded `SqliteAppStore`, operator or WebView fallback.                                  |
| `sync_list_tables` / `sync_pull`                       | Static registry for discovery; the person's bridge and account id for pulls. Operator/plugin-added table descriptors cannot widen a person partition's registry.                             |
| `files_library_*`                                      | The person's writes bridge and data root; upload handle rules remain in the TS data adapter.                                                                                                 |
| `pet_*`                                                | Pet storage uses the person's writes bridge. `pet_chat_send` and `pet_soul_generate` remain intentionally dormant with `503 model_access_unavailable` until P6.                              |
| Push registration/revocation                           | Registry namespace is `(person account, authenticated device id)` under the person's data root. Person event delivery selects only that registry. Legacy single-user JSON remains unchanged. |
| Issues and characters                                  | The person's writes bridge; the brain's process-local database supplies the partition boundary.                                                                                              |
| Glance / `glance_quota_enable`                         | The person's writes bridge; provider access is not granted by partition admission.                                                                                                           |
| `twin_profile_get`                                     | The person's writes bridge and account-local profile store.                                                                                                                                  |

The Rust boundary and Node `person` data profile must be deployed together.
Two-person real-server acceptance is a separate P5c check; account-keyed fake
bridge tests establish Rust routing and response ownership only.

### Exact execution and exception inventories

The protocol JSON is the authority. The following review snapshot lists every
arm, grouped by the dispatch target used to classify it; the test checks the
protocol inventory against the manifest rather than inferring behavior from names.

<details>
<summary>Agent/workflow dispatch (rpc/chat.rs, rpc/data_sync.rs, desktop-write-source.ts)</summary>

```text
agent_compact, agent_resolve_permission, agent_send, agent_session_api, agent_task_resume,
agent_task_start, bot_delivery_replay, bot_run_manual, browser_act, browser_back, browser_drag,
browser_evaluate, browser_forward, browser_handle_dialog, browser_navigate, browser_new_page,
browser_press_key, browser_reload, browser_scroll, browser_session_ensure, browser_set_files,
browser_set_zoom, browser_switch_page, claude_approve, claude_call_reserve_respond, claude_compact,
claude_plugin_tool_response, claude_protocol_adapter_message, claude_restart_sidecar,
claude_restore, claude_send, claude_session_control, claude_set_mode, claude_tool_result_decision,
codex_app_task_create, codex_app_task_send, execution_run_approval_respond, execution_run_control,
execution_run_create, execution_run_resume, goal_accept, goal_continue, goal_resume,
goal_subgoals_generate, goal_verify_retry, room_send, team_run_resume, team_run_start,
team_task_create, workflow_approval_respond, workflow_create, workflow_handoff_create,
workflow_human_input_submit, workflow_schedule_resume, workflow_step_result,
workflow_trigger_manual, workflow_update
```

</details>

<details>
<summary>External agents and background/MCP process drivers (rpc/native_tools.rs, rpc/data_sync.rs, exec_backend.rs)</summary>

```text
agent_gateway_lease_prepare, agent_start, agent_tool_host_control, background_job_spawn_bridge,
background_job_spawn_scheduled, background_job_spawn_session, background_monitor_register_scheduled,
external_agent_admit_run, external_agent_detect_runtimes, external_agent_probe_runtime_version,
external_agent_resolve_decision, external_agent_run_turn, external_agent_session_mutate,
external_agent_update, external_bridge_restart, external_bridge_start, mcp_server_restart,
mcp_server_start, plugin_api_batch_invoke, plugin_api_invoke, send_to_external_agent,
siwc_responses_open, siwc_send_app_server, siwc_spawn_app_server, spawn_external_agent
```

</details>

<details>
<summary>Terminal/shell/SSH and sandbox dispatch (rpc/terminal.rs, terminal/headless.rs, commands.rs, host_bridge.rs)</summary>

```text
acp_terminal_create, acp_terminal_write, cua_sandbox_exec, cua_sandbox_start,
environment_task_shell_exec, project_environment_execute, run_agent_hook, sandbox_exec, shell_exec,
ssh_terminal_set_forward_enabled, ssh_terminal_spawn, ssh_terminal_write, terminal_exec,
terminal_headless_exec, terminal_headless_run, terminal_headless_spawn, terminal_host_service,
terminal_kill_port, terminal_list_tmux_sessions, terminal_list_tmux_windows, terminal_open_serial,
terminal_reattach, terminal_serial_attach, terminal_serial_write, terminal_spawn,
terminal_take_control, terminal_write
```

</details>

<details>
<summary>Plugin executable lifecycle (rpc/plugins.rs, plugin-runtime/lifecycle.rs and python/commands.rs)</summary>

```text
plugin_activate_vscode, plugin_backup_restore, plugin_bundle_install_from_file,
plugin_bundle_install_from_url, plugin_cli_exec, plugin_cogpack_install_staged,
plugin_cogpack_transfer_install, plugin_cogset_activate, plugin_commit_staged_update,
plugin_computer_use_bash, plugin_computer_use_execute, plugin_deactivate_js,
plugin_deactivate_vscode, plugin_download_version, plugin_finalize_staged_update, plugin_install,
plugin_install_from_directory, plugin_install_from_files, plugin_install_from_github,
plugin_invoke_js_callback, plugin_invoke_vscode_rpc, plugin_launch_js, plugin_load_vscode,
plugin_python_call, plugin_python_call_hook, plugin_python_call_tool, plugin_python_eval,
plugin_python_get_tools, plugin_python_host_response, plugin_python_import,
plugin_python_initialize, plugin_python_install_deps, plugin_python_install_uv, plugin_python_load,
plugin_python_module_call, plugin_python_module_getattr, plugin_python_push_config,
plugin_python_unload, plugin_set_enabled, plugin_stage_from_directory, plugin_stage_version,
plugin_unload_vscode, plugin_vscode_download_vsix, plugin_vscode_install_vsix,
plugin_vscode_install_vsix_from_path, plugin_vscode_send_response, plugin_wasm_activate,
plugin_wasm_call, plugin_wasm_deactivate, plugin_wasm_install_from_file,
plugin_wasm_install_from_git, plugin_wasm_install_from_url, plugin_wasm_load,
plugin_wasm_renderer_response, plugin_wasm_unload
```

</details>

<details>
<summary>Host provisioning/session launch (rpc/host_admin.rs, remote-desktop/session.rs, siwc/app_server.rs)</summary>

```text
automation_execute, browser_cdp_execute, browser_credential_fill, browser_embed_act,
browser_embed_back, browser_embed_create, browser_embed_evaluate, browser_embed_forward,
browser_embed_navigate, browser_embed_reload, browser_extension_install_confirm,
browser_extension_install_crx, browser_extension_install_unpacked,
browser_extension_install_webstore, browser_extension_remove, browser_extension_set_enabled,
browser_extension_update, browser_extensions_check_updates, browser_local_frames_subscribe,
browser_local_install, browser_local_rpc, browser_local_start, canvas_run_python,
desktop_launch_app, environment_local_call, file_share_activate, file_share_sftpgo_set,
host_runtime_restart, host_update_install, managed_desktop_connect, managed_desktop_control_input,
managed_desktop_create, managed_desktop_local_call, managed_desktop_prepare_template,
remote_desktop_binding_launch, remote_desktop_local_call, remote_desktop_session_open
```

</details>

<details>
<summary>Executable installation and scheduler dispatch (scheduling/scheduler, plugin-runtime, sidecar)</summary>

```text
browser_context_submit, codeserver_activate_proxy, codeserver_activate_proxy_temporary,
codeserver_agent_run_in_terminal, codeserver_build_proxy, codeserver_ensure, download_cognia_cli,
dsh_runtime_finalize, dsh_runtime_install, ensure_system_lsp_host, fleet_codex_hooks_install,
fleet_codex_install, fleet_opencode_install, fleet_scripts_install, lsp_host_ensure,
lsp_host_request, scheduled_task_backfill, scheduled_task_create, scheduled_task_emit_event,
scheduled_task_import, scheduled_task_resume, scheduled_task_run_now, scheduled_task_update,
scheduler_arm_task, scheduler_confirm_task, scheduler_create_task, scheduler_enable_task,
scheduler_request_elevation, scheduler_run_task_now, scheduler_update_task,
skills_bundle_upload_commit, skills_install_atomic, skills_install_mirrored, skills_install_native
```

</details>

<details>
<summary>Workspace/environment/media execution (rpc/environment.rs, task-workspace, plugin media)</summary>

```text
best_of_n_select, best_of_n_start, bot_installation_mutate, bot_trigger_set_armed,
code_checkout_export, code_result_apply, code_snapshot_apply, code_snapshot_checkout_get,
code_snapshot_create, environment_build_start, environment_ports_list, github_workspace_clone,
github_workspace_commit_and_push, github_workspace_remove, managed_desktop_handoff_revoke_source,
managed_desktop_results_capture, managed_desktop_results_complete, plugin_media_add_transition,
plugin_media_apply_video_effect, plugin_media_concatenate_videos, plugin_media_export_video,
plugin_media_get_video_frame, plugin_media_read_analysis_frame, project_mutate,
provider_diagnostics_run_balance_script, provider_diagnostics_start, sandbox_snapshot_create,
sandbox_snapshot_fork, sandbox_snapshot_restore, task_workspace_apply, task_workspace_begin,
task_workspace_bundle_acquire, task_workspace_bundle_apply, task_workspace_bundle_begin,
task_workspace_bundle_handoff_retry, task_workspace_bundle_handoff_undo,
task_workspace_bundle_turn_begin, task_workspace_bundle_turn_settle,
task_workspace_changeset_capture, task_workspace_environment_adopt,
task_workspace_environment_create_branch, task_workspace_environment_delete_branch,
task_workspace_integration_prepare, task_workspace_integration_publish,
task_workspace_integration_rebuild, task_workspace_integration_rollback,
task_workspace_maintenance_run, task_workspace_managed_adopt, task_workspace_managed_archive,
task_workspace_managed_delete, task_workspace_managed_restore, task_workspace_project_source_ensure,
task_workspace_prune, task_workspace_reconcile, task_workspace_remote_source_ensure,
task_workspace_resolve_conflict, task_workspace_restore_snapshot, task_workspace_revision_apply,
task_workspace_session_scratch_ensure, task_workspace_settle, task_workspace_undo,
thread_handoff_accept, thread_handoff_commit, thread_handoff_offer, twin_ingest_source,
twin_job_resume, twin_job_retry, video_analyze, video_get_info, video_trim
```

</details>

<details>
<summary>Git subprocesses/hooks (cognia-git commands.rs and exec-backed mutations)</summary>

```text
git_blame, git_checkout_branch, git_cherry_pick, git_clone, git_clone_guarded, git_commit,
git_create_branch, git_create_tag, git_delete_branch, git_delete_tag, git_diff_staged_all,
git_discard, git_discard_all, git_fetch, git_init, git_interactive_rebase, git_merge,
git_merge_abort, git_pull, git_push, git_push_tag, git_rebase, git_remote_add, git_remote_remove,
git_rename_branch, git_reset, git_resolve_conflict, git_restore, git_revert, git_sequencer_abort,
git_sequencer_continue, git_stack_capabilities, git_stack_history, git_stack_push,
git_stack_restack, git_stack_revert, git_stack_set_parent, git_stack_validate, git_stage,
git_stash_apply, git_stash_drop, git_stash_pop, git_stash_push, git_sync, git_unstage,
git_worktree_add, git_worktree_commit, git_worktree_list, git_worktree_prune, git_worktree_remove
```

</details>

<details>
<summary>SFTP reaches/starts terminal-host (rpc/sftp.rs -> terminal/sftp_service.rs -> host_client.rs)</summary>

```text
sftp_create_dir, sftp_delete_entry, sftp_download_close, sftp_download_open,
sftp_download_read_chunk, sftp_list_dir, sftp_realpath, sftp_rename_entry, sftp_session_close,
sftp_stat, sftp_upload_abort, sftp_upload_commit, sftp_upload_open, sftp_upload_write_chunk
```

</details>

<details>
<summary>Native control/openers can restart processes, launch applications or provision executable runners (process_registry, github/runner, selection_toolbar, tray).</summary>

```text
companion_tunnel_start, control_managed_process, github_runner_create, selection_toolbar_execute,
tray_run_native_action
```

</details>

<details>
<summary>Terminal host adapter uses connect_or_spawn_terminal_host even for these requests (terminal/host_client.rs:308).</summary>

```text
terminal_list_all, terminal_list_for_project, terminal_reattach, terminal_serial_attach,
terminal_take_control
```

</details>

<details>
<summary>Registers executable-content reload or workflow triggers (plugin watcher and workflow/commands.rs).</summary>

```text
plugin_watch_start, workflow_register_trigger
```

</details>

<details>
<summary>GitHub runner commands spawn gh even for network status/preflight/cancel (cognia-github-runner/src/lib.rs:300).</summary>

```text
github_runner_cancel, github_runner_pairing, github_runner_preflight, github_runner_refresh
```

</details>

<details>
<summary>Input/continuation targets drive existing executable sessions (automation dispatcher, hook response and workflow waitpoint decision).</summary>

```text
claude_plugin_hook_response, desktop_click, desktop_drag, desktop_expand_element, desktop_hold_key,
desktop_invoke_pattern, desktop_keys, desktop_mouse_button, desktop_paste, desktop_perform_action,
desktop_scroll, desktop_type, desktop_window_op, desktop_zoom, workflow_waitpoint_decide
```

</details>

<details>
<summary>nonExecutionCommands — every exception and its one-line reason</summary>

- Read-only status, capability, metadata or file-system query; no executable workload is launched by this target.

  `a2ui_bridge_runtime_paths`, `background_job_list`, `background_job_read`, `background_monitor_list`, `browser_runtime_status`, `codex_app_runtime_status`, `dsh_runtime_facts`, `execution_run_approval_list`, `execution_run_detail`, `execution_run_events`, `execution_run_get`, `external_agent_cognia_models`, `external_agent_config_get`, `external_agent_config_list`, `external_agent_list`, `external_agent_session_query`, `fleet_codex_hooks_capabilities`, `fleet_codex_hooks_status`, `fleet_scripts_status`, `github_runner_list`, `host_runtime_status`, `is_external_agent_running`, `list_managed_processes`, `mcp_server_status`, `plugin_get_capabilities`, `plugin_list`, `plugin_permission_list`, `plugin_python_get_info`, `plugin_python_is_initialized`, `plugin_python_list`, `plugin_python_runtime_info`, `plugin_runtime_snapshot`, `scheduled_task_runs`, `session_reference_search`, `session_reference_snapshot`, `sidecar_restart_count`, `subscription_get_account_detail`, `subscription_get_account_env`, `subscription_list_provider_ids`, `task_workspace_list_runs`, `terminal_complete_paths`, `terminal_detect_multiplexer`, `terminal_host_status`, `terminal_list_path_executables`, `terminal_list_serial_ports`, `terminal_serial_status`, `transcript_capabilities`, `workflow_approval_list`, `workflow_human_input_list`, `workflow_placement_probe`, `workflow_run_list`

- Observes or waits for an existing terminal/forward; does not create or write to a process.

  `acp_terminal_get_info`, `acp_terminal_get_session_terminals`, `acp_terminal_is_running`, `acp_terminal_list`, `acp_terminal_output`, `acp_terminal_wait_for_exit`, `ssh_terminal_forward_status`

- Stops, removes or cancels existing work/artifacts; does not start execution (cleanup remains available).

  `acp_terminal_kill`, `acp_terminal_kill_session_terminals`, `acp_terminal_release`, `browser_extension_install_cancel`, `browser_local_uninstall`, `canvas_cancel_python`, `codeserver_uninstall`, `environment_task_shell_release`, `fleet_codex_hooks_uninstall`, `fleet_codex_uninstall`, `fleet_opencode_uninstall`, `fleet_scripts_uninstall`, `plugin_process_kill`, `plugin_uninstall`, `plugin_vscode_uninstall`, `scheduled_task_cancel_run`, `skills_uninstall`, `skills_uninstall_native`, `ssh_terminal_kill`, `terminal_close_serial`, `terminal_headless_kill`, `terminal_kill`

- Starts recording observations of browser/native input, not a process, agent, PTY, workflow or plugin program.

  `browser_embed_start_record`, `record_start`

- Reads the on-disk extension registry or installed browser candidates; no browser runtime is started (browser/extensions.rs, user_chrome).

  `browser_extensions_list`, `browser_user_chrome_discover`

- Starts an observation/listener/controller task, not a user process, agent, PTY, workflow or plugin code.

  `ccswitch_watch_start`, `companion_mdns_start`, `companion_server_start`, `connectors_start_server`, `desktop_pick_session_start`, `fleet_monitor_start`, `gateway_start`, `git_watch_start`, `perf_start_sampling`, `selection_toolbar_start`, `session_import_watch_start`

- Reads/writes runtime argument configuration files without starting or restarting code-server (rpc/plugins.rs).

  `codeserver_read_runtime_args`, `codeserver_write_runtime_args`

- Updates settings, flow control, dimensions or an existing process state flag; does not launch or send executable input.

  `companion_set_remote_terminal`, `plugin_set_shell_allowlist`, `set_external_agent_running`, `ssh_terminal_resize`, `terminal_detach`, `terminal_host_configure`, `terminal_host_sync_profiles`, `terminal_release_control`, `terminal_resize`, `terminal_set_flow_control`

- Updates the connector runtime ownership lease only; it does not instantiate the runtime (connectors/runtime-lease.ts).

  `connectors_runtime_lease_acquire`, `connectors_runtime_lease_release`, `connectors_runtime_lease_renew`

- Removes an inactive runtime installation directory (external-agent/dsh_runtime); no executable is launched.

  `dsh_runtime_remove`

- Stops/releases existing work; no new process or resumed execution is requested.

  `external_agent_cancel_run`, `external_agent_release_run`, `team_run_pause`, `team_run_stop`, `workflow_cancel_run`

- Focuses an existing terminal view; it does not create a PTY (desktop-write-source.ts).

  `fleet_focus_terminal`

- Reads branch parent pointers through libgit2 config; stack::parent_map does not spawn git (cognia-git/src/stack.rs:137).

  `git_stack_parents`

- Updates the Rust plugin metadata/status ledger or stops its process; executable activation uses plugin_set_enabled/launch_js/WASM/VSCode arms (plugin-runtime/lifecycle.rs).

  `plugin_disable`, `plugin_enable`, `plugin_load`, `plugin_unload`

- Persists validated installation provenance only; desktop-write-source.ts does not install or activate content.

  `plugin_install_origin_record`

- Deletes stored files; no executable installation or invocation.

  `skills_empty_trash`

- Subscription credential/account configuration or provider HTTP access; the script substring in subscription does not denote code execution.

  `subscription_authed_get`, `subscription_authed_request`, `subscription_clear_runtime`, `subscription_delete_account`, `subscription_delete_preset`, `subscription_get_account`, `subscription_get_active`, `subscription_get_preset`, `subscription_init`, `subscription_list_accounts`, `subscription_list_presets`, `subscription_reauthenticate_codex_account`, `subscription_refresh_codex_account`, `subscription_rename_account`, `subscription_replace_account_credential`, `subscription_save_account`, `subscription_save_preset`, `subscription_set_active`, `subscription_set_default_preset`, `subscription_set_preset`, `subscription_volcengine_usage`

- Deletes vector records; the run substring in truncate does not denote workload execution.

  `vector_cloud_truncate`, `vector_truncate_collection`

- Reads/persists/prunes workflow mirror state or answers an existing webhook HTTP response; execution resumes through separately gated commands (workflow/commands.rs).

  `workflow_get_webhook_url`, `workflow_persist_run_state`, `workflow_reload_in_flight_runs`, `workflow_wait_event_prune`, `workflow_webhook_respond`

</details>

Application execution is intentionally dormant on multi-tenant Hosts until it
has a sandbox binding: every `app-session` route marked `execution` returns
`503 execution_isolation_unavailable`, even with a healthy pool. Workflow runs,
chat, batches/resume, human-input resume and MCP currently enter the Host brain,
where code nodes use `new Function`; installing a pool does not isolate them.
`HostRouteClass`/`HostRoute` document this boundary and regression tests pin it.
Read-only application routes retain their session/key authentication.

| DataChannel label                      | Adapter / Host capability                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `cognia.signaling`, legacy `cognia.v2` | RPC/events/media dispatcher: `host.observe`, plus per-command RPC admission. The relay shares this gate. |
| `cognia.terminal`                      | Direct terminal adapter: `terminal.open`.                                                                |
| `cognia.rfb`                           | Direct remote desktop adapter: `host.observe`, plus existing session/control checks.                     |

There is no separate browser or events DataChannel; their RPC/events use the
main dispatcher. Unknown labels are refused. Exhaustiveness tests compare the
policy inventory to peer labels and direct callback fields, so new adapters
must be classified and wired through admission.

Raw workspace-action admissions still require the org fallback
`host.global-surfaces`; they have no Host-owned root-to-workspace resolver.
P4 container execution uses immutable Host record bindings as described below.
Standing, including denials, is cached for at most five seconds per
org/person/workspace. Revocation applies at the next admission after expiry;
running-work fencing remains in the collaboration server. Fleet and connector/
Lark ingress are not mounted in multi-tenant mode: their machine/platform auth
does not yet provide a tenant execution principal.

The complete per-path inventory is `crates/cognia-companion/src/host_routes.rs`.
New, unclassified routes fail closed in multi-tenant mode.

| Route class         | Registered surfaces                                                                                                                           | Admission boundary                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public-auth`       | Health/discovery and `/api/auth/*`                                                                                                            | Existing authentication; socket tickets also apply the Host capability gate before minting.                                                                                       |
| `ticketed-socket`   | `/ws/events`, `/ws/terminal`, `/ws/browser/{session_id}`, `/ws/acp`, `/ws/worker`, `/ws/browser-companion`, `/ws/remote-desktop/{session_id}` | Path-bound, single-use tickets; each channel's capability is classified.                                                                                                          |
| `app-session`       | `/api/portal/bootstrap`, `/api/apps/*`, `/v1/*`                                                                                               | Signed app sessions or hashed app keys with expiry, revocation, scope and app/account binding. Execution routes are dormant in multi-tenant mode regardless of pool availability. |
| `gated-by-dispatch` | Device/owner REST, RPC/A2A, service/internal routes, IDE relay/content and operator endpoints                                                 | Command admission or the same capability gate after route authentication. Loopback/operator authentication establishes service scope.                                             |

Fleet `/api/fleet/*`, connector `/connectors/*` and integration callbacks are
inventoried separately as authentication surfaces and mounted only in
single-user mode. App session validation lives in
`workflow_app_api.rs::verify_session/session_for_slug`; Dify/MCP app keys reach
`lib/workflow/apps/api-key-service.ts::authenticateWorkflowAppApiKey` through
`dify-bridge-service.ts::dispatch` and `mcp-service.ts::invokeWorkflowAppMcp`.

## P4 execution binding and remaining dormant paths

Multi-tenant `spawn_external_agent` requires an explicit `workspaceId` at
creation. The Host resolves person/org and current standing, stamps
`PlacementBinding { orgId, workspaceId, actorUserId, runId }`, and passes its
non-deserializable admission decision through dispatch. A caller-supplied
placement binding is refused with `403 placement_binding_client_supplied`.
The operator must set `COGNIA_WORKSPACE_ROOTS_DIR` to an existing Host directory
containing the allowed workspace directories. Unset, empty or invalid values
refuse multi-tenant mount registration with `403 workspace_root_unconfigured`.
The first assignment of a canonical root requires `host.global-surfaces` and
a strict descendant of that canonical base; the base itself and paths outside
it are refused with `403 workspace_mount_forbidden`. Symlinks cannot escape
the base. A directory and all of its ancestors/descendants can belong to only
one `(org, workspace)`; overlap returns `403 workspace_root_claimed`.
The claim is persisted under a Host lock before container preparation/start,
so concurrent org requests cannot both use the same directory. A failed spawn
may therefore leave its approved root assignment, without an execution record.
Assignments live in `companion/workspace-mounts.json`. Ordinary execution cannot bootstrap an
arbitrary Host path: an unassigned workspace returns `403 workspace_unresolved`,
and a cwd differing from its assigned root returns `403 workspace_mount_forbidden`.
All paths first pass the existing SpawnPolicy canonicalization. Root assignments
are immutable and cannot be reassigned by execution commands. The
current driver mounts cwd itself, so multi-tenant spawns use the assigned root
exactly; commands may work in its subdirectories inside the container.
A successful container spawn persists its generation binding under
`<Host cognia data root>/companion/execution-bindings.json`; failed spawns do
not bind existing processes. Persistence failure attempts to kill the newly
started sandbox before returning an error; cleanup failure is reported too.
Every CREATE gets a fresh Host `runId`, even when the agent id, actor and
workspace are reused. Only replay of a Host idempotency receipt returns the
original creation without another spawn. Scratch and persistent-runtime keys
include the generation. Successful kill, natural exit and terminal/unknown
status remove its binding; delayed callbacks compare the full generation and
cannot remove a replacement. A per-agent async lifecycle lock covers binding
validation, control, creation and failure cleanup, so a delayed control request
cannot operate on a replacement through the reused id. Before another creation, Host-owned backend
status reconciles records left by orphan reaping/restart. Unknown ids continue
to return `403 workspace_unresolved` even with a caller-supplied workspace.
The store is limited to 1,024 records and 2 MiB of serialized data; capacity
exhaustion refuses creation with `503 execution_binding_store_full`. Reads
also stop at the byte limit. Root assignments remain durable after run cleanup.
Later controls ignore caller workspace
fields, recheck the caller's standing, and compare the running container's
reported identity with the record. Being a different actor does not introduce
an ownership rule; the caller still needs `execution.request` in that workspace.
If current standing permits only a read-only mount, controls cannot reuse a
container whose workspace is writable; start a new run with the current policy.
This admission check does not terminate already running work; active run
fencing remains the collaboration server's responsibility.

`workspace.write` gives a writable workspace mount. `workspace.read` without
write gives a read-only Docker/PVC mount. A viewer without execution standing
is refused. Scratch is a private tmpfs at `/scratch/<identity digest>`, keyed
by org, workspace, actor and Host run id and removed with the sandbox. The
placement report exports `binding`, `scratchPath` and `workspaceReadOnly`.
Persistent runtime compatibility includes this identity and mount policy, so
another actor/task cannot reuse its scratch. A Host-process launch reached
with tenant admission is refused even if a caller bypasses normal routing.

`CredentialDelivery` is `brokered`, `injected-env`, or `none`; deserialization
accepts the legacy `gateway-lease` as `brokered`. Explicit TOKEN, PASSWORD,
SECRET or API_KEY environment names are labeled injected plaintext (the
same filter redacts process inspection). Credential delivery requires
`credential.use`, including credentials in spec/workspace environment.
Multi-tenant classification is deliberately conservative for structured
channels: `OPENCODE_CONFIG_CONTENT`, any CONFIG/JSON env channel (including
`*_CONFIG_CONTENT`/`*_CONFIG_JSON`), `COGNIA_DEVIN_MCP_SERVERS`, config/auth file
selectors such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`GOOGLE_APPLICATION_CREDENTIALS` and `AWS_SHARED_CREDENTIALS_FILE`, and
`COGNIA_GATEWAY_RUNTIME_ENV` are injected delivery whenever present.
Credential/config/settings/header/profile/env-file CLI options, JSON CLI
payloads, and lifecycle hooks that can write configuration files are treated
the same way. This avoids provider-specific parsing missing a new secret field.
The shared classifier drives admission and reports; no `credential.use` means
`403 credential_use_forbidden`, including a key nested in OpenCode config.
A process can read an injected credential. Only brokered use promises
`credential.use` without `credential.read`. The frontend report exports the
typed union and retains the legacy wire spelling for older Hosts.

Intentional dormancy (Rule 7): ordinary Host-brain workflows, sidecar sessions,
team/goal/room/task orchestration, and direct browser/ACP execution sockets do
not acquire isolation merely because a pool is installed. Execution remains
unavailable; records without Host-owned placement bindings remain unresolved.
The workflow HTTP creation route returns `503 execution_isolation_unavailable`
before its handler; reads/cancel/events still cannot resolve a bound workspace.
The main observation/events carrier remains available. Service-only task
shells have no authenticated person delegation and remain unavailable; their
caller-provided owner/workspace labels are never accepted as actor authority.
Remote providers currently have no attested read-only workspace/private scratch
mount contract and are refused before provisioning on a multi-tenant Host.
Single-user dispatch, mounts, fallback and the complete placement wire shape
retain their prior behavior: credentials still report `gateway-lease` when a
gateway task/token is present and `none` otherwise, including explicit injected
values. The new delivery classification is emitted only in multi-tenant mode.
Type docs,
wire refusal/availability labels, and focused tests pin these limitations;
localized UI presentation is owned by the separate frontend change.

The table inventories every manifest `agent.run`/`workflow.run` arm plus the
container creation/control and external run bridge arms. The registry column
names the owning dispatch boundary: brain-bridged records have no Rust-owned
placement identity to trust. No binding is fabricated for those records.

| Arm                                | Record / owning registry                                          | Binding source                                                             | Lands in a P4 sandbox?                                        | Multi-tenant result                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_close_session`              | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `agent_compact`                    | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `agent_interrupt`                  | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `agent_resolve_permission`         | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `agent_send`                       | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `agent_session_api`                | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `agent_task_cancel`                | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `agent_task_comment`               | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `agent_task_move`                  | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `agent_task_pause`                 | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `agent_task_resume`                | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `agent_task_start`                 | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_act`                      | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_back`                     | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_close_page`               | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `browser_drag`                     | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_evaluate`                 | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_forward`                  | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_handle_dialog`            | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_navigate`                 | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_new_page`                 | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_press_key`                | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_reload`                   | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_scroll`                   | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_profile_delete`           | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `browser_session_close`            | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `browser_session_ensure`           | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_set_files`                | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_set_zoom`                 | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `browser_stop`                     | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `browser_switch_page`              | BrowserGateway.sessions (browser_gateway.rs)                      | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_approve`                   | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_call_reserve_respond`      | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_close_session`             | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `claude_compact`                   | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_interrupt`                 | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `claude_plugin_tool_response`      | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_protocol_adapter_message`  | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_restart_sidecar`           | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_restore`                   | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_send`                      | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_session_control`           | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_set_mode`                  | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `claude_sidecar_status`            | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `claude_tool_result_decision`      | Host sidecar session (rpc/chat.rs)                                | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `codex_app_task_create`            | Host Codex app-server thread (rpc/codex_app.rs)                   | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `codex_app_task_interrupt`         | Host Codex app-server thread (rpc/codex_app.rs)                   | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `codex_app_task_send`              | Host Codex app-server thread (rpc/codex_app.rs)                   | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `connectors_runtime_lease_acquire` | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `connectors_runtime_lease_release` | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `connectors_runtime_lease_renew`   | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `execution_run_control`            | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `execution_run_create`             | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `execution_run_detail`             | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `execution_run_events`             | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `execution_run_get`                | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `execution_run_resume`             | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `external_agent_admit_run`         | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `external_agent_cancel_run`        | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `external_agent_release_run`       | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `external_agent_resolve_decision`  | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `external_agent_run_turn`          | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `get_external_agent_status`        | External process; Host execution ledger                           | agent_id / agentId lookup; current runtime placement must match            | Existing bound container                                      | Current caller standing required; terminal/unknown runtime removes its generation and returns 403 workspace_unresolved                      |
| `goal_accept`                      | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `goal_create`                      | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `goal_continue`                    | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `goal_delete`                      | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `goal_pause`                       | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `goal_resume`                      | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `goal_status`                      | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `goal_stop`                        | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `goal_subgoal_mark`                | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `goal_subgoals_clear`              | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `goal_subgoals_generate`           | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `goal_update`                      | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `goal_verification_options`        | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `goal_verify_retry`                | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `kill_external_agent`              | External process; Host execution ledger                           | agent_id / agentId lookup; current runtime placement must match            | Existing bound container                                      | Current caller standing required; successful kill removes its exact generation; legacy/unbound record: 403 workspace_unresolved             |
| `langfuse_trace_ingest`            | Service-plane trace ingestion (rpc/service_plane.rs)              | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `execution_run_approval_list`      | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `execution_run_approval_respond`   | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `send_to_external_agent`           | External process; Host execution ledger                           | agent_id / agentId lookup; current runtime placement must match            | Existing bound container                                      | Admitted by current caller standing; legacy/unbound record: 403 workspace_unresolved                                                        |
| `spawn_external_agent`             | External process; Host execution ledger                           | Explicit workspaceId; authenticated person; fresh Host run UUID per CREATE | Local Container placement only                                | execution.request + workspace.read/write; credential.use for credential/config channels; exclusive root under operator base; bounded ledger |
| `team_run_start`                   | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `team_run_pause`                   | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `team_run_resume`                  | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `team_run_stop`                    | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `team_task_comment`                | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `team_task_create`                 | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `team_task_move`                   | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `workflow_approval_list`           | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `workflow_approval_respond`        | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `workflow_cancel_run`              | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `workflow_create`                  | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `workflow_delete`                  | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `workflow_handoff_create`          | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `workflow_human_input_list`        | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `workflow_human_input_submit`      | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `workflow_placement_probe`         | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `workflow_run_list`                | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `workflow_schedule_pause`          | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `workflow_schedule_resume`         | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `workflow_step_result`             | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `bot_delivery_replay`              | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `bot_run_manual`                   | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `workflow_trigger_manual`          | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `workflow_update`                  | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `room_send`                        | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 503 execution_isolation_unavailable                                                                                                |
| `room_stop`                        | Host brain record via rpc/data_sync.rs                            | No persisted P4 placement identity; later workspaceId ignored              | No P4-bound sandbox dispatch                                  | Refused: 403 workspace_unresolved                                                                                                           |
| `environment_task_shell_exec`      | Task-shell runtime; owner is a caller label, not tenant authority | No person-bearing service delegation; workspaceId alone is insufficient    | Local runtime exists; service principal has no admitted actor | Refused: 503 execution_isolation_unavailable                                                                                                |

## Multi-tenant person data (P5)

On a multi-tenant `cognia-server`, Host data commands use one lazy brain per
OIDC-bound person with current non-guest organization standing. No workspace
or request argument selects the partition. Its account id is `pb_` followed by
the first 24 lowercase hex digits of SHA-256(`org_id` NUL `user_id`). Data lives
under `<data_dir>/persons/<account_id>/`; each account has its own random
256-bit content key in the encrypted server secret store. Departed members
lose admission, while their data and key remain until an operator purges them.

Set these environment variables on the `cognia-server` container (for example,
with a local Compose override's `environment` map):

| Variable                        | Default | Meaning                                                                            |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `COGNIA_PERSON_BRAIN_IDLE_SECS` | `900`   | Stop a person brain after this many idle seconds.                                  |
| `COGNIA_PERSON_BRAINS_MAX`      | `8`     | Maximum active person supervisors; evict the least recently used idle brain first. |

Both values must be positive integers; invalid configuration leaves the fleet
uninstalled and Host data refused. In-flight requests prevent eviction and
purge. If every slot is busy, another person receives retryable
`503 person_brain_capacity`; if hello does not arrive within the brain ready
timeout, the request receives retryable `503 person_brain_unavailable`.
Reserve memory for the operator brain, sidecar and Rust Host in addition to
person brains. Size the cap from measured idle/peak RSS of the built person
profile and the container memory limit; `8` is the rollout default, not an RSS
measurement. `/healthz` reports hashed account ids, running/ready/parked state,
restart count, last use, in-flight requests and RSS. `/metrics` exposes fleet
count and per-account running, ready, in-flight and RSS gauges; neither exposes
organization or user ids.

The following commands contact the running Host over authenticated loopback
HTTPS (`--port` under `persons`, or `COGNIA_PORT`, selects the port):

```bash
cognia-server persons list
cognia-server persons --port 27890 purge --org org_example --user usr_example
```

`list` includes current standing when the collaboration authority can resolve
it. `purge` refuses with retryable `503 person_brain_busy` while a request is in
flight. It stops and joins the child, destroys the content key, deletes the
partition root and writes an audit record. Repeating purge is safe. Rejoining
and using the Host afterwards creates an empty partition and a fresh key.

Intentional dormancy and per-arm routing:

- `pet_chat_send` and `pet_soul_generate`: `503 model_access_unavailable` until
  the P6 credential broker supplies person-scoped providers.
- Message/session/transcript arms: storage and history only. Replies require
  agent runs, which remain `execution_isolation_unavailable` on the Host brain.
- `host_state_status`, `host_state_snapshot`, `host_state_submit` and
  `host_feature_manifest`: routed to the person's brain. Reads require
  `client.read`, submit requires `client.write`; the owner's data-only intents
  need no Host admin lease. `session_attach` / `session_detach` also route to
  the person's brain with `client.read`. A control attachment advertises exactly
  the accepted data intents in `supportedActions`; an observer gets none.
  `message.enqueue`, `turn.steer`, `turn.followup`, `turn.abort`,
  `approval.respond` and `elicitation.respond` are refused per action with
  `execution_isolation_unavailable`; `session.workspace` with
  `workspace_unavailable`. A mixed batch still applies its allowed data intents.
  Session seeds drop `projectId` and keep only a partition-owned `characterId`.
  The feature manifest reports this partition's scope and unavailable execution.
- Files, characters, issues, pet storage, glance and twin profile data: only
  the caller's person brain, with no operator/WebView/AppStore fallback.
- `register_push_token` / `revoke_push_token`: registry namespace is the person
  account plus device; push delivery uses that person's tokens only.
- `sync_list_tables`: static sync table registry; `sync_pull`: the person's
  account id and bridge, never the operator's account namespace.
- The eight Host-global `commandOverrides` retain `host.global-surfaces` and
  the operator brain. Desktop Hosts and servers without an installed fleet
  retain `host_data_unpartitioned`. Single-user routing and wire formats stay
  unchanged.

Person children receive `COGNIA_BRAIN_PROFILE=person`, `COGNIA_DATA_DIR`,
`COGNIA_LOCAL_ACCOUNT_ID`, `COGNIA_ACCOUNT_CONTENT_KEY` and an account-bound
`person-brain` JWT in `COGNIA_SERVICE_TOKEN`. Each child start has a fresh random,
in-memory authentication generation; refreshes keep it, and exit/idle stop,
eviction, purge and server shutdown invalidate it. It is independent of the
persisted encryption key. That JWT can open only its own
`/internal/bridge` slot. The profile must not connect to `/internal/events`,
`/internal/catalog` or `/internal/_rpc`; its sync replies and event publishing
use bridge `respond` frames. Only sync invalidations and transcript revisions
may be published by a person brain. Live and replayed frames are checked against
the receiving device's current person binding; routing metadata is not serialized.

Idempotent person-data receipts are scoped to the account and a separate random
data generation stored in encrypted partition metadata. That generation survives
child and server restarts. Purge deletes every generation of the account's
receipts and operation documents, then destroys the key and metadata; rejoining
creates a new data generation. Operation reads check the device's current verified
person and organization standing before reading a partitioned receipt. Legacy
single-user and non-partitioned receipt keys, storage schema and wire stay unchanged.
