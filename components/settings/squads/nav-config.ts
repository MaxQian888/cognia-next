/**
 * Addressing for the Squads settings section.
 *
 * Two levels below `?section=squads`: a static Templates panel, and one panel
 * per Squad. Modelled on `components/settings/subagents/nav-config.ts`, which
 * is the house pattern for a settings section that owns a list of entities —
 * including the part that matters most, a resolver that degrades a link to a
 * deleted entity into a real panel instead of an empty pane.
 *
 * Kept as pure functions so the resolution rules are testable without the
 * store, the router, or a rendered rail.
 */

import type { ComponentType } from "react"
import { LayoutTemplateIcon, UsersIcon } from "lucide-react"

/** Panels that exist regardless of what the user has created. */
export type SquadStaticPanelId = "templates"

/** Every addressable right-pane target. */
export type SquadPanelId = SquadStaticPanelId | `squad:${string}`

/** The query parameter this section owns, alongside `?section=squads`. */
export const SQUAD_TAB_PARAM = "squadTab"

export const SQUAD_STATIC_PANELS: ReadonlyArray<{
  id: SquadStaticPanelId
  icon: ComponentType<{ className?: string }>
}> = [{ id: "templates", icon: LayoutTemplateIcon }]

export const SQUAD_ENTITY_ICON: ComponentType<{ className?: string }> = UsersIcon

const STATIC_IDS = new Set<string>(SQUAD_STATIC_PANELS.map((panel) => panel.id))

/** Build the panel id addressing one Squad. */
export function squadPanelId(squadId: string): SquadPanelId {
  return `squad:${squadId}`
}

export type ParsedSquadPanel =
  { kind: "static"; id: SquadStaticPanelId } | { kind: "squad"; id: string }

export function parseSquadPanelId(panel: SquadPanelId): ParsedSquadPanel {
  if (panel.startsWith("squad:")) return { kind: "squad", id: panel.slice("squad:".length) }
  return { kind: "static", id: panel as SquadStaticPanelId }
}

/**
 * Live ids the resolver may address. Passed in rather than read from the store
 * so this stays a pure function.
 */
export interface SquadPanelContext {
  squadIds: readonly string[]
}

/** Where an unresolvable link lands. Never an empty pane. */
export const FALLBACK_SQUAD_PANEL: SquadStaticPanelId = "templates"

/**
 * Resolve `?squadTab=` to a panel that actually exists.
 *
 * A link to a Squad that has since been deleted falls through to the first
 * Squad the user still has, and only then to Templates — landing on a
 * neighbour is far more useful than landing on a blank right pane, which is
 * what a naive `?? fallback` produces.
 */
export function resolveSquadPanel(raw: string | null, ctx: SquadPanelContext): SquadPanelId {
  const value = raw?.trim()
  if (value && STATIC_IDS.has(value)) return value as SquadStaticPanelId

  if (value?.startsWith("squad:")) {
    const id = value.slice("squad:".length)
    if (ctx.squadIds.includes(id)) return squadPanelId(id)
    const first = ctx.squadIds[0]
    return first ? squadPanelId(first) : FALLBACK_SQUAD_PANEL
  }

  // No parameter at all: a user with Squads wants to see them, not the
  // template gallery.
  const first = ctx.squadIds[0]
  return first ? squadPanelId(first) : FALLBACK_SQUAD_PANEL
}

/**
 * Map a `?focus=` control id back to the panel that owns its DOM anchor.
 *
 * `use-setting-focus` scrolls to `[data-setting-id]`, which only exists once
 * the owning panel is mounted — so the section has to select the panel first.
 * Returns `null` when the focus id belongs to no Squad panel.
 */
export function squadPanelForFocusId(focus: string | null): SquadStaticPanelId | null {
  if (!focus) return null
  if (focus.startsWith("squad-templates")) return "templates"
  return null
}
