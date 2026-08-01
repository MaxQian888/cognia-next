/**
 * A materialised panel in a dock layout.
 *
 * The dock addresses panels by a stable `instanceId`, not by panel id: the same
 * panel kind can be open twice (two files, two artifacts), and the same logical
 * instance has to survive being dragged into another group — or, later, another
 * window — without its identity changing. Panel id alone cannot express either.
 */

import type { ContextResource } from "@/types/context-workbench"
import type { DockPanelKind } from "./panel"

/** Which resource, if any, this instance is bound to. */
export interface DockResourceRef {
  /** `getContextResourceKey(resource)` — stable across re-reads of the resource. */
  key: string
  kind: ContextResource["kind"]
}

/**
 * Whether a tab is the group's single reusable preview slot or permanent.
 * Same semantics as `lib/editor-workbench/editor-tab-model`, applied to dock
 * tabs rather than only the project editor's strip.
 */
export type DockTabMode = "preview" | "pinned"

export interface DockPanelInstance {
  /** Stable, unique within an account. Never reused after the instance closes. */
  instanceId: string
  /** The `ContextPanelDefinition.id` this instance renders. */
  panelId: string
  kind: DockPanelKind
  /** Set for `multi-instance` panels; absent for functional singletons. */
  resource?: DockResourceRef
  mode: DockTabMode
  /**
   * Whether the instance has unsaved work. The dock never owns the buffer — it
   * reads this to decide whether closing, replacing or migrating the tab needs
   * a confirmation.
   */
  dirty: boolean
  /**
   * Set once the panel has been activated at least once, so a restore calls
   * `onRestore` rather than re-running `onFirstActivate`.
   */
  activated: boolean
  /** Unread count shown on the tab; a reveal the user did not act on. */
  unread?: number
}

/** Identity key used to find an existing instance for a reveal request. */
export function dockInstanceMatchKey(panelId: string, resourceKey?: string): string {
  return resourceKey ? `${panelId}@${resourceKey}` : panelId
}

/** The match key of an existing instance. */
export function dockInstanceKeyOf(instance: DockPanelInstance): string {
  return dockInstanceMatchKey(instance.panelId, instance.resource?.key)
}
