# Sandbox egress enforcement (S3, S4, S5)

Date: 2026-10-17. Follows `2026-10-16-agent-sandbox-workspace-gap-analysis.md`.
Design reviews: two read-only Codex passes (S4, S5) against `dev` at `966a71933e`.

One rule runs through all three: the host filtering proxy in
`crates/cognia-exec-sandbox/src/net_proxy.rs` is the only egress path for an
allowlisted process, it reuses the matcher in `crates/cognia-net/src/egress.rs`,
and every setup failure refuses the run. Nothing falls back to shared host
networking, and `enforced: true` is reported only after the bridge handshake
succeeded for that run.

## A1. Shared proxy hardening (prerequisite)

- One handler, generic over the stream, served from TCP, a Unix socket, or a
  single already-accepted stream (the Docker exec bridge).
- A JoinSet owns every connection task; `shutdown()` closes open tunnels.
  Bounded concurrency, header size, header/DNS/dial timeouts.
- Read-ahead bytes after the CONNECT header are forwarded into the tunnel.
- Absolute-form HTTP is supported per request: authority and `Host` are both
  validated, hop-by-hop headers stripped, one origin per upstream connection.
- Through a host upstream proxy the tunnel targets the already-checked IP, so a
  second resolution cannot rebind. An upstream that refuses IP CONNECT fails
  the request.
- Supported: CONNECT and absolute-form HTTP. Not supported: SOCKS, raw TCP,
  UDP, direct DNS. The proxy does not inspect TLS SNI inside a tunnel; domain
  fronting through an allowed CDN is outside the guarantee.

## S5. Linux: network namespace + Unix-socket bridge

- `LinuxSandboxBackend::run` builds the bridge itself; the dispatcher's
  downgrade of Allowlist to Off is removed, and a direct backend call can no
  longer reach `--share-net` with an allowlist.
- bwrap runs with `--unshare-net`. The proxy listens on a per-run Unix socket
  (0600, in a 0700 private dir) bind-mounted at `/run/cognia-egress/proxy.sock`
  with a separate `control.sock` for the lifecycle handshake.
- Inside the namespace the existing `cognia-external-agent-launcher` runs in a
  new internal `--linux-netns-bridge` supervisor mode (no new executable): it
  checks loopback is up, binds `127.0.0.1:0`, probes the proxy end to end,
  sends a versioned Ready, waits for Go, then spawns the target with
  `HTTP(S)_PROXY`/`ALL_PROXY` (both cases) pointing at its relay and `NO_PROXY`
  cleared.
- Two seccomp layers: the supervisor may use AF_UNIX and AF_INET; the target
  additionally loses `socket(AF_UNIX)` and other non-IP families, so mounted
  host sockets cannot become a side channel. Documented limitation: tools that
  need pathname Unix IPC do not work under an allowlist.
- The supervisor is the namespace init (`--as-pid-1` where available), forwards
  SIGTERM/SIGINT/SIGHUP to the target group, reaps, and tears down relays on
  exit. Host death is covered by `--die-with-parent`.
- Capability reporting gains a separate network probe and a per-run network
  report (`requested`, `effective`, `mechanism`). `MicrovmConfinement.networkEnforced`
  keeps meaning "no egress at all".

## S3. External agents

- `ExternalAgentConfig` gains an optional sandbox policy: network `full`
  (default, today's behaviour), `allowlist` (hosts), or `off`; readable scope
  `home` (default) or `workspace` (workspace, agent state roots and toolchain
  directories). Credential deny floors stay in every mode.
- The launcher gains `--network-allow <host>` (repeatable) next to `--network`.
  macOS: the host starts the filtering proxy and SBPL pins egress to its port.
  Linux: the S5 bridge. Windows external agents are not sandboxed today; the
  option is shown inert there.
- The CLI launcher (`cli/src/runtime/external/sandbox-launcher.ts`) builds the
  same argv from the same config.

## S4. Local Docker: `network=none` + exec byte bridge

- An allowlisted container is created with `network=none`. Its egress is the
  existing sandboxd service-bridge transport (Docker exec stdin/stdout frames,
  `crates/cognia-sandboxd/src/service_bridge.rs`) to a host-side filtering
  proxy, so it works when Docker runs inside a VM (colima, Docker Desktop) and
  needs no NET_ADMIN, internal networks or sidecars.
- Startup order: admit, freeze the effective allowlist (from
  `admission.egress_allowlist`, digest folded into the persistent runtime key),
  start the host proxy, create the gated container, inspect its real network
  mode, start the bridge, verify a generation-tagged Ready, release the gate,
  then lifecycle scripts and user commands.
- Every entry point (init, serve, persistent runtime, task shell, services)
  waits on the same gate and injects the proxy env last; `NO_PROXY` keeps only
  loopback so the gateway and services still work.
- A dead bridge or proxy blocks new execution and stops the runtime;
  `network=none` stays, so failure never opens the network. Persistent runtimes
  re-handshake on resume; legacy unfiltered allowlist runtimes are stopped and
  recreated.
- E2B keeps its provider-native allowlist; the new fields default off for
  remote runtimes.

## Verification

Unit tests run on macOS. Linux bridge tests are `cfg(target_os = "linux")`,
and those needing bwrap or a real Docker daemon are `#[ignore]` with the run
command in the test doc. Live Linux, Windows and multi-Docker-runtime behaviour
is reported as unverified unless it was actually run.

## S2. Windows filesystem roots (decision 2026-10-17)

Strict enforcement on original paths needs a signed filesystem minifilter and an
elevated install (WDK, driver signing; unverifiable on the macOS dev machine).
The user chose to land, this round:

- A versioned v2 runner protocol (`--protocol-v2`, JSON on stdin, nested
  envelope, every security field required, `deny_unknown_fields`), so an old
  runner refuses a v2 request instead of silently ignoring roots; plus a
  side-effect-free `--capabilities-v2` probe.
- A shared, platform-neutral filesystem plan (readable/writable trees, exact
  writable files, deny-read/deny-write floors from `protected.rs`, runtime
  reads, private scratch) with test vectors runnable on macOS.
- Fail-closed admission: until a runner reports filesystem enforcement, every
  Windows run that carries roots is refused with an explicit, labelled-inert
  reason (type, UI, test). Network Off/Allowlist are refused on Windows too
  until enforced; On runs and reports "not restricted".
- Launch hardening that stands on its own: checked `AssignProcessToJobObject`
  and `ResumeThread`, explicit handle lists, anonymous pipes for output,
  trusted runner path only.

The minifilter driver is a separate project and needs an ADR-0028 revision.
