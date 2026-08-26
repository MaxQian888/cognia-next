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

## Consequences

- The web-mode banner no longer claims the Inbox is read-only on a companion.
  It was never read-only there; the relay writes.
- A row whose contributing plugin has been disabled now opens and says the
  implementation is gone. Its settings are kept and it cannot start.
- The tunnel panel stops advertising a tunnel to deployments that do not run
  one.
- OneBot's Verify and Probe buttons render disabled instead of disappearing,
  matching the rule the capability surfaces adopted: render, disable, explain.
- The four keyring arms are reachable from a device *at the protocol level*,
  and are not yet usable from one: `lib/connectors/tauri/commands.ts` still
  calls Tauri `invoke` rather than the routed `transport`, so the call never
  leaves a browser, and no form requests the lease those arms now demand. The
  door moved from "impossible" to "needs a lease you cannot yet obtain" —
  strictly closed either way, which is why it is safe to land first. The UI
  keeps saying `runs-on-host`, so nothing on screen claims otherwise. Routing
  the wrappers costs ~21 adapter suites that mock `invoke` and would start
  meeting the web stub's rejection; that is its own unit of work.
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

**Give plugins a `secretFields` array on `PluginConnectorDef`.** It is wire
format in the plugin SDK, so adding a field is a breaking-ish change for a
question JSON Schema already answers twice, in the two spellings authors
already write.
