---
title: "0172: Remote access is verified, not assumed"
description: "The rendezvous advertises what it can carry and the settings probe it, the desktop detects the third-party tunnel and overlay clients it can lean on and shows how to install them, an overlay address can be the one an invitation advertises, and the one cloudflared child refuses to be silently repointed."
---

# ADR 0172: Remote access is verified, not assumed

**Status:** Accepted
**Date:** 2026-09-06
**Amends:** ADR-0170 (the relay is the WAN), ADR-0021 (WebRTC WAN transport)
**Related:** ADR-0059 (headless server), ADR-0143 (device console)

## Context

ADR-0170 made the hosted rendezvous at `signaling.cognia.cn` the route that
works from anywhere. Four things about it were still taken on faith.

1. `GET /healthz` on the rendezvous answered `ok` and a version string,
   and a deployment from before the data lane answers exactly the same
   `ok`. Such a relay forwards `data`-lane frames under the signal lane's
   8 KiB cap, so a device sees a relay that "works" until the first frame
   that does not fit. Nothing in the app could tell the two apart, and the
   Cloud & relay topic showed a switch and a URL, not a result.
2. The desktop's cloudflared tunnel is a user-installed binary, and the app
   learned it was missing only after the switch was flipped. The install
   steps existed once, in the Connections tunnel tab, as an untranslated
   table.
3. Tailscale and ZeroTier are how most people already put a phone and a
   desktop on one private network. Nothing in the app knew they existed:
   the invitation advertised the auto-detected `192.168.x.x`, which a phone
   on the same tailnet cannot reach, while the overlay address it could
   reach was one interface away.
4. One `cloudflared` child served two callers with two origins, the
   companion HTTPS listener and the connectors' webhook receiver. The
   second start silently killed the first, and the surface that started the
   first kept showing a public URL that now pointed somewhere else.

Plex answers "Remote Access" with one line before any setting, Tailscale's
client has a connection check, Home Assistant's cloud panel says what is
reachable. That is the pattern: verify, then show a word.

## Decision

### The rendezvous says what it carries

Both signaling backends (axum, Worker) add a `capabilities` block to
`/healthz` from `cognia-signaling-core::health`: the protocol generation,
the lanes served, and a `relayDataLane` flag. The endpoint sends
`access-control-allow-origin: *`, because the settings surface that reads it
is a static export on an origin the relay never heard of. A build without
the data lane lists only `signal`, and a pre-capabilities build lists
nothing, and both read as `legacy`.

`lib/signaling/relay-probe.ts` turns the configured `wss://` endpoint into
its health URL, fetches it through `createPlatformFetch()` (the desktop
CSP does not list the relay host, and the Capacitor shell has no CORS), and
classifies the answer: `ready`, `legacy`, `not-a-relay`, `unreachable`,
`invalid-url`. It is run on demand, never automatically, and the last
result is shown with its time.

### One sentence above the routes

Cloud & relay leads with `RemoteAccessSummary`: one verdict from
`remoteAccessVerdict` over the relay probe, the tunnel, and the overlay
network, then one row per route. The relay's switch and URL come from the
host-admin `companion_signaling_status` arm on any shell with a Host, so a
browser paired to a headless server probes the Host's relay, not its own
setting. A standalone browser reads its own setting and says so.

### The desktop detects what it can lean on

Two new desktop-only commands, labelled so by `host-admin-reach` like the
tunnel and mDNS they belong with:

- `companion_tunnel_probe` looks for `cloudflared` on the process's `PATH`
  and runs `--version`. The tunnel block shows the install guide before
  the switch is touched, and the version beside the title when it is there.
- `companion_mesh_status` enumerates the machine's interfaces and reports
  Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) and ZeroTier (`zt*`,
  `feth*`, "ZeroTier One") addresses, and whether each client is installed.
  Detection is by address and interface name, never by talking to a daemon.

`components/connectivity/tunnel-install-guide.tsx` is the one install guide
for all three tools, fed by `lib/connectivity/tunnel-install.ts` per OS
family, with the vendor's command lines verbatim and the words around them
translated. The Connections tunnel tab uses it too.

### An overlay address can be the advertised one

`reachability.json` gains `advertiseHost`. `advertised_lan_host()` is the
one function behind the desktop invitation command, the host-admin
invitation arm, and the `companion_endpoints` LAN report: the saved host
when there is one, else the auto-detected LAN address. The mesh block
offers the carried overlay address as that host, refuses on a loopback
binding, and warns when the saved address is no longer carried.

### The one tunnel child is not silently repointed

`TunnelState::start` is idempotent for the origin it already exposes and
refuses a different one with `TunnelError::Busy` unless `replace` is set.
Both surfaces show the conflict, name what the tunnel exposes and at which
public URL, and offer "Replace". A live tunnel started from the other
surface is shown as what it exposes, not claimed as this listener's.

## Non-goals

Tunnel, mesh or cloudflared detection on a headless Host: it names its
public address with `COGNIA_PUBLIC_URL` and `--advertise-url`. Managing
Tailscale or ZeroTier from the app. Automatic relay probing. Deploying the
Worker, which remains the operator's action, and which the probe now makes
visible when it has not happened.

## Consequences

- A stale rendezvous deployment is a sentence in Settings, not a support
  ticket from the road.
- A user with Tailscale pairs a phone over the plain HTTPS tier from any
  network by flipping one switch, with nothing exposed to the internet.
- The install steps live in one table and one component.
- `HEADLESS_CATALOG_HASH` did not change: both commands are `client`
  target, so the Brain bridge contract is untouched.

## Registration points

- Relay: `services/signaling-server/core/src/health.rs`, the axum
  `server.rs` and the Worker `lib.rs`, `lib/signaling/relay-probe.ts`.
- Desktop: `src-tauri/src/companion_api/{tunnel,mesh,reachability_config}.rs`,
  `commands.rs` (`companion_tunnel_probe`, `companion_mesh_status`,
  `advertised_lan_host`), `rpc/host_admin.rs`, `rpc.rs` (`lan_base_url`).
- Contract: `protocol/companion-commands.json`,
  `protocol/headless-command-dispositions.json` (both `local-only`).
- Settings: `components/settings/connectivity/blocks/{remote-access-summary,relay-check-block,mesh-block,tunnel-block}.tsx`,
  `hooks/connectivity/use-remote-access.ts`,
  `lib/connectivity/{remote-access,mesh,tunnel-install,tunnel-resolver,reachability-prefs}.ts`,
  `components/connectivity/tunnel-install-guide.tsx`,
  `components/settings/connections/tabs/tunnel-tab.tsx`.
