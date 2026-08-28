---
title: "0156 — Every in-tree plugin is a third-party plugin"
description: "The 52 first-party plugins now compile against @cognia/plugin-sdk alone, the capability registries the SDK already had are published as subpaths, and a shrinking baseline keeps the boundary from reopening."
---

# ADR 0156 — Every in-tree plugin is a third-party plugin

**Status:** Accepted
**Date:** 2026-08-28
**Related:** [ADR-0026](./0026-plugin-marketplace-integrations), [ADR-0030](./0030-character-packs), [ADR-0145](./0145-python-plugin-runtime-alignment), [ADR-0155](./0155-plugins-reach-the-host-through-one-door)

## Context

[ADR-0155](./0155-plugins-reach-the-host-through-one-door) closed the private
door the host had cut for Deep Research. The same defect was everywhere else:
of 52 in-tree plugins, 46 imported host-private modules — `@/lib/**`,
`@/stores/**`, `@/types/**`, `@/components/**` — around 530 imports in all.

`pnpm plugin:author-imports` already existed, but it governed three templates
and one reference plugin. Everything else was outside it, so "first-party
plugin" quietly meant "code in `plugins/` with host privileges", and the
plugin API's real shape was whatever the host happened to expose.

Two findings shaped the fix.

**The SDK mostly already had the answer, unwired.** `packages/plugin-sdk/src/api/`
held 63 curated capability modules — the character-pack registry, the subagent
registry, the external-agent protocol adapter, the OCR provider registry — and
five of them were reachable. The rest were built and forgotten: a plugin that
wanted to register a character pack at activation had no published way to do
it, so it imported `@/lib/plugin/registries/character-pack-registry`.

**Where the SDK genuinely had a hole, the hole was load-bearing.** Not
cosmetic gaps: `defineMessageRenderer` could register a renderer for a part
type nothing could emit; `ctx.sessions.getCurrentSessionId()` returned `null`
for every plugin in production because the store it read is only populated by
a `load()` nothing calls; a plugin driving computer use could not read the
user's computer-use policy; a sandbox consumer could not ask whether a session
was confined before executing.

## Decision

**1. The root barrel stays types and pure helpers; registries are subpaths.**
`packages/plugin-sdk/src/index.test.ts` already pinned that registry-backed
functions must not appear on the package root, and it is right: importing a
registry should be a decision an author writes down, not something that arrives
with `import { definePlugin }`. So the 63 api modules are published as
`@cognia/plugin-sdk/api/<capability>` — an explicit allowlist, no wildcard —
and the root grew only types and pure functions.

**2. `unregisterXxxByPlugin(pluginId)` is the teardown, on disable and in
tests.** Plugin suites were calling the host's `__resetXxxForTesting` helpers,
which are not on the author surface and which clear contributions the plugin
never made. Every registry already had the plugin-scoped twin.

**3. Where a plugin needed something the SDK did not have, the SDK grew a
contract — not the plugin a workaround.** Fourteen new surfaces, each one
justified by a specific plugin that could not otherwise be written:
`host-environment` (which shell am I in, where is the user working),
`sandbox`, `skill-recorder`, `browser`, `i18n`, `security-findings`, `eval`,
`resources`, `agent-turn` (a headless character turn, and seeded sessions),
`workflow-editor`, `workflow-run`, `slash-command`, `tool-renderer`, and a
test-only `testing`.

Three of those replaced a *duplicate* rather than a gap. "Where is the user
working" was implemented twice — inline in the CLI-tool executor and copied
verbatim into `workspace-tools`. "Who is driving this turn" — which decides who
may tap an approval button — was derived inside `workflow-ai`. The headless
agent turn was assembled from five host modules, one of which handed the plugin
the entire settings row.

**4. The gate governs every plugin against a baseline that may only shrink.**
A plugin that regresses fails; a plugin that has been cleaned but is still
listed *also* fails, so the record cannot overstate what is left. The baseline
is now empty. The gate counts `jest.mock()` and friends as module references —
a test that imports from the SDK while mocking `@/lib/...` is still pinned to a
host path — and ignores comments and vendored author-type bundles, which were
producing false positives.

**5. A host test that lives in a plugin directory is a host test.**
`sre-agent` carried a suite that booted the real `PluginManager` and drove the
signature verifier and permission guard. No third-party plugin could write it,
which is exactly why it kept host-private imports alive. It moved to
`lib/plugin/core/`.

## Consequences

- All 52 in-tree plugins compile against `@cognia/plugin-sdk` and
  `@cognia/plugin-ui` alone. Each one is now a worked example a third party can
  actually follow, which is the only thing that keeps the published surface
  honest.
- Four latent defects were fixed on the way, because the migration forced
  someone to ask what the supported call was: `ctx.sessions` returning `null`
  in production; `defineMessageRenderer` having no way to emit its part;
  `web-tools` mocking a settings store it stopped reading; and a plugin test
  whose `@/lib/platform/detect` mock reached past the plugin into the host
  keyring.
- The published third-party surface is materially larger. That is the intended
  direction — it is written down, tested and versioned, where before the same
  reach was available to first-party code and to nobody else — but each subpath
  is now a compatibility commitment.
- `ctx.chat.appendMessagePart` follows the existing chat-API convention of
  documenting its `session:write` requirement rather than enforcing it; the
  other three write methods on that API are the same. Guarding the chat API is
  separate work.
