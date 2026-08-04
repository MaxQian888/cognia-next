/**
 * Keep Character Pack `requires` warnings fresh when their sources change.
 *
 * `refreshAllPackWarnings()` is a **push** model, not a subscription: each
 * dependency source calls it after mutating. Declarative skills, MCP presets,
 * and native tools push from `lib/plugin/contracts/capability-bridge-map.ts`;
 * their imperative context APIs push directly after registration. Connectors
 * and providers push from their own bridges.
 *
 * Theme packs are the exception. They are bespoke-wired (not in
 * `OVERLAY_REGISTRY_CAPABILITIES`) but they *do* expose a subscription, so this
 * module adapts one to the other. It deliberately lives on the character-pack
 * side: calling `refreshAllPackWarnings` from inside `lib/theme` would make the
 * theme subsystem depend on the plugin subsystem for a concern it does not own.
 */

import { subscribeThemePackRegistry } from "@/lib/theme/theme-pack-registry"

import { refreshAllPackWarnings } from "@/lib/plugin/registries/character-pack-registry"

let installed: (() => void) | null = null

/**
 * Subscribe pack-warning refresh to theme-pack registry changes.
 *
 * Idempotent: a second call returns the existing teardown rather than stacking
 * a duplicate subscription, so a React StrictMode double-effect cannot make
 * every theme change refresh twice.
 */
export function installPackWarningRefreshWiring(): () => void {
  if (installed) return installed

  const unsubscribeThemePacks = subscribeThemePackRegistry(() => {
    refreshAllPackWarnings()
  })

  const teardown = () => {
    unsubscribeThemePacks()
    installed = null
  }
  installed = teardown
  return teardown
}

export function __resetPackWarningRefreshWiringForTesting(): void {
  installed?.()
  installed = null
}
