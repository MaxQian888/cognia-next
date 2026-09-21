# Container preparation and lifecycle optimization

Date: 2026-09-21. Scope: Cognia's existing Docker runtime-environment path and
shared container execution backend. Reference checkout:
`8125ce1d7d8d57a027c522de81480dddf37d428d`, with pre-existing shared-tree edits
preserved. Markone's `runner-prepare-acceleration.md` and
`run-container-scheduling.md` supplied design comparisons, not implementation
instructions for Cognia.

## Initial strategy assessment

| Reference strategy                                        | Benefit                                                | Constraint in Cognia                                                                                           | Decision                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Separate admission, execution ownership and runtime state | Avoid duplicate starts and incorrect state transitions | Cognia currently creates one Docker container per agent; its persistent Kubernetes environment pool is planned | Reserve agent identity before preparation, retain existing per-spawn admission and runtime event authority |
| Bound simultaneous dispatch                               | Protect the daemon during bursts                       | A preparation limit is not a tenant quota or a cap on running containers                                       | Four preparation slots, cancellable waiting, existing per-container resource limits retained               |
| Warm containers and retained disks                        | Remove expensive creation and restore work             | Reusing an agent container would change workspace, credential and lifecycle isolation                          | Reuse existing immutable bundle volumes and compatible probe results; no cross-agent container reuse       |
| Parallel preparation                                      | Shorten the critical path                              | Probe depends on staged core; libc staging depends on probe; agent startup depends on both                     | Coalesce duplicate cold probes and missing-image pulls; keep required dependency order                     |
| Background initialization                                 | Earlier nominal readiness                              | Starting before required environment work finishes can make readiness misleading                               | Keep all existing required preparation; do not bypass admission, probe or staging                          |
| Layered caches and failover                               | Reduce repeated downloads and handle capacity failures | Negative cache entries, user/owner changes, stale versions and removed volumes need explicit handling          | Recheck compatible cache entries after waiting, invalidate swept volumes, reject incompatible reports      |
| Retry container creation                                  | Recover transient failures                             | A lost successful response is ambiguous; replay may create duplicate resources                                 | Retry only explicit image-missing responses, reconcile ambiguous creation using attempt ownership          |
| Cache environment decisions                               | Reduce catalog/registry overhead                       | Approval revocation and registry credential rotation must take effect                                          | Keep fresh admission; reload configured pull credentials, bound DNS and HTTP under one deadline            |

TOS/NAS, EBS, AirBuild and PPE-specific policies are not Cognia infrastructure.
Copying their configuration switches or reproducing their two distributed queues
would create new architecture without demonstrating a bottleneck in the shipped
Docker path. The changes extend existing modules and preserve current refusals
for unsupported environment features.

The table records the initial preparation pass. The subsequently authorized
Dockerfile/Features, retained Docker runtimes and port relays are described in
the expanded implementation below; they supersede the initial no-reuse scope.

## Verified problems and implementation boundaries

- Cold spawns could all miss the same probe cache before any report was stored.
  Per-image/bundle coordination now rechecks the cache while preserving target
  user and workspace-owner compatibility.
- A successfully swept bundle remained in the process's staged set. A later
  request could report a cache hit for a volume that no longer existed.
- Agent identity was checked before asynchronous creation but recorded only
  afterward. Pending ownership now covers preparation, cancellation and
  adoption, including routing between legacy and environment backends.
- Docker attach/start failures could leave an unadopted container behind.
  Creation handoff and cleanup must also cover cancelled futures and distinguish
  old attempts from retries with the same logical agent id.
- Helper cancellation could abandon staging/probe containers. Cleanup owns
  the helper through removal; coordination leases must remain valid through
  abandoned work rather than merely through the caller's future.
- A probe's JSON could describe success despite an unsuccessful process exit.
  Such a result is refused and is not cached as a successful probe.
- A probe cache entry's embedded report version was not checked. Both stored
  entries and direct compatibility checks now reject unsupported versions.
- Pool boot captured registry credentials permanently, while image inspection
  already supported rotation. Pull credential lookup now uses live configured
  files, rejects unreadable/malformed configuration and redacts parse errors.
- Registry request timeout excluded the preceding DNS lookup. One deadline now
  covers DNS validation, connection and response reading, without weakening
  address checks, proxy policy, redirect handling or response size limits.

## Controlled performance experiment

This is an orchestration benchmark using the existing fake daemon, **not** a
production Docker startup measurement. It runs the actual
`DockerSandboxBackend::spawn_sandboxed` path through admission, staging, probe,
creation and adoption for eight agents with one image and bundle. A fake-daemon
gate accepts one create every 2 ms, modelling a constrained create service.
No model request, image download or real filesystem copy is represented.

Contract fixed before optimization: same host, debug test binary, eight cold
agents, new backend and cache for each batch, one warmup, ten measured samples;
compare median and median absolute deviation (MAD). Require at least a 5%
improvement and a median delta greater than twice the larger MAD. Correctness,
cache compatibility, cancellation and cleanup remain hard requirements.

First-pass comparison (follow-up measurements are recorded below):

| Measure                     |     Before |     After |
| --------------------------- | ---------: | --------: |
| Median batch readiness      | 68.1395 ms | 40.899 ms |
| MAD                         |   1.370 ms |  0.852 ms |
| Helper containers per batch |         11 |         4 |
| Agent containers per batch  |          8 |         8 |

The final median reduction is 39.98%. The 27.2405 ms median delta exceeds twice
the larger MAD (2.740 ms). The removed work is seven duplicate probes; all eight
agents and the required three bundle installs and one probe remain. Preparation
limits and pull/probe coalescing apply to the sandbox-pool path; the legacy
container backend receives lifecycle correctness fixes, not these performance
policies.

Reproduce the controlled measurement:

```sh
rtk proxy cargo test -p cognia-sandbox-pool --lib benchmark_cold_batch -- --ignored --nocapture
```

Raw final evidence is in
`/tmp/cognia-container-optimization-20260921/{baseline,final-benchmark}.txt` and
`final-comparison.json` on the task host. These temporary artifacts are local evidence,
not committed benchmark infrastructure. The ignored benchmark is intentionally
not a wall-clock CI gate; the ordinary regression asserts helper counts.

## Validation record

First-pass checks (follow-up checks are recorded below):

```sh
rtk proxy cargo test -p cognia-external-agent -p cognia-sandbox-pool -p cognia-environment --no-default-features --features cognia-sandbox-pool/docker,cognia-environment/registry,cognia-environment/store --lib
rtk proxy cargo clippy -p cognia-external-agent -p cognia-sandbox-pool -p cognia-environment --no-default-features --features cognia-sandbox-pool/docker,cognia-environment/registry,cognia-environment/store --all-targets -- -D warnings
rtk env DOCKER_HOST=unix:///Users/bytedance/.colima/cognia-e2e/docker.sock COGNIA_TEST_DOCKER=1 COGNIA_RUNNER_IMAGE=lycoris-perf:rust-1.85.0 cargo test -p cognia-external-agent --no-default-features --features container-exec container_backend::docker_integration::failed_and_cancelled_creation_leave_no_daemon_containers -- --exact --nocapture
```

- Combined Rust tests: 372 passed (environment 124, external-agent 203,
  sandbox-pool 45); one benchmark ignored in the ordinary run and passed when
  explicitly run above. Environment-gated Docker tests in the ordinary run do
  not constitute live acceptance.
- Clippy: passed with warnings denied.
- Explicit live Docker test: one passed, covering startup failure, cancellation
  after creation, and ordinary adoption/exit cleanup.
- Scoped Rust formatting and diff whitespace checks: passed.

Raw output is stored alongside benchmark evidence in `rust-tests.txt`,
`clippy.txt`, and `docker-live.txt`. These checks do not establish deployed
Headless, Tauri UI, Kubernetes, gVisor or complete agent-bundle acceptance.
Daemon cleanup errors are logged and retain orphan reconciliation as a fallback;
successful removal cannot be guaranteed while the daemon is unavailable.

Repository-wide checks executed during this task:

- `pnpm typecheck`: failed with a V8 heap exhaustion (exit 134); the RTK compact
  output incorrectly said no errors, so the raw fatal log is the authority.
- `pnpm lint`: failed with 666 errors and 7,814 warnings across the shared tree;
  this task edits Rust and documentation, not those JavaScript/TypeScript paths.
- `pnpm lint:i18n`: passed, including referenced-key checks and locale parity.
- `pnpm i18n:sort:check`: passed.
- Coverage was stopped and skipped at the user's explicit request. No coverage
  percentage or passing global coverage gate is claimed.

The existing `cognia-e2e` Colima profile was started for live checks. Its local
`node:22-alpine` tag is not a usable shell image (`/bin/sh` is absent); the existing
`lycoris-perf:rust-1.85.0` image successfully ran a network-disabled shell smoke.
Checks used an explicit context/socket and only removed their own containers.
The daemon had no remaining containers after the final test. The test profile
was stopped afterward and the original `colima` Docker context restored.

## Follow-up lifecycle hardening

A second review found gaps at the boundaries between preparation, cleanup and
identity reuse. Deterministic gates reproduced premature volume retirement,
premature reuse of an exiting runner's id, and an opposite-backend retry while
a cancelled child still owned that id.

- Preparation holds a process-local shared bundle lease across the gaps between
  Docker mounts, including abandoned creation and cleanup. Retirement takes a
  nonblocking exclusive lease, skips active bundles and can still remove
  unrelated retired bundles. Docker's own volume references continue to protect
  adopted running containers.
- An owned sweep worker retains its exclusive lease if the caller is cancelled.
  A re-offered bundle waits for an already-submitted deletion to settle. The
  staged cache is invalidated before submission: a failed response does not
  establish that deletion failed, so a subsequent spawn must safely restage.
- A normally exited runner keeps its id through exit-event delivery and daemon
  deletion. A failed deletion retains a stopped entry that `kill` or `kill_all`
  can clean up again; an overlapping kill cannot release the id while the old
  exit callback is still executing.
- Routing checks both child registries before reusing an id. A cancelled child
  that never published a successful owner remains discoverable for status and
  cleanup through the router.
- Instance identifiers include a monotonic process-local sequence, because
  consecutive clock reads were observed to collide during the focused tests.
- A failed ownership check or kill request restores the runner's previous state
  only when the same container is still marked `Stopping`; a concurrent exit or
  other state change is not overwritten.

These are correctness and recoverability changes, with the earlier controlled
benchmark used as a performance guard rather than a new acceleration claim.
The shared leases permit concurrent preparation of the same bundle. A slow
in-progress deletion can still occupy preparation slots through waiting spawns;
this pass does not introduce a second scheduler or claim fairness across bundles.
Coordination is local to a driver instance, not a distributed lease across Hosts.

The final ten-sample guard run, after the test VM stopped, measured a median of
40.072 ms with MAD 1.3885 ms and four helpers in every eight-agent batch.
Compared with the first-pass 40.899 ms, the 0.827 ms difference is below both the
5% practical threshold and twice the larger MAD. There is **no additional speedup
claim** for this correctness pass; the original reduction from 11 helpers to
four remains intact. An earlier follow-up sample taken during VM startup is
retained in the local ledger but is not the final comparison.

The final combined command above passed **383 tests** (environment 124,
external-agent 211, sandbox-pool 48), with the benchmark ignored in the ordinary
run and explicitly passing separately. Strict Clippy, scoped Rust formatting and
diff checks passed. The explicit live Docker lifecycle test passed again, and
the daemon had no remaining test containers. The `cognia-e2e` VM was stopped and
the `colima` context restored. Coverage remains skipped at the user's request;
the earlier global TypeScript/Lint failures are not claimed resolved or rerun
for these Rust-only changes.

Follow-up raw evidence is under
`/tmp/cognia-container-followup-20260921/`: `rust-tests.txt`, `clippy.txt`,
`docker-live.txt`, `final-benchmark.txt`, and `final-comparison.json`.
The live check does not exercise complete agent-bundle installation or full
Host/UI acceptance. Docker kill's existing treatment of HTTP 404/409 during a
natural-exit race is unchanged; this pass restores state after errors but does
not redefine those responses as successful kills.

## Expanded implementation: build, environment, plugins and retained runtimes

The expanded request adds concrete runtime capabilities to the existing
admission, installer, Docker backend and settings surfaces. It does not copy
Markone's distributed scheduler or claim that a retained workspace is a clean
cross-project worker. Compatibility includes the approved spec, image identity,
workspace mount and effective runtime resource/security settings.

### Build and approval

`crates/cognia-sandbox-pool/src/build.rs` runs the official Dev Container CLI
through an operator-configured absolute executable (`COGNIA_DEVCONTAINER_CLI`)
and exact version (`COGNIA_DEVCONTAINER_CLI_VERSION`). The service snapshots the
requested committed Git tree, including committed submodules, and checks the
actual declaration bytes before running Dockerfile and Feature builds. Build
status, cancellation and successful records use the existing environment RPC
and SQLite authority. Duplicate in-flight inputs coalesce; a completed build
with mutable base/Feature references is not treated as an immutable cache hit.

Registry images retain the existing wire shape. A built image instead carries
`{kind:"build", buildKey, imageId}`; it is admitted only against the Host's
successful build record and exact local Docker image identity. An image's
configuration digest is never misrepresented as a registry manifest digest.
The build output's inherited Dev Container metadata is resolved before approval,
so Feature environment, user and lifecycle contributions cannot be silently
omitted from the environment that runs. Host-side initialization commands do
not execute through the build service.

### Environment and lifecycle

Container environment, remote environment and per-agent credentials remain
separate layers. Remote `${containerEnv:NAME}` expressions resolve from the
container snapshot; `null` removes the named variable, and spawn credentials
are applied only to that agent. Ambient provider credentials and supervisor
configuration variables are stripped from the agent's environment.

Workspace folders under the mounted workspace and bounded lifecycle timeouts
reach the supervisor. Shell, argv, parallel and ordered sequence commands retain
nested execution barriers, failure propagation, cancellation, process-group
cleanup and a phase deadline. Setup output goes to stderr, preserving agent
protocol stdout. UID, GID and supplementary groups are applied before project
commands execute.

### Persistent Docker runtime and ports

`docker/persistent.rs` discovers compatible retained containers from ownership
labels after a Host restart, starts stopped containers, and verifies supervisor
readiness against the expected runtime key. Creation phases run once per
successful creation marker, `postStart` runs on each container boot, and
`postAttach` runs per agent. Unique exec sessions have independent credentials,
stdio and exit status. Ending one agent does not delete the shared rootfs or
kill another agent. Idle supervisors exit after five minutes with no active
agents or port connections; Docker retains their rootfs for restart.

The supervisor provides declared-port byte tunnels. The Docker driver bounds
concurrent streams and buffers, preserves TCP half-close, and rechecks admission
while a stream is open. The Host proxy adds device and workspace authorization,
streams HTTP and upgrades, preserves encoded URLs and application credentials,
and never forwards its own device token to the application. Native previews
use separate loopback relays per port, with paired-host certificate pinning and
independent token refresh, or direct local runtime authority on the owner Host.
No Docker port is published on a public interface.

Retention intentionally preserves project data. It is not a cross-project warm
pool, a distributed lease, or a claim of automatic deletion of old configuration
rootfs. Existing deployment isolation tiers and capability refusals remain
visible; these changes do not add Kubernetes or gVisor infrastructure.

### Plugin installation transactions

URL and local ZIP confirmation first inspect the real package without installing
it; confirmation binds to the inspected digest and verified signer. GitHub,
URL and file installs use the same staged commit/register/finalize transaction.
A failed registration restores the previous package and associated state instead
of leaving a half-installed update. Filesystem rollback is guarded by the exact
transaction ownership token; durable recovery handles interrupted finalization.
Permission grants are applied only after the confirmed package is registered.

### Expanded verification boundaries

Coverage remains explicitly skipped. The expanded changes include frontend and
native code, so the earlier Rust-only scope and global lint discussion are
historical. Focused checks and live fixture results are recorded below; a shell
fixture in Docker is not full bundled-agent, paired-device UI, or production
performance acceptance. Historical `/tmp` evidence paths above are ephemeral
and may no longer exist after external cleanup.

### Operator setup and capability boundaries

Use a Host built with `container-exec` and enable the existing sandbox-pool
baseline with a compatible bundle and Docker daemon. Driver enablement remains
explicit; the default desktop feature set is not changed.
Build support additionally requires an installed official Dev Container CLI;
this task exercised version `0.89.0`. Set `COGNIA_DEVCONTAINER_CLI` to its absolute
executable path and `COGNIA_DEVCONTAINER_CLI_VERSION=0.89.0`. The Host checks the
actual executable version. `COGNIA_DOCKER_CLI` optionally selects Docker's CLI;
its daemon endpoint follows the process environment, as does the existing driver.
No global tool installation or daemon configuration change is implied by these
repository changes.

`COGNIA_ENVIRONMENT_BUILD_CONCURRENCY` defaults to 2 (1–16), and
`COGNIA_ENVIRONMENT_BUILD_TIMEOUT_SECS` defaults to 1800 (1–7200). Queues, command
output and committed snapshot extraction are bounded. Builds presently disable
Docker layer cache to force refresh of mutable bases and Feature references;
coalescing saves duplicate concurrent work, but this is not a claim of fastest
warm rebuilds. The user must commit the requested declaration and initialize
referenced submodules so the approved build input is reproducible.

The settings panel exposes build status/cancellation, effective runtime metadata,
approval and available ports. Host-level `initializeCommand`, privileged mode,
capability/security-option overrides, arbitrary mounts/run arguments, Compose,
GPU requests and Feature entrypoints are explicitly refused by this environment
adapter. Supported Features run through the official CLI; refusing incompatible
host capabilities is not silently discarding their behavior. Existing ignored
editor-oriented fields are shown in the approval panel. Port preview currently
uses the native desktop relay; browser-only clients show that limitation rather
than a credential-bearing or non-working navigation URL.

### Final review corrections

The persistent compatibility key includes the injected bundle volumes and every
container-level runtime bound. Per-agent credentials, command arguments and
ownership bookkeeping are excluded. Registry mutations use a distinct adoption
generation, so delayed cleanup cannot remove a replacement agent that shares the
same persistent Docker container. The race was reproduced before the fix and
covered by a delayed-cleanup regression afterward.

Port reauthorization reads current policy without rewriting the execution ledger.
The runtime owns spec/port revocation; the Host separately checks device and
workspace authority, avoiding duplicate Docker/SQLite work every two seconds.
Port inactivity is bounded, but active streams have no fixed one-hour lifetime.
The desktop relay waits for upstream WebSocket negotiation before accepting the
browser protocol, preserves application headers/cookies, and leaves SSE response
bodies streaming. Fixed loopback Host/Origin checks prevent rebinding and
cross-origin WebSocket access. An actual pinned-TLS test also caught and fixed
the pre-existing reqwest concrete TLS configuration mismatch.

### Expanded validation results

- Frontend: 16 focused suites, **472 tests passed**; per-file semantic TypeScript
  diagnostics, scoped ESLint, `i18n:build`, `i18n:build:check` and `lint:i18n`
  passed. These are scoped checks, not a claim that the earlier global heap/lint
  failures were resolved.
- Environment, external-agent and sandbox-pool: **418 tests passed, 2 ignored**
  (128 + 217 + 73), with strict all-target Clippy passing. The initial parallel
  run hit an existing Devin overlay cleanup timeout; that test passed alone and
  the complete run passed with four test threads, without changing its source.
- Supervisor: **84 tests passed**, including real subprocess lifecycle ordering,
  failure/cancellation, supplementary groups, blocked-stdin disconnect cleanup,
  concurrent agents, port half-close and idle retention. Strict Clippy passed.
- Native relay: **16 actual-source tests passed** using `relay.rs` and `tls.rs`,
  including a real loopback pinned-TLS server, incremental SSE, upstream-selected
  WebSocket subprotocol, binary echo, cookies and cross-origin denial. This
  isolated harness does not replace running the full desktop application.
- Host HTTP proxy: **5 actual-source harness tests passed**, including binary
  HTTP bodies, upgrades, encoded URLs and separate application credentials for
  local and remote previews. Host authentication fixtures are stubbed there;
  it is not a live paired-device authorization acceptance test.
- Linux Docker supervisor acceptance: a statically cross-compiled aarch64 musl
  supervisor ran as PID1 in the existing local glibc image. Two concurrent exec
  agents retained distinct output and exit statuses; environment interpolation,
  once-only creation, restart/postStart, per-agent postAttach, idempotent cleanup,
  nested Sequence/Parallel barriers, 256 KiB binary port half-close and undeclared
  port refusal all passed. The agent program was a shell fixture, not the full
  distributed Cognia agent bundle.

The Tauri Host source check uses `--no-default-features --features container-exec`
and temporary `TAURI_CONFIG={"bundle":{"resources":[],"externalBin":[]}}` to
skip recursive packaging-resource copies. Repository packaging configuration is
unchanged. This verifies integrated Rust source, not distributable assets, OCR,
full Tauri packaging or visual UI behavior. Two existing SandboxPolicy call sites
were updated to pass the shared default process limit required by the current
policy type, so the integrated source check could compile.

Remote preview authentication uses a fresh ES256 DPoP proof for each HTTP or
WebSocket request, bound to the current access-token nonce, method and exact
upstream path. Native state retains the signing credential only for the relay's
lifetime; token refresh replaces the token/key pair atomically. The existing
Host DPoP verification and replay checks remain in place. The application's
Origin is carried separately and restored only after Host authentication, so it
cannot be mistaken for the origin of the paired native client.

Build execution uses two official CLI stages: the base Dockerfile/image is built
without project runtime metadata, its raw inherited metadata is checked, and
Features are then applied to that immutable base with the original project
runtime fields exactly once. The official Feature lockfile controls installation.
A per-job Docker delegate checks the CLI-generated Feature Dockerfile before
submission, covering the actual frozen Feature selection rather than a separately
resolved mutable preview. Both `env` and `localEnv` host substitutions are refused;
bounded machine-readable output overflow fails explicitly instead of truncating
Git submodule or image metadata. Diagnostic values from retained transport
configuration are redacted. This validation does not replace the official
Feature resolver or installer.

Device token refresh polls within the existing token cache's renewal window,
coalesces simultaneous requests for the same pairing, and skips native IPC when
credentials are unchanged. A cached five-minute token and one failed renewal are
covered by fake-clock tests: both IDE and port relays renew before expiry.

New supervisor capabilities require rebuilding the configured agent bundle from
this implementation. Pointing a Host at an older immutable bundle does not update
that bundle's binary. No existing deployment or published bundle was changed by
this source task.

An additional real Docker crash test found that killing the Host-side `docker
exec` client does not necessarily kill the in-container exec process: its Unix
socket can stay open and keep an agent alive. Persistent agents now carry a
60-second supervisor lease renewed every 20 seconds by the Host-owned session
handle. Cleanup/drop stops renewal. Expiry closes both socket halves and reaps
the process tree, including an agent blocked on stdin or still in a lifecycle
hook. The Linux Docker regression passed after the fix: explicit renewal
extended the deadline; abrupt client loss then produced zero active sessions
and connections, with both agent and descendant gone. Direct standalone CLI
callers retain the existing unleased mode unless they request a lease.

The final integrated Host source check passed in 24.44 seconds with the feature
and packaging overrides above, after removing CLI-only temporary config paths
and attempt image tags from persisted runtime metadata. A real-store regression
checks that rebuilding the same immutable result preserves its build record.
The official Dev Container CLI `0.89.0` live
fixture also passed after the two-stage change: Dockerfile and Feature markers,
Feature-to-project lifecycle order and project environment override were checked.
Negative live builds rejected host substitutions inherited from both a base
image and a Feature; a synthetic proxy credential did not appear in diagnostics.
The fixture used an ephemeral loopback OCI registry serving an existing local
image, without changing daemon configuration. Public registry TLS failed in this
environment, so public-network Feature retrieval is not claimed verified.

All task-created Docker containers and image references were removed; only the
two pre-existing test-daemon images remained. The scoped `cognia-e2e` Colima
profile was stopped, and the original `colima` Docker context was retained.
Coverage collection was skipped as requested. Test evidence is in
`/tmp/cognia-container-expansion-20260921/build-live-final.txt`,
`build-live-hostile-base.txt`, `build-live-hostile-feature.txt`, and
`host-check-final-auth-leases.txt`. Frontend evidence is in
`/tmp/cognia-build-frontend-20260921/jest-after-relay-fixes.txt`; supervisor/native
relay evidence is in `/tmp/cognia-relay-harness-20260921/`. These remain temporary
local artifacts; the in-repository tests are the durable regression coverage.
