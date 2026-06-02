// Registry describing the curated set of customizable surface components. Pure
// data — both the `ComponentStyleApplier` (to generate CSS) and the
// "Components" appearance tab (to render controls) read from this single source
// of truth, so a slot rename or a new component is a one-line change here.

import type { ComponentStyleKey } from "@/types/appearance"

/**
 * `inline` surfaces live inside a `[data-bg-target]` subtree and only paint the
 * wallpaper for the active scope — their tonality selectors need the extra
 * `[data-bg-target]` descendant step (mirrors the wallpaper-aware rules in
 * globals.css §2). `portaled` surfaces (Radix portals to `document.body`) sit
 * over the wallpaper only when scope is `all`/`global`, so they key off `body`
 * directly (globals.css §3).
 */
export type ComponentPlacement = "inline" | "portaled"

/** Visual grouping for the settings UI. */
export type ComponentStyleGroup = "surfaces" | "overlays" | "modals" | "chat"

export interface ComponentStyleEntry {
  key: ComponentStyleKey
  /** `data-slot` values this component paints. */
  slots: string[]
  placement: ComponentPlacement
  /**
   * The CSS color variable the surface mixes into for translucency. Matches the
   * base colour the component uses today (Card → `--card`, Popover → `--popover`,
   * Dialog → `--background`, Tooltip → `--foreground`, …).
   */
  baseVar: string
  group: ComponentStyleGroup
  /** i18n key under `settings.appearance.componentCustomize.items`. */
  labelKey: ComponentStyleKey
  /**
   * Optional ancestor selector inserted immediately before the slot, e.g.
   * `.is-user`. Lets a slot that paints conditionally (the chat message bubble
   * only carries `bg-secondary` on the user side) be targeted precisely:
   * `… [data-bg-target] .is-user [data-slot="ai-message-content"]`. Without it
   * the override would also paint the normally-transparent assistant bubble.
   */
  within?: string
}

export const COMPONENT_STYLE_REGISTRY: ComponentStyleEntry[] = [
  // ── Surfaces (inline) ─────────────────────────────────────────────────────
  {
    key: "card",
    slots: ["card"],
    placement: "inline",
    baseVar: "--card",
    group: "surfaces",
    labelKey: "card",
  },
  {
    key: "alert",
    slots: ["alert"],
    placement: "inline",
    baseVar: "--card",
    group: "surfaces",
    labelKey: "alert",
  },
  {
    key: "tabs",
    slots: ["tabs-list"],
    placement: "inline",
    baseVar: "--muted",
    group: "surfaces",
    labelKey: "tabs",
  },
  {
    key: "menubar",
    slots: ["menubar"],
    placement: "inline",
    baseVar: "--background",
    group: "surfaces",
    labelKey: "menubar",
  },
  {
    key: "sidebar",
    slots: ["sidebar-inner"],
    placement: "inline",
    baseVar: "--sidebar",
    group: "surfaces",
    labelKey: "sidebar",
  },
  {
    key: "table",
    slots: ["table-container"],
    placement: "inline",
    baseVar: "--card",
    group: "surfaces",
    labelKey: "table",
  },
  // ── Overlays (portaled) ───────────────────────────────────────────────────
  {
    key: "popover",
    slots: ["popover-content"],
    placement: "portaled",
    baseVar: "--popover",
    group: "overlays",
    labelKey: "popover",
  },
  {
    key: "dropdownMenu",
    slots: ["dropdown-menu-content", "dropdown-menu-sub-content"],
    placement: "portaled",
    baseVar: "--popover",
    group: "overlays",
    labelKey: "dropdownMenu",
  },
  {
    key: "contextMenu",
    slots: ["context-menu-content", "context-menu-sub-content"],
    placement: "portaled",
    baseVar: "--popover",
    group: "overlays",
    labelKey: "contextMenu",
  },
  {
    key: "select",
    slots: ["select-content"],
    placement: "portaled",
    baseVar: "--popover",
    group: "overlays",
    labelKey: "select",
  },
  {
    key: "combobox",
    slots: ["combobox-content"],
    placement: "portaled",
    baseVar: "--popover",
    group: "overlays",
    labelKey: "combobox",
  },
  {
    key: "hoverCard",
    slots: ["hover-card-content"],
    placement: "portaled",
    baseVar: "--popover",
    group: "overlays",
    labelKey: "hoverCard",
  },
  {
    key: "command",
    slots: ["command"],
    placement: "portaled",
    baseVar: "--popover",
    group: "overlays",
    labelKey: "command",
  },
  {
    key: "navigationMenu",
    slots: ["navigation-menu-viewport"],
    placement: "portaled",
    baseVar: "--popover",
    group: "overlays",
    labelKey: "navigationMenu",
  },
  {
    key: "tooltip",
    slots: ["tooltip-content"],
    placement: "portaled",
    baseVar: "--foreground",
    group: "overlays",
    labelKey: "tooltip",
  },
  // ── Modals (portaled) ─────────────────────────────────────────────────────
  {
    key: "dialog",
    slots: ["dialog-content"],
    placement: "portaled",
    baseVar: "--background",
    group: "modals",
    labelKey: "dialog",
  },
  {
    key: "alertDialog",
    slots: ["alert-dialog-content"],
    placement: "portaled",
    baseVar: "--background",
    group: "modals",
    labelKey: "alertDialog",
  },
  {
    key: "sheet",
    slots: ["sheet-content"],
    placement: "portaled",
    baseVar: "--background",
    group: "modals",
    labelKey: "sheet",
  },
  {
    key: "drawer",
    slots: ["drawer-content"],
    placement: "portaled",
    baseVar: "--background",
    group: "modals",
    labelKey: "drawer",
  },
  // ── Chat surfaces (ai-elements, inline) ───────────────────────────────────
  // baseVar matches the colour the component paints today; the matching default
  // wallpaper-aware rules live in globals.css §4c. `aiMessage` carries
  // `within: ".is-user"` so only the user bubble (which has `bg-secondary`) is
  // affected, never the transparent assistant message.
  {
    key: "aiMessage",
    slots: ["ai-message-content"],
    placement: "inline",
    baseVar: "--secondary",
    group: "chat",
    labelKey: "aiMessage",
    within: ".is-user",
  },
  {
    key: "aiTool",
    slots: ["ai-tool"],
    placement: "inline",
    baseVar: "--card",
    group: "chat",
    labelKey: "aiTool",
  },
  {
    key: "aiArtifact",
    slots: ["ai-artifact"],
    placement: "inline",
    baseVar: "--background",
    group: "chat",
    labelKey: "aiArtifact",
  },
  {
    key: "aiCodeBlock",
    slots: ["ai-code-block"],
    placement: "inline",
    baseVar: "--background",
    group: "chat",
    labelKey: "aiCodeBlock",
  },
  // aiContext's footer lives inside the HoverCard, which Radix portals to
  // document.body — so it is `portaled` (visible over the wallpaper only when
  // scope is all/global), like the `hoverCard` overlay that wraps it.
  {
    key: "aiContext",
    slots: ["ai-context"],
    placement: "portaled",
    baseVar: "--secondary",
    group: "chat",
    labelKey: "aiContext",
  },
  {
    key: "aiTask",
    slots: ["ai-task"],
    placement: "inline",
    baseVar: "--secondary",
    group: "chat",
    labelKey: "aiTask",
  },
  {
    key: "aiErrorTrace",
    slots: ["ai-error-trace"],
    placement: "inline",
    baseVar: "--card",
    group: "chat",
    labelKey: "aiErrorTrace",
  },
  {
    key: "aiConversation",
    slots: ["ai-conversation"],
    placement: "inline",
    baseVar: "--background",
    group: "chat",
    labelKey: "aiConversation",
  },
  {
    key: "aiTerminal",
    slots: ["ai-terminal"],
    placement: "inline",
    baseVar: "--terminal-surface",
    group: "chat",
    labelKey: "aiTerminal",
  },
]

/** Lookup by key. */
export const COMPONENT_STYLE_BY_KEY: Record<ComponentStyleKey, ComponentStyleEntry> =
  Object.fromEntries(COMPONENT_STYLE_REGISTRY.map((e) => [e.key, e])) as Record<
    ComponentStyleKey,
    ComponentStyleEntry
  >

export const COMPONENT_STYLE_GROUPS: ComponentStyleGroup[] = [
  "surfaces",
  "overlays",
  "modals",
  "chat",
]
