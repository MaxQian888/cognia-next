// Nav shape for the Subagents section's master/detail layout, replacing the
// long single-column scroll (two bordered policy blobs stacked above a
// `templates | runtime` tab strip). Split out of `subagents-section.tsx` so
// `SubagentsNav` can type against it without importing the section back.
// Mirrors `../appearance/nav-config.ts`, the house pattern.
//
// Unlike Appearance, this nav is part static and part dynamic: two policy
// panels and the runtime monitor are fixed, while the template and plugin
// entries are built from live data (the runtime store and the plugin overlay
// registry). Panel ids are therefore a union of literals and two namespaced
// forms, `template:<id>` / `plugin:<runtimeId>`.
//
// The two policy cards stay SEPARATE panels rather than merging into one:
// `use-setting-focus` resolves `?focus=` by querying a `[data-setting-id]`
// anchor, and one panel per registered finder control is what keeps that
// deep link landing on the exact card instead of a scroll-to that misses.

import {
  ActivityIcon,
  BoxesIcon,
  LayersIcon,
  PuzzleIcon,
  TimerIcon,
  UserRoundIcon,
} from "lucide-react"
import type { ComponentType } from "react"

/** Panels that always exist, regardless of what the user has authored. */
export type SubagentStaticPanelId = "runtime" | "nesting" | "background"

/** Every addressable right-pane target. */
export type SubagentPanelId = SubagentStaticPanelId | `template:${string}` | `plugin:${string}`

export type SubagentNavGroupId =
  "runtimeGroup" | "policyGroup" | "builtinGroup" | "userGroup" | "pluginGroup"

export interface SubagentNavStaticItem {
  id: SubagentStaticPanelId
  icon: ComponentType<{ className?: string }>
}

export interface SubagentNavStaticGroup {
  id: Extract<SubagentNavGroupId, "runtimeGroup" | "policyGroup">
  items: readonly SubagentNavStaticItem[]
}

/**
 * A rendered nav row for a dynamic entity. The section builds these from the
 * template store / plugin registry; the nav component stays presentational.
 */
export interface SubagentNavEntityItem {
  panelId: SubagentPanelId
  /** Display name. */
  label: string
  /** Secondary line — description, plugin id, or category. */
  description?: string
  /** Single character rendered in the round avatar (also the flight source). */
  glyph: string
  /** Excluded from dispatch entirely. */
  disabled?: boolean
  /** Dispatchable but hidden from pickers / @-mention. */
  hidden?: boolean
}

export interface SubagentNavEntityGroup {
  id: Extract<SubagentNavGroupId, "builtinGroup" | "userGroup" | "pluginGroup">
  items: readonly SubagentNavEntityItem[]
}

export const SUBAGENT_STATIC_GROUPS: readonly SubagentNavStaticGroup[] = [
  { id: "runtimeGroup", items: [{ id: "runtime", icon: ActivityIcon }] },
  {
    id: "policyGroup",
    items: [
      { id: "nesting", icon: LayersIcon },
      { id: "background", icon: TimerIcon },
    ],
  },
]

/** Icons for the dynamic groups' headers. */
export const SUBAGENT_ENTITY_GROUP_ICONS: Record<
  SubagentNavEntityGroup["id"],
  ComponentType<{ className?: string }>
> = {
  builtinGroup: BoxesIcon,
  userGroup: UserRoundIcon,
  pluginGroup: PuzzleIcon,
}

const STATIC_PANEL_IDS = new Set<string>(
  SUBAGENT_STATIC_GROUPS.flatMap((group) => group.items.map((item) => item.id))
)

/** Build the panel id addressing a user/built-in template. */
export function templatePanelId(templateId: string): SubagentPanelId {
  return `template:${templateId}`
}

/** Build the panel id addressing a plugin-contributed subagent. */
export function pluginPanelId(runtimeId: string): SubagentPanelId {
  return `plugin:${runtimeId}`
}

export type ParsedPanel =
  | { kind: "static"; id: SubagentStaticPanelId }
  | { kind: "template"; id: string }
  | { kind: "plugin"; id: string }

/** Split a panel id back into its kind and underlying entity id. */
export function parsePanelId(panel: SubagentPanelId): ParsedPanel {
  if (panel.startsWith("template:")) {
    return { kind: "template", id: panel.slice("template:".length) }
  }
  if (panel.startsWith("plugin:")) {
    return { kind: "plugin", id: panel.slice("plugin:".length) }
  }
  return { kind: "static", id: panel as SubagentStaticPanelId }
}

/**
 * Live entity ids the resolver may address. Passed in rather than read from
 * the store so the resolver stays a pure function the tests can drive.
 */
export interface SubagentPanelContext {
  /** Template ids in the order the nav renders them. */
  templateIds: readonly string[]
  /** Plugin subagent runtime ids (`<pluginId>:<defId>`). */
  pluginIds: readonly string[]
}

/**
 * Pre-master/detail `?subagentTab=` values. `templates` named the whole tab,
 * which is now the nav's template groups rather than one panel — so it lands
 * on the first template, the closest honest equivalent. `runtime` still names
 * a real panel and passes straight through.
 */
const LEGACY_TAB_VALUES = new Set(["templates", "runtime"])

/** Where the section lands when the URL says nothing usable. */
export const FALLBACK_SUBAGENT_PANEL: SubagentStaticPanelId = "nesting"

/**
 * Resolve a raw `?subagentTab=` value: legacy alias → static panel → live
 * entity → fallback. A link to a template the user has since deleted (or a
 * plugin they disabled) degrades to the first template rather than rendering
 * an empty pane.
 */
export function resolveSubagentPanel(
  raw: string | null,
  ctx: SubagentPanelContext
): SubagentPanelId {
  const firstTemplate = ctx.templateIds[0]
  const defaultPanel: SubagentPanelId = firstTemplate
    ? templatePanelId(firstTemplate)
    : FALLBACK_SUBAGENT_PANEL

  if (!raw) return defaultPanel
  if (LEGACY_TAB_VALUES.has(raw)) {
    return raw === "runtime" ? "runtime" : defaultPanel
  }
  if (STATIC_PANEL_IDS.has(raw)) return raw as SubagentPanelId

  const parsed = parsePanelId(raw as SubagentPanelId)
  if (parsed.kind === "template" && ctx.templateIds.includes(parsed.id)) {
    return raw as SubagentPanelId
  }
  if (parsed.kind === "plugin" && ctx.pluginIds.includes(parsed.id)) {
    return raw as SubagentPanelId
  }
  return defaultPanel
}

/**
 * Map a settings-finder control id (`?focus=`) to the panel that owns its
 * `data-setting-id` anchor. Without this the finder's jump to
 * `subagent-nesting` would silently degrade the moment those cards stopped
 * being always-mounted — `use-setting-focus` gives up after 20 × 60ms and
 * clears the param without highlighting.
 */
const FOCUS_TO_PANEL: Record<string, SubagentStaticPanelId> = {
  "subagent-nesting": "nesting",
  "subagent-background-tasks": "background",
}

export function panelForFocusId(focus: string | null): SubagentStaticPanelId | null {
  if (!focus) return null
  return FOCUS_TO_PANEL[focus] ?? null
}
