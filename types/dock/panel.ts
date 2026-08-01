/**
 * The unified dock's panel contract.
 *
 * This is a *superset* of `ContextPanelDefinition` (ADR-0083), not a
 * replacement: every panel already declared for the Context Workbench stays
 * assignable to `DockPanelDefinition` unchanged, and `deriveDockPanelMetadata`
 * fills in what the dock needs from the fields those definitions already carry.
 * That is what makes migrating a host a swap of the shell rather than a rewrite
 * of its nine panel definitions.
 *
 * The extra metadata is nested under `dock` rather than flattened onto the
 * definition because `scope` and `retention` are already narrowed unions on the
 * parent type — re-declaring them in an `extends` is a TS2430 error, and
 * widening them on the parent would weaken every existing call site.
 */

import type {
  ContextCapability,
  ContextPanelDefinition,
  ContextPanelRetention,
} from "@/types/context-workbench"

/**
 * How a panel behaves in the dock. Deliberately a *behavioural* classification
 * rather than a catalogue of every panel that exists — each member changes what
 * the kernel does, and a value nothing branches on does not belong here.
 */
export type DockPanelKind =
  /**
   * Backed by a native webview positioned over the DOM by pushed rects (the
   * embedded browser, the Pro IDE pane). Process-wide singleton, animation must
   * be suppressed around it, and it cannot live in a floating or popout group.
   */
  | "native-surface"
  /** A text buffer with preview/pinned tab semantics and a dirty state. */
  | "editor"
  /** Contributed by a plugin; disappears when that plugin is disabled. */
  | "plugin-surface"
  /** Everything else — an ordinary first-party tool panel. */
  | "panel"

/** Where in the dock topology a panel is allowed to be. */
export type DockPanelLocation = "grid" | "floating" | "popout"

export const ALL_DOCK_PANEL_LOCATIONS: readonly DockPanelLocation[] = ["grid", "floating", "popout"]

/** Native surfaces are pinned to the main grid; see `DockPanelKind`. */
export const GRID_ONLY_DOCK_PANEL_LOCATIONS: readonly DockPanelLocation[] = ["grid"]

/**
 * How many live instances of a panel may exist, and over what scope.
 *
 * - `singleton-global` — one instance in the whole application. The only honest
 *   policy for a panel bound to a process-wide native resource: two "stateful"
 *   browser panels still cannot coexist, because there is one webview lease.
 * - `singleton-per-context` — one instance per dock context (a chat session, a
 *   project, a document). The normal policy for a functional tool panel.
 * - `multi-instance` — a resource panel; one instance per resource, several at
 *   once (open files, artifacts).
 */
export type DockSingletonPolicy = "singleton-global" | "singleton-per-context" | "multi-instance"

export interface DockPanelMinSize {
  width?: number
  height?: number
}

/** The fully-resolved dock metadata for a panel. No optional behaviour left. */
export interface DockPanelMetadata {
  kind: DockPanelKind
  singletonPolicy: DockSingletonPolicy
  retention: ContextPanelRetention
  allowedLocations: readonly DockPanelLocation[]
  minSize?: DockPanelMinSize
  /** Permissions the panel was registered against. Diagnostics, not the gate. */
  permissions: readonly string[]
  capabilities: readonly ContextCapability[]
}

/**
 * A Context Workbench panel plus optional dock metadata. Omitting `dock`
 * entirely is the supported case — the kernel derives every field.
 */
export interface DockPanelDefinition extends ContextPanelDefinition {
  dock?: Partial<Omit<DockPanelMetadata, "kind">> & { kind: DockPanelKind }
}

/** A panel that resolved for the current resource, with its metadata settled. */
export interface ResolvedDockPanel {
  definition: DockPanelDefinition
  meta: DockPanelMetadata
}

/** Does this panel own a native webview positioned over the DOM? */
export function isNativeSurfacePanel(meta: DockPanelMetadata): boolean {
  return meta.kind === "native-surface"
}

/** May this panel be moved to `location`? */
export function isLocationAllowed(meta: DockPanelMetadata, location: DockPanelLocation): boolean {
  return meta.allowedLocations.includes(location)
}
