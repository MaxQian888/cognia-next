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
- `signalingUrl` / `iceServers` / `turnServers` were classified
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

`signalingUrl` / `iceServers` / `turnServers` and
`remoteBrowserEnabled` flow **down only**. They describe the deployment, not the
handset. `webrtcEnabled` is `device-local`: whether to attempt the tier is each
device's own call, even though the endpoints it dials are not.

`turnProvider` itself remains desktop-only because it carries a host-local
keyring reference. The host resolves static TURN secrets and publishes the
short-lived ICE servers minted by Cloudflare Calls or Twilio through the
mirrored `turnServers` field; paired clients never receive or resolve the
provider's long-lived secret.

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

### D13 — Pairings live in a credential book, split public/secret (2026-08-02)

D12 made switching hosts *safe*; it did not make it possible. `CompanionConfig`
was one record — one `baseUrl`, one device JWT, one TLS pin — so a client could
only ever hold one pairing, and everything that needed per-host separation had
to reconstruct it from whichever field happened to be unique.

That record is now split along its two real seams:

- **`CompanionHostRecord`** — the public half: label, endpoints, TLS pin, the
  device id the host issued, and a `cursorNamespace`. Plain storage on purpose:
  Settings must be able to list every paired host while the Vault is locked, and
  a locked Vault must not look like "no hosts paired".
- **`CompanionHostCredential`** — the secret half: device JWT and signaling
  private key. Browser Vault (PBKDF2/AES-GCM) or the platform keystore only, and
  never part of a record listing.
- **`CompanionCredentialBook`** — list/get/upsert/remove/set-active over both.

Pairings are addressed by `{hostId, accountNamespace}`. Both halves are required
because the same physical desktop can be paired from two local accounts, and
those pairings must never share a token, a watermark, or a mirrored row.

Three invariants the implementation exists to hold:

- **`cursorNamespace` is assigned once and never moves.** It is what sync
  cursors, outbound-queue rows and the runtime-target database are filed under;
  a namespace that shifted on a re-pair or a label edit would orphan all three.
- **`remove` drops the secret before the record.** The record is the only thing
  that can address the credential, so the reverse order would strand an
  unreachable device JWT in the keystore.
- **Connection updates are generation-guarded.** Probes race — a slow "offline"
  from the LAN prober can land after a fast "online" from the tunnel prober — so
  an update carrying a stale generation is rejected rather than applied.

`CompanionConfig` itself is unchanged and remains the shape every downstream
consumer reads; the book ships behind that interface, answering for the
account's *active* host. Multi-host callers talk to the book directly.

Existing pairings migrate once, ordered so an interrupted migration is
re-runnable rather than destructive: record → credential → re-file the persisted
cursors onto the new namespace → **read both halves back and compare** → only
then remove the legacy record. A verification failure keeps the legacy record
and reports why; losing a pairing would force a physical re-pair.

### D14 — The mirror wipe is decided by the database, not by the switch (2026-08-02)

D12 keyed cursors by the **device id** the host issued and wiped the mirrored
tables whenever that key changed. Both halves were too blunt.

`deviceId` is minted per *pairing*, not per host. Re-pairing to the same desktop
therefore read as a different host: a full re-pull of every mirrored table plus
a mirror wipe, for a machine whose state had not changed at all. Cursors are now
keyed by the host's **`cursorNamespace`** (`{accountNamespace}:{hostId}`, D13),
which is stable across re-pairs and distinct per account — the pair the mirror
actually belongs to. Rows written by a pre-namespace build are adopted on first
run rather than left to look foreign; without that step the upgrade itself would
wipe the mirror of the host the client is still paired to.

The wipe now answers one question, asked of the database rather than of memory:
**does this database already hold cursors for a host other than this one?**
Cursors are written per host into the same database as the mirrored rows, so a
foreign key there means that host's rows are in these very tables, and nothing
else does.

That single rule is what makes host switching non-destructive. Once an account
has runtime targets, each host's mirror lives in its own Dexie database
(`activateAccountDatabase(accountId, targetId)`), so switching activates the
other host's database and the scan finds nothing foreign: both hosts keep their
mirror and their watermark, and switching back re-pulls nothing. When two hosts
*do* share one database — an install with no runtime target, or the legacy
account-level database — the scan finds the foreign key and the wipe fires
exactly as it did before. The previous in-memory host-change check is gone; it
could not tell those two worlds apart, and it also missed every switch that
happened while the process was not running (routine on iOS, which kills the app
between the `CompanionConfig` write and the next sync tick).

The credential-book migration re-files the same legacy keys. A sync tick can
beat it, so both paths agree on which watermark survives — a row already under
the namespaced key wins — otherwise whichever ran second would rewind the
other's.

## Not done

- ~~**Multi-credential book on the phone.**~~ **Storage done (2026-08-02)** —
  see D13, and D14 for the switching path. One thing is deliberately still
  open, and it is visible from the book's own API: **no UI reaches `list()` /
  `setActive()` yet.** The book holds several hosts, but every current caller
  goes through the `CompanionConfig` adapter, which answers for the active host
  only. The host list and switcher land with the Companion Settings
  master/detail work; until then the multi-host half of the book is reachable
  but not exercised in the product.
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
