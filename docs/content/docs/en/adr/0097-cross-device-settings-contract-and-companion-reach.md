---
title: ADR-0097 — Cross-device settings contract and companion reach
description: "One classification table decides which AppSettings fields cross the wire and in which direction, generating the Rust write-allowlist and the OpenAPI enum; host mirroring moves into the single persistence funnel; and the connection logic that was gated behind a Capacitor check becomes host-neutral so a browser companion behaves like a phone."
---

# ADR-0097 — Cross-device settings contract and companion reach

**Status**: Accepted (2026-07-29)
**Authors**: Max Qian + Claude
**Builds on**: ADR-0012 (transport abstraction), ADR-0021 (WebRTC WAN transport),
ADR-0027 (mobile offline & discovery), ADR-0056 (mobile settings parity),
ADR-0059 (cloud deployment / headless brain), ADR-0085 (cloud shared browser)

## Context

The mobile↔desktop↔cloud substrate is broadly built: five `Transport`
implementations, four reachability channels, a sync orchestrator with persistent
cursors and an outbound queue, Dexie-first reads, remote-host routing, and a
headless brain. An audit of the *seams* between those pieces found a cluster of
silent failures that share one shape — a contract described in two places that
nothing compared, or a capability gated on a runtime check that was broader than
the thing it was protecting.

**Settings crossed the wire according to two hand-written lists.** The Rust
`APP_SETTINGS_MOBILE_ALLOWED_KEYS` decided what a client could write up; the
TypeScript `CROSS_PLATFORM_SETTING_KEYS` decided what the host mirrored down.
Nothing checked them against each other, and they had drifted:

- ~51 fields were writable up but never mirrored down, so a phone's appearance,
  text-to-speech, notification and web-search preferences diverged permanently
  from the desktop's.
- `defaultCharacterId` was allowlisted but lives on `AdapterInstanceRow`, not on
  `AppSettings` — a phone could pass validation and then write a field that does
  not exist.
- `signalingUrl` / `iceServers` / `turnServers` / `turnProvider` were classified
  in exactly the wrong direction. The client reads them from its *own* row to
  dial the rendezvous, and they were never mirrored down, so a self-hosted
  signaling server or TURN relay configured on the host could not reach the
  phone at all. The symptom was WebRTC failing behind strict NAT.
- `remoteBrowserEnabled` had the same inversion, which made the ADR-0085 cloud
  shared browser unreachable from any non-Tauri client: it is gated on a value
  those clients could never receive.

**Host mirroring was a per-page responsibility.** `useSettingsPatch` saved
locally and enqueued `app_settings_update`; nine `/me/*` pages called it. Mobile
routes that instead *embed a desktop settings section* — `/me/appearance`
renders the desktop `<AppearanceSection />` — went straight to the settings
store, which only wrote locally. Thirteen allowlist entries existed specifically
so those tabs would not 400, and none was ever exercised.

**`sync_pull` put the host's entire settings row on the wire.** The client
applied only the mirrored subset, which made this look harmless, but the whole
row had already been sent: API keys, provider and search-provider credentials,
subscription tokens, the WebDAV password, proxy authentication, working-directory
paths. Every paired device received all of it. The allowlist's own comment said
provider configuration stays desktop-only; that only ever constrained writes.

**The companion connection logic was gated on Capacitor.** Channel-inventory
refresh, reconnect orchestration, network-recovery re-probing, TURN provisioning
and the WebRTC tier all sat behind one `isCapacitor()` early return, so a browser
pointed at a cloud `cognia-server` had none of them — only the WebSocket's own
backoff. Only one of those five needs native networking.

## Decisions

### D1 — One classification table, four categories

`packages/agent-config-types/src/settings-sync.ts` classifies every
`AppSettings` field:

| category | client → host | host → client |
| --- | --- | --- |
| `shared` | yes | yes |
| `server-authoritative` | no | yes |
| `device-local` | no | no |
| `desktop-only` | no | no |

`device-local` and `desktop-only` are both "never crosses the wire" but are not
the same claim: the first says every device legitimately holds its own answer,
the second says the field is not part of the mobile contract at all. The two
asymmetric categories carry a **mandatory rationale** (enforced by the union
type), because an unexplained asymmetry is indistinguishable from a bug later.

### D2 — Completeness by type, drift by gate

The table is declared `satisfies Record<keyof AppSettings, SettingsSyncEntry>`,
so adding a settings field without classifying it fails `pnpm typecheck` — no
new gate needed for completeness. `scripts/build/gen-settings-sync.mjs`
generates the Rust constant and the OpenAPI `propertyNames.enum` from the table;
`settings-sync:check` runs it in `--check` mode in the gate registry. Drift moves
from "will be detected" to "cannot be expressed".

### D3 — Transport config is server-authoritative

`signalingUrl` / `iceServers` / `turnServers` / `turnProvider` and
`remoteBrowserEnabled` flow **down only**. They describe the deployment, not the
handset. `webrtcEnabled` is `device-local`: whether to attempt the tier is each
device's own call, even though the endpoints it dials are not.

Three fields stop being written up because doing so was wrong rather than
useful: `biometricRequiredFor` (a property of this device's own authenticator —
pushing a phone's policy onto a laptop with no biometric hardware could lock it
out), `workflowEditorPerformanceTier` (chosen for one device's GPU), and
`selectedMicId` (an identifier that addresses nothing elsewhere).

### D4 — Mirroring hangs off the persistence funnel, not off pages

Every settings write funnels through `lib/db/settings.ts:saveSettings`. The
enqueue moves there (`lib/settings/mirror-to-host.ts`), which fixes every
embedded desktop section at once and makes the next reused section correct on
arrival. `saveSettings` takes `{ mirrorToHost: false }` for writes the user did
not make — the boot-time repair path — so a local cleanup is not replayed onto
the host as an intentional edit.

Rejected: threading an injectable patch callback through the sixteen appearance
components. It would have fixed one section and left the pattern intact.

### D5 — Pending writes mask the down-mirror

A pull skips any field with an `app_settings_update` still queued (`pending`,
`sending` or `failed`). Without this, editing offline visibly snapped back on
reconnect and then changed again once the queue drained. `sent` is excluded
because the host already has the value; `deadlettered` is excluded on purpose —
those writes will never be retried, so masking them would pin the client to a
value the host is never going to hold.

Rejected: per-field timestamps. They solve genuine concurrent editing, which for
a single user is rare, at the cost of changing the row shape, both sync paths and
the Rust write path, plus clock-skew handling.

### D6 — Redact at the source

`readSettingsDelta` narrows the settings singleton to the mirrored fields before
it leaves the host. Redacting at the client would not help: a client cannot
un-receive a secret, and the wire protocol is spoken by more than first-party
clients.

### D7 — Host-neutral by default, gated only where the host actually differs

The companion controller runs wherever the live transport is a
`CompanionTransport` — Capacitor and a browser with a configured server. Only
local-network discovery (mDNS plus a subnet sweep) stays Capacitor-gated; a
browser uses the addresses the host reports through `companion_endpoints`, which
was its only route regardless. The entry point is renamed
`installCompanionSignalingController` to match.

### D8 — One table for the four channels

Companion settings gains a Channels table joining bind mode, mDNS, tunnel and
WebRTC into one view: state, address, and last probe result per route. It
distinguishes a route that is *off* from one that is *on but cannot work*
(server stopped, bound to loopback, WebRTC with no rendezvous server) and names
which applies. It replaces the Connection diagnostics card, which ran the same
probe but printed a flat list of URLs with no idea which route each belonged to.

### D9 — Cloud sign-in is not desktop-only

The Logto card moves to a shared surface with a mobile route
(`/me/cloud-account`). Off the desktop the session lives in an encrypted
IndexedDB vault, which refuses writes until its key is injected; nothing injected
it for Logto, so a sign-in on a phone would have completed the whole browser
round-trip and failed while persisting the token. `session-store.ts` now
provisions that key the way `lib/plugin/api/secrets-api.ts` does.

### D10 — Elevated capabilities are grantable on every host, and agents are their own grant

Two problems, one shape.

`control_allow_list` is an in-memory set whose only writer was a Tauri command
called from the desktop renderer at boot. A headless `cognia-server` has no
renderer, so the list was empty for the process lifetime and **every CONTROL-tier
RPC was unreachable with a device JWT on a cloud host** — you could pair a
desktop to one, read the capability boundary ADR-0082 documents, and find no
mechanism anywhere that could grant it. `device_grants.rs` adds the missing
half: a JSON file beside the other headless credential files, read at boot to
seed the allow lists, written by `cognia-server devices grant|revoke|grants`.
Grants apply at the next `serve`, which the CLI states, matching
`rotate-master-key`.

Separately, the four external-agent arms were `SERVICE_ONLY`, so ADR-0082's R4
was blocked by construction: pairing yields a *device* JWT and nothing could
turn one into a service token. They move to a fourth tier,
`AGENT_CONTROL_COMMANDS`, gated on service scope **or** an explicit
agent-control grant, enforced at both the HTTP handler and the `dispatch`
mirror so the WebRTC path is not a way around it.

Agent control is a **separate grant from remote control**, not a flag on it.
Remote control steers work the host already chose to run; this starts new
processes. One switch would mean a user enabling remote control so their phone
could approve a prompt had also handed out process execution. Both are exposed
as independent per-device toggles, both biometric-gated on the enabling
direction.

The safety floor does not move: every spawn still clears the `SpawnPolicy`
preset allowlist (bare binary from a fixed list, workspace-rooted cwd,
default-deny env) and every allow *and* deny is audited with the caller's
device id and scope. That check runs on the request, not the caller, so a
granted device gets exactly the same treatment as the brain.

### D11 — A host answers for its own capabilities

ADR-0061's `remoteCapabilityUnion` aggregates `pairedDevices` — devices that
paired *into* this machine. Pairing runs client → host, so the host a client is
**driving** is structurally absent from that list, and there was no other way to
ask. Workflow preflight therefore judged a remote cloud server by the local
baseline and rejected `always-on` / `headless` work the server could have run.

`host_capabilities` is a READ-tier RPC routed through `desktop_writes_bridge`,
so the host's own TypeScript layer answers — the renderer on a desktop, the
brain on a headless server, both of which already install
`installDesktopWriteSource`. Answering in Rust would have meant a second copy of
the capability vocabulary, which is the exact failure D1 exists to prevent.

The client asks on activation, stores the answer on the `RemoteHost` row, and
`remoteCapabilityUnion` unions it. A host that cannot answer keeps its last
known list rather than being blanked: a stale answer still beats silently
falling back to the local baseline. The Hosts list shows what came back, or says
plainly that it has not asked yet.

This is the visibility half of ADR-0061 P5. Placement — routing a cron or
webhook trigger to the cloud node when the desktop is offline — is **not** done;
see below.

## Consequences

- The Rust constant and the OpenAPI enum are generated artifacts. Editing them
  by hand is reverted by the next generator run and caught by CI.
- Three settings stop propagating between devices (D3). Each still works on the
  device it is set on; the changesets say so.
- The mirrored subset is now the *only* thing a paired client can observe about
  the host's settings, which is a behavioural narrowing for anything that was
  (incorrectly) relying on the full row.
- A browser companion now negotiates WebRTC and fails over between channels.
  That is new surface area on a runtime that previously did neither.

### D12 — Sync state is scoped to the host it came from

`syncCursors` was keyed by table name alone. Nothing recorded which host a
watermark came from and nothing cleared it on a re-pair, so a client that paired
elsewhere resumed from the previous host's watermark and asked the new one for
everything since a timestamp that meant nothing there — blending two machines'
sessions, messages and characters into one local store, silently.

Cursors are keyed `[serverKey+table]` (v130), where `serverKey` is the **device
id the host issued at pair time** rather than the host's own `serverId`: it is
unique per (client, host) pair, present from the moment of pairing with no
first-connect round-trip, already persisted in `CompanionConfig`, and it changes
exactly when a fresh pull is the safe answer.

Partitioning cursors is necessary but not sufficient — the *rows* pulled from
the previous host stay in the same tables. The orchestrator therefore clears the
mirrored tables when it observes the host key change. `settings` is excluded: it
is the one mirrored table the client also writes locally, and clearing it would
discard device-local preferences the host never had.

Two implementation notes worth keeping:

- Dexie **cannot change an existing table's primary key**; attempting it breaks
  every multi-version upgrade path in the database, not only the new one. The
  per-host cursors therefore live in a new store (`hostSyncCursors`) and the old
  one is dropped in the same version.
- Version **129 is deliberately skipped**. A concurrent branch was in flight
  over the same working tree, and schema numbers have been lost that way twice
  before (v66, v69). Dexie only requires versions to increase, so leaving the
  next number free costs nothing and removes the chance of two branches shipping
  different definitions of one version.

## Not done

- **Multi-credential book on the phone.** A client still holds exactly one
  `CompanionConfig`, so moving between a home desktop and a cloud server means
  re-pairing. D12 makes that *safe* — which is what made it a bug rather than
  merely inconvenient — but not convenient. Storing several hosts' credentials
  and switching between them is a separate change; the isolation had to land
  first, because fast switching without it would have turned a rare corruption
  into an everyday one.
- **Workflow placement (ADR-0061 P5 proper).** Nothing chooses *where* a run
  executes. A cron or webhook trigger fires in whichever process received it —
  `trigger-bridge` calls `runWorkflow()` in place — and there is no
  desktop-liveness probe, no executor election and no handoff. D11 makes the
  cloud host's capabilities visible; it does not make anything run there when
  the desktop is off. That needs distributed-scheduling semantics (who counts as
  offline, after how long, what happens when both sides believe they should run)
  on top of the existing `run-lease`, and was deliberately scoped out.

- **Companion settings master/detail.** The section is still one scroll of
  collapsible groups rather than a nav + panel split like Gateway or Appearance.
  Deliberately deferred: it is navigational form, not a broken mechanism.
