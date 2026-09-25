---
title: "0195 — A plugin writes to the contract, not around it"
description: "An audit of all 66 in-tree plugins found the same workarounds repeated plugin by plugin: forked SDK registries, hand-rolled translation hooks, casts past unmapped context methods, silent no-ops on mobile. Each one was a hole in the host API. This ADR closes them at the contract: every SDK subpath is a shared module, the catalog is checked in both directions, and the missing seams (navigation, plugin translations, live queries, a test context, a host web-clone tool, localized manifest names, slot context) become public API."
---

# ADR 0195 — A plugin writes to the contract, not around it

**Status:** Accepted — implemented
**Date:** 2026-09-25
**Related:** [ADR-0155](./0155-plugins-reach-the-host-through-one-door) and [ADR-0156](./0156-every-in-tree-plugin-is-a-third-party-plugin) (the author boundary this ADR fills in), [ADR-0145](./0145-python-plugin-runtime-alignment) (the contract catalog), [ADR-0189](./0189-a-plugin-says-which-of-four-things-it-is-doing) (interceptors), [ADR-0026](./0026-plugin-extension-point-expansion) (extension slots)

## Context

ADR-0156 made every in-tree plugin import only the public SDK. It held: the
author-imports gate is green. But a plugin-by-plugin audit of all 66 bundles,
on desktop and at a 375 px mobile width, showed what authors did when the
public API did not have what they needed. They worked around it, and each
workaround was repeated in several plugins:

- **Forked registries.** Only a few SDK subpaths were shared modules. A
  plugin importing any other subpath bundled its own copy, so
  `registerX()` wrote to a registry the host never read.
- **Unmapped context methods.** The governed context throws `unmapped` for any
  method missing from `catalog.json`. 37 methods that `PluginContext` exposed
  (artifact versions, `chat.appendMessagePart`, `i18n.getLocale`, the
  `integrations.*` family, and others) were not in the catalog. Plugins cast
  around the types (`as never`, `ctx.x?.`) and failed at runtime.
- **Private translation hooks.** Several plugins shipped their own
  `use-plugin-t.ts` over `ctx.i18n.t`, with manual `plugin.<id>.` prefixes
  and no re-render on locale change. Manifest names had no way to be
  localized at all.
- **Framework imports.** Plugins reached for `next/navigation` to route and
  for `dexie-react-hooks` for live reads. Neither is available to a Python,
  WASM or installed bundle, and both couple the plugin to one host.
- **Silent mobile no-ops.** `ctx.files.save` wrote nothing inside the
  Capacitor WebView and still reported success.
- **Stale or leaky semantics.** `ctx.config` was a snapshot taken at
  activation. Context providers from every plugin ran for every plugin's
  agent. `deactivate()` got no context, so it could not unregister cleanly.
  `onConnectorInbound` / `onConnectorOutbound` hooks ran without any
  connector permission.

Fixing each plugin in place would have left the next author with the same
missing seams.

## Decision

### 1. Every published SDK subpath is a shared module

`lib/plugin/core/sdk-subpath-loaders.ts` maps every entry in
`@cognia/plugin-sdk`'s `exports` (except `./testing`) to a lazy host loader.
`primeSharedModulesFor(code)` primes only the subpaths a bundle actually
imports. The browser-builtin builder and the CLI frontend builder both
externalize `@cognia/plugin-sdk/*`, so an installed plugin resolves the same
module instance as the host.

### 2. The catalog is checked in both directions

`catalog.json` gains the 37 missing rows and `ui.navigate` (836 method
contracts). A reverse parity test in `lib/plugin/core/context.test.ts` walks
the fully mounted context and fails on any callable the catalog does not list.
A method can no longer be reachable in the types and `unmapped` at runtime.

### 3. The missing seams become public API

| Need                          | Contract                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Route to an app page          | `ctx.ui.navigate(href)`: in-app hrefs only (`isInAppHref`), delivered to the host router by `plugin-runtime-initializer`                                                 |
| Translate plugin strings      | `usePluginTranslations(pluginId)` from `@cognia/plugin-sdk/api/i18n`; it prefixes keys and re-renders on locale change                                                   |
| Localize the plugin's name    | `manifest.nameKey` / `descriptionKey` (and `commands[].descriptionKey` for the `/` picker), resolved from the plugin's own `i18n.locales` by `lib/plugin/i18n/manifest-text.ts` in the library, detail and permission prompts |
| Live reads                    | `useLiveQuery` re-exported from `@cognia/plugin-ui`                                                                                                                      |
| Test a plugin                 | `createTestPluginContext()` from `@cognia/plugin-sdk/testing`: a fully mounted fake context with call recording                                                          |
| Check compatibility           | `evaluatePluginCompatibility` from `@cognia/plugin-sdk/manifest`                                                                                                         |
| Clone a web page              | `web_clone` is an author-callable host tool beside `web_search` / `web_fetch`, with per-tool permissions in `PLUGIN_HOST_TOOL_PERMISSIONS` and the same egress check      |
| Keep a multi-line command arg | `PluginCommandContext.rawArgs`, forwarded to Python commands too                                                                                                        |
| Know where a slot renders     | `ExtensionProps.context`; the `chat.input.effort` slot passes `ChatInputEffortSlotContext {sessionId, disabled, compact}`                                                |

The author-imports gate adds a rule: a plugin's runtime code may not import
`next`, `next-intl`, `dexie`, `dexie-react-hooks`, `@tauri-apps/*` or
`@capacitor/*`. Type-only imports and tests are exempt.

### 4. Existing contracts say what they did

- `ctx.files.save` uses the mobile export path on Capacitor and returns
  `{ saved, platform, location }`, so a plugin can say where the file went.
- `ctx.config` is a getter over the plugin store: a settings change is visible
  to the next read without reactivation.
- Context providers resolve per owning plugin (`resolveContextContributions(input, pluginId)`).
- `deactivate(context)` receives the plugin's context. The manager skips a
  deactivate that has none to give it.
- Declaring `onConnectorInbound` requires `connectors:read`, and declaring
  `onConnectorOutbound` requires `connectors:send`. Validation rejects the
  hook otherwise.
- Computer Use keeps the sandbox runtime the call came from
  (`sandboxRuntimeRef`) instead of re-resolving it by session.

### 5. Plugin-contributed skills are reachable

Skills registered by plugins appear in the chat skill picker ("From plugins"),
in `@` mentions and in effective-skill resolution. A character can pin them
(`pluginSkillIds`). Before this change they were registered, and no surface
could select them.

### 6. Every in-tree plugin is migrated

All 66 plugins use `definePlugin` + `definePluginManifest` +
`definePluginTool`, with no `as never` casts. Tools that write or send carry
`requiresApproval`, tools that take paths declare `access` + `pathParams`, and
long tools set `timeoutMs`. Strings live in the plugin's own locale bundle,
including `nameKey` / `descriptionKey`. `runtimeCompatibility` is truthful.
Demos, theme packs and `cognia-laya-guard` are manual-enable builtins, so a
fresh install does not start them unasked.

## Alternatives rejected

- **Fix each plugin locally.** Every workaround was already duplicated. Fixing
  them one by one leaves the gap for the next third-party author.
- **Let plugins import `next/navigation` and `dexie-react-hooks` directly.**
  This only works for React bundles on one host. `ui.navigate` and the
  re-exported `useLiveQuery` go through the same seam for every runtime.
- **Bundle the SDK into each plugin.** This is the cause of the forked
  registries, not a fix for them.
- **Let the web-clone plugin run its own snapshotter.** That needs shell and
  filesystem access the plugin should not hold, and it duplicates the native
  runner. As a host tool it inherits egress checks and permissions.
- **Translate manifest names in the host's message files.** Host bundles
  cannot know installed plugins. The plugin's own locale bundle is the only
  place that can.

## Consequences

- The catalog, and the five mirrors generated from it, grow to 836 methods.
  Adding a context method without a catalog row now fails a test.
- `deactivate` gains a parameter. Existing JavaScript plugins that ignore it
  are unaffected.
- A plugin that declares connector hooks without connector permissions now
  fails validation instead of running ungated.
- Theme packs lose `motionSpeed`, and the validator rejects invalid values.
- Out of scope, and left as follow-ups:
  - a pet reward event kind for plugins
  - uninstall from a mirrored phone
  - pushing theme and motion tokens into webviews
  - abort signals for `ctx.eval` / `ctx.sandbox`
  - `workspace.stat`
  - localized names for subagents, templates and packs
