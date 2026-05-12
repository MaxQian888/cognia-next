/**
 * GitHub Delivery — built-in plugin entry point.
 *
 * The plugin's responsibilities split across 5 surfaces:
 *
 *   1. Setup wizard for App + PAT credentials (M1) — invoked via the
 *      Settings → GitHub Delivery tab.
 *   2. ConnectorBus adapter routing PR / Issue events into the inbox (M4).
 *   3. Workflow nodes (12 × action.github.*) registered against the visual
 *      workflow runtime (M3).
 *   4. Webhook trigger (trigger.github.webhook) + polling task
 *      (github-poll) routed through the Rust signature verifier (M2).
 *   5. Independent kanban page at /github-delivery (M4).
 *
 * In M1 the entry only:
 *   - Creates the four Dexie tables via `ctx.dexie!.table(...)` lazy access.
 *   - Logs activation. Functional registration lands in M2/M3/M4.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import type { GhAuditEntry, GhRepoEntry, GhWorkOrder, NormalizedGhEvent } from "@/lib/github/types"

interface ActivationState {
  activatedAt: number
}

let state: ActivationState | null = null

const definition: PluginDefinition = {
  manifest: {
    id: "github-delivery",
    name: "GitHub Delivery",
    version: "1.0.0",
    type: "frontend",
    capabilities: ["tools", "components", "providers", "exporters"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx?: PluginContext) => {
    if (!ctx) throw new Error("github-delivery: ctx is required")
    if (!ctx.dexie) {
      throw new Error("github-delivery requires the platform Dexie API (manifest.dexie missing?)")
    }

    // Touch each declared table to surface mis-declared schemas at activation
    // rather than at first use. Dexie .toCollection().count() is cheap.
    const repos = ctx.dexie.table<GhRepoEntry>("repos")
    const workOrders = ctx.dexie.table<GhWorkOrder>("workOrders")
    const events = ctx.dexie.table<NormalizedGhEvent>("events")
    const audit = ctx.dexie.table<GhAuditEntry>("audit")
    await Promise.all([
      repos.toCollection().count(),
      workOrders.toCollection().count(),
      events.toCollection().count(),
      audit.toCollection().count(),
    ])

    state = { activatedAt: Date.now() }
    ctx.logger?.info("github-delivery: activated")
  },
  deactivate: async (ctx?: PluginContext) => {
    state = null
    ctx?.logger?.info("github-delivery: deactivated")
  },
}

export default definition

/** Test-only — peek at activation state without touching internals. */
export function _peekState(): ActivationState | null {
  return state
}
