---
title: "0155 — Plugins reach the host through one door"
description: "Author-callable host tools, per-session runtime resolution, and a structured command result replace the per-plugin dependency injection that made one built-in plugin the only one able to search, read and reason."
---

# ADR 0155 — Plugins reach the host through one door

**Status:** Accepted
**Date:** 2026-08-28
**Related:** [ADR-0026](./0026-plugin-marketplace-integrations), [ADR-0060](./0060-web-reader), [ADR-0090](./0090-unified-agent-execution), [ADR-0100](./0100-unified-template-platform), [ADR-0145](./0145-python-plugin-runtime-alignment)

## Context

The Deep Research plugin was, on paper, a plugin. In practice the host carried
it:

- `lib/claude/plugin-tool-ipc.ts` branched on `request.name === "deep_research"`
  and injected a resolved web binding plus a model bridge into
  `PluginToolContext.hostContext`.
- The CLI carried a whole module, `deep-research-ai-bridge.ts`, whose only job
  was to build that one plugin a model client from CLI config — importing the
  plugin's own internal `AiBridge` type to do it.
- The plugin imported `@/lib/search/configured-search`, `@/lib/web/web-tools-core`,
  `@/lib/claude/web-builtin-tools`, `@/stores/settings` and `@/types/plugin`
  directly, and reached `ctx.ai` through an `as unknown as` cast because the
  public context did not admit it existed.

Every one of those is the same defect wearing a different hat: the capabilities
a research plugin needs — the user's search providers, an SSRF-safe page reader,
a model — had no public door, so the host cut a private one for the plugin it
shipped. A third-party plugin could not have been written this way, which means
the "plugin API" was not one.

The cost was not hypothetical. The CLI needed its own bridge *because* the
public API resolved everything through renderer Zustand stores that a CLI
process never hydrates; and because several CLI sessions share one process with
different providers and keys, an ambient lookup there is not merely empty, it is
capable of billing the wrong account.

## Decision

**1. Some host tools are author-callable, by name, on a fixed list.**

`ctx.agent.invokeTool` resolves `web_search` and `web_fetch` — and only those —
to the host's own promoted web built-ins, ahead of the calling plugin's own
tools. The plugin gets the user's configured providers, the shared result cache,
source verification, PII redaction, the SSRF guard and the outbound rate limiter,
because it is running the same code the main agent runs.

The list is an allowlist, not a filter. `dispatch_agent`, `ask_user`, session
control and working-set tools stay host-private; an unlisted name is refused
with `not-author-callable` rather than falling through to the internal
dispatcher. Cross-plugin calls remain unreachable from `invokeTool`: a plugin
that means to call another's tool declares the dependency and uses
`invokeDependencyTool`.

**2. The host resolves a runtime per call, and a session-scoped host fails
closed.**

`PluginHostRuntime` answers three questions — which web policy, which model,
which defaults — and `resolvePluginHostRuntime({pluginId, sessionId})` picks the
answer. Renderer, Tauri and mobile share one ambient runtime backed by the
settings store. The CLI registers one per session and turns ambient resolution
off, so a call that names no session, or names an unbound one, throws instead of
reading an empty store or borrowing another session's credentials.

This is why `AIChatOptions`, `AIEmbedOptions` and `PluginInvocationOptions` all
carry `sessionId`: on a multi-session host it is not metadata, it is the address.

**3. The PII gate sits above the runtime seam, not inside it.**

`ctx.ai.chat` / `ctx.ai.embed` run `assertNoLeakingPii` before resolving a
runtime. No runtime — current or future, renderer or CLI — can be the thing that
forgot to redact.

**4. A command may answer with its own content.**

`onCommand` may return `{handled, message?, payload?}`. The host inserts
`message` into the originating chat verbatim and passes `payload` to
programmatic callers. `true` still means "handled, use your generic line", and
`false` / `{handled:false}` still declines so another handler can try. The
invoking `{sessionId, characterId}` is handed to the plugin, because a command
that calls a model must bill the conversation the user typed in.

Before this, every plugin command answered "Command handled by plugin", so a
command whose entire output *is* the answer had to smuggle a multi-page cited
report out through a toast.

**5. Errors are classified, not stringly typed.**

Host tools resolve with `{ok: false, code, error}` over a fixed
`PluginHostToolErrorCode` vocabulary — `web-disabled`, `no-search-provider`,
`rate-limited`, `blocked`, `not-author-callable`, `invalid-arguments`,
`execution-failed`. The SSRF refusal is classified by error *type*
(`FetchTargetBlockedError`), not by matching its prose, so the classification
survives rewording.

## Consequences

Deep Research now imports `@cognia/plugin-sdk` and relative paths, nothing else,
and is gated on that by `pnpm plugin:author-imports` alongside the author
templates. `pnpm sdk:ts:pack:test` additionally type-checks its sources against
the *packed* SDK in a directory with no `@/*` aliases — the import gate can only
see what a file writes, while this proves the published types actually carry
what a plugin needs.

The host lost `PluginToolContext.hostContext`, the `deep_research` injection
branch, `resolveDeepResearchAiBridge`, and the CLI's `deep-research-ai-bridge`
module. What remains that names the plugin is one capability filter in
`build-options.ts` that hides a web-dependent tool when the user has turned web
tools off; it injects nothing and is a policy decision, not a dependency.

Deep Research also stops carrying its own Exa/Tavily provider and keys. Existing
persisted values are left in place rather than deleted, so a rollback is
possible; they are simply never read.

Contract goes to 1.1.0 and the TypeScript SDK to 0.2.0. The wire protocol stays
2.0.0 — nothing about the cross-process shape changed — and `minimumSdkVersion`
stays 0.1.0, because a plugin written against the old boolean `onCommand` and
the option-less `ai.embed` still compiles and still behaves exactly as it did.

### What this does not do

It does not open the host's internal tool surface, add a `ctx.web` namespace,
change the research engine's algorithm or report format, introduce a migration,
or touch plugin-marketplace signing, publishing and install. It proves one
thing: that a real, non-trivial plugin can compile and run against the public
SDK alone.
