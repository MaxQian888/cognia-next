---
title: "0152 — Connector controls name their host"
description: "Every connector control in Settings answered 'can I run here?' with isTauri(), and told a cloud companion its adapters needed the desktop app while those adapters were running on the paired server. Replaces the shell check with a host resolver, splits three genuinely desktop-bound controls out from the rest, and gives plugin-contributed connectors the configuration surface the registry already assumed."
---

# ADR 0152 — Connector controls name their host

**Status:** Accepted
**Date:** 2026-08-27
**Related:** [ADR-0009](./0009-platform-connectors), [ADR-0025](./0025-unified-subscription), [ADR-0059](./0059-server-ops-controller), [ADR-0131](./0131-cross-shell-inbox-relay)

## Context

Twenty controls across eighteen files in `components/settings/connections/**`
decided whether they could run by asking `isTauri()`. When the answer was no
they disabled themselves and rendered one of eleven near-identical strings
saying "requires the desktop runtime".

The *behaviour* was right, and this ADR does not change it. All 42
`connectors_*` commands are declared `target: service` with an empty
`transports` list, so a paired browser has no route to any of them, and
`setConnectorCommandInvoker` — the seam the headless brain uses to run the
same wrappers in-process — has no companion implementation. A browser cannot
test a token or probe a bot identity today, and pretending otherwise would
turn a clear message into a raw transport error.

The *explanation* was wrong, and it was wrong in opposite directions on the
two non-desktop profiles:

- A **cloud or mobile companion** was told "Adapters require the desktop app —
  already-configured conversations sync read-only here." Its adapters were
  running on the paired host, and the Inbox next to the banner was replying,
  approving drafts and writing conversation overrides through the relay
  (`lib/connectors/inbox-writes/route.ts`). Both halves of the sentence were
  false.
- A **standalone browser** has no connector runtime anywhere, on this host or
  any host it is paired to, because it is paired to nothing. "Open the desktop
  app" is the right answer there — and it is the only profile it describes.

Three of the twenty are not about a runtime at all: the cloudflared child
process, personal-WeChat QR login and Matrix password login need the desktop
process itself. A headless host runs adapters happily and can do none of them.

Separately, `plugin-connector-registry.ts` let a plugin own a `PlatformKind`
and run the full supervisor path, and validated its `configSchema` on the
grounds that "a settings form can be generated from it" — while the generator
sat in the unreachable-components baseline and the picker's kind list was
eleven hardcoded literals.

## Decision

**1. One resolver, not a shell check.** `connectorControlReach(profile,
requirement)` answers with `available` or one of three blocks: `no-runtime`,
`runs-on-host`, `needs-desktop-shell`. Every one of the twenty controls gates
on it. When `connectors_*` is raised to the device plane, twenty controls
change behaviour by editing one file.

**2. Two requirements, because two questions.** `connector-runtime` covers
anything that talks to a running bot; `desktop-shell` covers the three that
need the desktop process. `web-standalone` answers `no-runtime` for both:
telling someone their tunnel needs the desktop app skips the part where they
have no adapter either.

**3. Reason and next step stay separate strings.** The same rule the
capability vocabulary follows ([ADR-0009](./0009-platform-connectors)'s
capability projection, rendered by `CapabilityNotice`): a cause with no remedy
must be able to end after the reason. The two vocabularies share a layout
(`UnavailableNotice`) and nothing else — one answers what the platform gives
this bot, the other whether this host can drive it, and a Telegram bot with
every capability is still unconfigurable from a standalone browser.

**4. Ingress is not reach.** Lark's form was asking both through one boolean.
Where the inbound URL comes from — cloudflared versus a public origin —
decides the new-row transport default and the tunnel-off remedy; it is a
property of the machine, and it stays `isTauri()`. Whether the controls can be
driven is the resolver's. They are now `desktopShell` and `reach`.

**5. A contributed connector is configured by its own schema.** The picker's
kind list is built at render time from `listPluginConnectors()`, and any kind
outside the built-in eleven opens `PluginConnectorConfigDialog` — the revived
JSON-Schema generator, plus the display name, keyring credentials and trigger
policy floor a plugin should not have to reimplement. Secret fields are
declared the JSON-Schema way (`writeOnly`, or `format: "password"`), never in a
host-private field, and route through the same `CredentialInput` a built-in
platform uses so they land in the OS keyring rather than in a Dexie row that
backups copy.

**6. The four keyring arms move to the device plane, gated by a lease.**
`connectors_keyring_{set,get,delete,list}` were `target: service` /
`capability: service.internal`, reachable only by a token that loopback alone
can mint — which is why a paired browser could not configure a bot at all, and
why the desktop worked only because Tauri `invoke` bypasses this protocol face
entirely. They now carry `host-admin` / `host.admin` / `interactive` and the
three device transports, copying `external_bridge_relay_enable` exactly. They
also join `STEP_UP_COMMANDS` and leave `SERVICE_ONLY_COMMANDS`, so every call
must present a valid admin lease: `host.admin` keeps a multi-tenant member
device out, and the lease adds the time limit and revoke-on-disconnect a bare
capability check has no way to express.

The rest of the connector plane stays service-only. Nothing an operator does
in Settings needs to open a raw websocket or drive Matrix crypto, and widening
the whole family would trade a real boundary for nothing.

**7. Only the raised arms are routed, and only on a paired profile.**
`lib/connectors/device-plane.ts` holds the list of `connectors_*` commands a
device may reach — the four above and nothing else — and the default invoker
sends exactly those over `transport` when `detectHostProfile()` says the
keyring lives on a paired host. The other thirty-eight keep calling Tauri
`invoke`, because routing them would replace `control-reach.ts`'s precise
"this control talks to the runtime process" with a 403.

The predicate is the host profile rather than `!isTauri()` deliberately: a
`web-standalone` browser has no host to reach and a `headless` brain replaces
the whole invoker with its own, so both keep local behaviour and neither makes
a doomed round trip. It is also the same predicate `credentialLeaseRequired`
uses, so "route it there" and "it needs a lease" cannot disagree.

**8. One lease per session, taken on an operator gesture, released by time.**
`lib/connectors/credential-lease.ts` acquires a single lease covering all four
operations and caches it until it expires. A Slack form reads five credentials
and writes up to five more; ten prompts would train an operator to approve
without reading. A refusal is remembered briefly so a re-mounting dialog cannot
queue a prompt per paint, and an explicit retry clears it — which is what the
new unlock affordance on a `stored` field does. The lease rides in the
arguments rather than a header because that is where `rpc.rs` reads it and
because the WebRTC DataChannel path has no headers.

## Consequences

- The web-mode banner no longer claims the Inbox is read-only on a companion.
  It was never read-only there; the relay writes.
- A row whose contributing plugin has been disabled now opens and says the
  implementation is gone. Its settings are kept and it cannot start.
- The tunnel panel stops advertising a tunnel to deployments that do not run
  one.
- OneBot's Verify and Probe buttons render disabled instead of disappearing,
  matching the rule the capability surfaces adopted: render, disable, explain.
- A paired browser or phone can now read back and write connector credentials.
  Everything else in the connector settings section still says `runs-on-host`,
  which remains true: testing a token or probing a bot identity talks to the
  runtime process, and that has not moved.
- A credential a shell may not read is no longer a dead end. `stored` renders
  an unlock next to it, and the only thing the state used to offer — overwrite
  it blind — is no longer the only thing.
- Removing an adapter from a companion now destroys its secrets instead of
  reporting them under `failedCredentials`. The purge is the one step in that
  path whose refusal leaves something behind.
- The predicted ~21-suite cost of routing did not materialise: it was a
  consequence of routing on `!isTauri()`, which makes every node-env test look
  like a companion. Keying on the profile left the adapter suites untouched and
  needed changes in one.
- The generated mirrors (`host-command-catalog.json`, the OpenAPI specs, the
  headless contract hash) are NOT regenerated: `companion-api:gen` exits 1 on
  `dev` because eleven `git_stack_*` commands have no canonical dispatch arm.
  Nothing enforcing reads the stale fields — Rust loads
  `protocol/companion-commands.json` directly via `include_str!`, and
  `cognia-headless-contract` reads only `name` / `inputSchema` /
  `outputSchema`, none of which this change touches.

## Alternatives considered

**Flip the gates to `hasCapability("connector-runtime")` now.** That
capability is true on a companion, so every control would enable and then fail
with a Tauri transport error. A precise message beats an enabled button that
does not work.

**Route every `connectors_*` wrapper through `transport`.** One rule instead of
a list, but thirty-eight of the forty-two would then reach a transport gate
that 403s before the RPC layer sees them. The list is pinned against
`protocol/companion-commands.json` in both directions, so a future manifest
change that opens another command fails a test rather than rotting.

**Mint the lease lazily inside the invoker.** It would need no call sites, and
it would make any background credential read — a runtime bootstrap, a health
probe — silently request elevated access. The acquisition sits with the two
callers that represent an operator at a form instead.

**Give plugins a `secretFields` array on `PluginConnectorDef`.** It is wire
format in the plugin SDK, so adding a field is a breaking-ish change for a
question JSON Schema already answers twice, in the two spellings authors
already write.
