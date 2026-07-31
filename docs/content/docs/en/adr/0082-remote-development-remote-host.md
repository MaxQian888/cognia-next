---
title: ADR-0082 — Remote development / connecting to a remote Cognia host
description: Desktop outbound transport routing, the remote-host registry, and the session-scoped active-host model that let the desktop UI drive terminals, files, and git on a remote Cognia server.
---

# ADR-0082 — Remote development / connecting to a remote Cognia host

**Status**: Accepted (2026-07-17)

## Context

`cognia-server serve` already stands up a complete headless Cognia on a remote
machine: it binds `0.0.0.0`, forces a master key, pins a self-signed TLS
fingerprint, and exposes the same companion data plane (`/api/v1/_rpc/*`,
`/ws/v1/terminal`, `/ws/v1/events`) that the Capacitor mobile client speaks. The
client transport contract (ADR-0012) is a two-method interface — `call` and
`subscribe` — and every workspace surface (files, git, terminal one-shots,
chat, external-agent RPCs) routes through a single process-wide `transport`
binding read per call.

The one architectural gap is on the desktop: `pickTransport()` hard-selects a
local `TauriTransport` and there is no path that points `transport` at a remote
host. So the desktop can host a Cognia but can never *drive* one. This ADR
records how the desktop gains an outbound "connect to a remote Cognia host"
mode without re-implementing the transport, terminal, event, pairing, or WAN
mechanisms that already exist.

Two questions had to be settled before building (they are the OPEN items from
the implementation plan):

- **OPEN-1** — the desktop has a *single* global `transport`. How does it drive
  both the local machine and a remote host?
- **OPEN-3** — an outbound client that stores a remote credential and pins a
  remote fingerprint is a security-posture change. Is it justified for v1?

## Decision

1. **Outbound routing via a `RoutingTransport` (resolves OPEN-1, option a).**
   On desktop, `pickTransport()` wraps the local `TauriTransport` in a
   `RoutingTransport`. The `Transport` contract is only `call` + `subscribe`, so
   the wrapper is a faithful proxy: it delegates to an *active remote* transport
   when one is installed and otherwise passes straight through to local. With no
   remote host active it is byte-for-byte the previous behavior — the zero-
   regression baseline. Switching the active host is a single pointer swap on a
   module-level holder; the ~480 `transport.call` sites and the `subscribe`
   event stream follow automatically because they read the live binding per
   call. The rejected alternative (keep the global local, hand a second
   transport instance to each remote-aware feature) was declined: it re-threads
   a per-target transport through terminal/fs/git/agent call sites and forfeits
   the "zero call-site change" property that makes this cheap.

2. **A remote-host registry, separate from the single-server companion config.**
   `companion-storage` holds exactly one paired server (mobile's model). Driving
   *several* remote dev boxes needs a multi-entry registry: each `RemoteHost` is
   a label plus a full `CompanionConfig` (baseUrl, deviceJwt, fingerprint, …).
   The host **list** is persisted (localStorage, `cognia.remoteHosts.v1`); the
   registry reuses the existing pairing client (`redeemPairCode` /
   `redeemPairJwt` / `decodePairPayload`), config shape, and fingerprint pin
   verbatim — no new pairing, crypto, or WAN code.

3. **The active host is session-scoped, defaulting to local.** The registry
   persists which hosts exist, never which one was active. Every launch starts
   local; the user explicitly activates a host to begin a remote session. This
   is the safe default — the app never silently drives a remote machine on boot
   — and it sidesteps boot-time re-activation wiring.

4. **The remote terminal reuses the durable host session, gated on the active host.**
   `selectTerminalTransport()` returns `tauri-channel` (local PTY) when no host
   is active and `ws` (`RemoteTerminalSession`) when one is — the only place
   "desktop targeting remote" leaks into the terminal stack. The companion
   endpoint resolver, previously never wired in production, is installed to
   resolve the active host's `{ baseUrl, deviceJwt }`. No new session subclass.
   The canonical endpoint is `/ws/terminal`; `/ws/v1/terminal` remains a
   compatibility alias. A device JWT is exchanged for a short-lived,
   single-use socket ticket and never appears in the WebSocket URL.
   Reconnect/replay belongs to the durable host process.

5. **Files and git are remote for free.** `workspace-fs` and `git/commands` are
   pure `transport.call` wrappers, so they follow `RoutingTransport` with zero
   new code. `fs_read`/`git_status`/`git_diff`/`git_log` are read-tier and reach
   the remote with the device JWT; `fs_write`/`git_commit`/`git_push` are
   CONTROL-tier and additionally require the remote to grant this device in its
   control-allow-list. That capability boundary is surfaced honestly, not hidden.

6. **Security posture (resolves OPEN-3).** v1's posture change is minimal and
   already precedented: the desktop stores a remote **device** JWT and pins a
   remote TLS fingerprint — exactly what the mobile client does today. It adds
   no outbound SSH, no sandbox-env changes, and no new keyring entries. The
   existing controls — mandatory master key, fingerprint pin, single-use pair
   JWT, and the READ_ONLY / CONTROL / SERVICE_ONLY capability gates enforced on
   the server — bound the blast radius. The heavier posture changes (outbound
   SSH, provisioning against `0.0.0.0`) belong to the SSH phase and get their own
   ADR.

7. **Scope and phasing.** v1 ships remote **terminal + files + git** (this ADR).
   Deliberately deferred, each for a concrete reason, not oversight:
   - **Remote external agents** — the `spawn/send/kill/get_external_agent_status`
     arms are SERVICE_ONLY; a device JWT can never reach them. Enabling them
     needs a service-token credential model *and* the headless external-agent
     initializer extraction (ADR-0059). Deferred until both land.
   - **Remote code-server / LSP** — `codeserver_*` are Tauri commands and no
     `lsp_*` companion arm exists; promoting them is VS Code Remote-SSH-scale
     work. Deferred (v3).
   - **SSH provisioning / tunnel fallback** — automated provisioning and
     implicit tunnel creation remain deferred (v3). The explicit SSH terminal
     profile described below is not a provisioning mechanism.

8. **SSH terminal security amendment (accepted 2026-07-31).** Explicit SSH
   terminal profiles are permitted under the following fail-closed boundary:
   - The native terminal host owns the `russh` connection. The renderer and a
     remote device may select only a synchronized profile id; passwords and key
     passphrases are resolved in native code from the `cognia-ssh` OS-keyring
     namespace and never enter profile JSON or the terminal wire protocol.
   - Server keys use a dedicated owner-only `known_hosts` file. First use is
     recorded with its fingerprint (TOFU); later connections must match, and a
     changed key aborts the connection. The UI surfaces whether the key was
     learned or verified and its fingerprint.
   - Private-key paths are local host configuration, never caller-supplied
     remote input. Remote clients can spawn only host-synchronized profiles;
     they cannot submit an arbitrary SSH hostname, username, credential ref,
     key path, or shell command.
   - SSH adds outbound connectivity only after the user creates and selects a
     profile. It does not bind a new inbound port, provision a server, weaken
     TLS/device pairing, or bypass terminal grants, controller leases, replay
     limits, and per-device session quotas.

## Consequences

- With no active remote host the desktop transport is unchanged; remote routing
  is inert until a host is explicitly activated, so local behavior cannot
  regress.
- Any feature built on `transport.call` / `transport.subscribe` becomes remote-
  capable automatically when a host is active — new surfaces get this for free
  and must not assume the call is local.
- Activating a host mid-session does not retarget already-open subscriptions
  (they bind at subscribe time); surfaces that should follow the active host
  re-subscribe when it changes. Terminals opened before/after a switch target
  whichever host was active at spawn.
- CONTROL-tier remote operations (write, commit, push) fail with a clear
  capability error until the remote grants this device control — this is a
  server-side allow-list decision, not a client bug.
- The remote-agent, remote-LSP, and SSH provisioning phases inherit this ADR's
  active-host model and registry; they add capability, not a second connection
  mechanism.

## 2026-07 operation-level capability contract

The coarse placement capabilities above remain available to workflows, but
management surfaces now use `host_feature_manifest`. The versioned manifest
binds a `hostBuildId` to concrete operations and runtime limits. It is refreshed
on activation/reconnect and discarded when the reported build changes. A
missing, unknown, or stale manifest is a deny signal for writes; clients do not
probe write commands optimistically.

Settings renders three explicit buckets: operations executed by the remote
host, controller-proxied operations, and unavailable features. The manifest
does not advertise incomplete work. In particular, session Skill attachment,
managed Bridge relay, and direct TLS exposure remain absent until their full
transport and security paths ship.

Remote Claude response commands carry a server-stamped execution context
(`hostId`, origin device, session, generation, request id, issued/expiry time).
The transport now routes context-bearing events only to the origin device and
rejects wrong-device, stale-generation, replayed, duplicate, and expired
response identifiers. The controller-proxy feature remains unadvertised until
every response is also registered against a concrete pending request and
session-scoped tool consent is available. Atomic Skill writes and host-managed
Bridge lifecycle are likewise unadvertised while their remaining ownership,
expiry, health, and migration requirements are incomplete.
