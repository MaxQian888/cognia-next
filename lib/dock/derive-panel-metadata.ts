/**
 * Fill in a panel's dock metadata from what its Context Workbench definition
 * already declares.
 *
 * This is what makes the chat host's nine inline panel definitions migrate
 * without an edit: none of them carries a `dock` bag, and none needs to. The
 * derivation is intentionally conservative — every default reproduces what the
 * Context Workbench does today, so a panel that has not opted in behaves
 * identically before and after the dock kernel takes over its host.
 *
 * The one place that is *not* a pass-through is `native-surface`: a panel bound
 * to a process-wide webview lease has to be a global singleton pinned to the
 * grid, and no amount of `retention: "stateful"` changes that. Those panels
 * declare `dock: { kind: "native-surface" }` explicitly.
 */

import {
  ALL_DOCK_PANEL_LOCATIONS,
  GRID_ONLY_DOCK_PANEL_LOCATIONS,
  type DockPanelDefinition,
  type DockPanelKind,
  type DockPanelMetadata,
  type DockSingletonPolicy,
  type ResolvedDockPanel,
} from "@/types/dock/panel"

/**
 * `ContextPanelDefinition.retention` is optional and the Context Workbench
 * treats "absent" as stateful — it only unmounts on an explicit `"ephemeral"`.
 * Reproducing that default here is load-bearing: flipping it would silently
 * start dropping panel state on every tab switch.
 */
const DEFAULT_RETENTION = "stateful" as const

function deriveKind(definition: DockPanelDefinition): DockPanelKind {
  if (definition.dock?.kind) return definition.dock.kind
  return definition.pluginId ? "plugin-surface" : "panel"
}

function deriveSingletonPolicy(
  definition: DockPanelDefinition,
  kind: DockPanelKind
): DockSingletonPolicy {
  if (definition.dock?.singletonPolicy) return definition.dock.singletonPolicy
  // One webview, one lease, one instance — regardless of how many contexts are
  // open. See `DockPanelKind`.
  if (kind === "native-surface") return "singleton-global"
  // An editor addresses a specific buffer, so several may coexist.
  if (kind === "editor") return "multi-instance"
  // Everything else stays one-per-context, which is exactly what the Context
  // Workbench does today (one active panel per scope). A host opts a panel into
  // `multi-instance` as it migrates and decides that panel is resource-bound —
  // the definition alone cannot tell us, since every panel gates on `appliesTo`.
  return "singleton-per-context"
}

function deriveLocations(
  definition: DockPanelDefinition,
  kind: DockPanelKind
): readonly DockPanelMetadata["allowedLocations"][number][] {
  if (definition.dock?.allowedLocations) return definition.dock.allowedLocations
  return kind === "native-surface" ? GRID_ONLY_DOCK_PANEL_LOCATIONS : ALL_DOCK_PANEL_LOCATIONS
}

/** Settle every optional field into the metadata the kernel branches on. */
export function deriveDockPanelMetadata(definition: DockPanelDefinition): DockPanelMetadata {
  const kind = deriveKind(definition)
  return {
    kind,
    singletonPolicy: deriveSingletonPolicy(definition, kind),
    retention: definition.dock?.retention ?? definition.retention ?? DEFAULT_RETENTION,
    allowedLocations: deriveLocations(definition, kind),
    minSize: definition.dock?.minSize,
    permissions: definition.dock?.permissions ?? definition.requiredPermissions ?? [],
    capabilities: definition.dock?.capabilities ?? definition.requiredCapabilities ?? [],
  }
}

/** Pair a definition with its derived metadata. */
export function resolveDockPanel(definition: DockPanelDefinition): ResolvedDockPanel {
  return { definition, meta: deriveDockPanelMetadata(definition) }
}
