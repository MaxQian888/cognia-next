/**
 * The dock's view of which panels exist right now.
 *
 * Wraps `contextPanelRegistry` rather than replacing it. Plugin panels already
 * register there, `lib/plugin/core/manager.ts` already tears them down there on
 * disable/uninstall, and `permission-api` already calls `refresh()` there when
 * a grant changes. A second registry would mean a second teardown path to keep
 * in sync — and the one that got forgotten would leave the dock rendering a
 * panel whose plugin is gone.
 *
 * What this module adds is the merge with the host's own inline panels (native
 * panels are passed as props, exactly as `ContextWorkbench` takes them) and the
 * metadata derivation, so the rest of the kernel only ever sees
 * `ResolvedDockPanel`.
 */

import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { resolveDockPanel } from "./derive-panel-metadata"
import { contextActivityRailIndex, type ContextResource } from "@/types/context-workbench"
import type { DockPanelDefinition, ResolvedDockPanel } from "@/types/dock/panel"

export interface ResolveDockPanelsInput {
  resource: ContextResource
  /** The host's own panels. Win on an id collision with a plugin's. */
  native: readonly DockPanelDefinition[]
  /** Injectable for tests; defaults to the shared context panel registry. */
  registry?: Pick<typeof contextPanelRegistry, "resolve">
}

/**
 * Panels applicable to `resource`, in rail order, with metadata derived.
 *
 * Native panels win an id collision for the same reason `mergePanels` in the
 * Context Workbench gives them precedence: a plugin must not be able to shadow
 * a first-party surface by claiming its id.
 */
export function resolveDockPanels(input: ResolveDockPanelsInput): ResolvedDockPanel[] {
  const registry = input.registry ?? contextPanelRegistry
  const byId = new Map<string, DockPanelDefinition>()

  for (const definition of registry.resolve(input.resource)) {
    byId.set(definition.id, definition as DockPanelDefinition)
  }
  for (const definition of input.native) {
    if (!definition.appliesTo(input.resource)) continue
    byId.set(definition.id, definition)
  }

  return [...byId.values()]
    .sort(compareDockPanels)
    .map((definition) => resolveDockPanel(definition))
}

/** Rail group first, then the panel's own order, then id for a stable tie-break. */
function compareDockPanels(a: DockPanelDefinition, b: DockPanelDefinition): number {
  const rail = contextActivityRailIndex(a.activity) - contextActivityRailIndex(b.activity)
  if (rail !== 0) return rail
  const order = (a.order ?? 100) - (b.order ?? 100)
  if (order !== 0) return order
  return a.id.localeCompare(b.id)
}

/** Index resolved panels by id — the shape the reveal planner consumes. */
export function indexDockPanels(
  panels: readonly ResolvedDockPanel[]
): Map<string, ResolvedDockPanel> {
  return new Map(panels.map((panel) => [panel.definition.id, panel]))
}

/**
 * Subscribe to anything that changes which panels resolve: a plugin loading or
 * unloading, a permission grant, a badge push. The dock re-resolves on every
 * tick rather than diffing — the panel set is small and a missed invalidation
 * is a panel that renders after its plugin is gone.
 */
export function subscribeDockPanels(listener: () => void): () => void {
  return contextPanelRegistry.subscribe(listener)
}

export function getDockPanelsRevision(): number {
  return contextPanelRegistry.getRevision()
}
