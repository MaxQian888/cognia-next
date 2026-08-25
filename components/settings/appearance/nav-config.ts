// Nav shape for the Appearance section. Split out of `appearance-section.tsx`
// so `AppearanceNav` can type against it without importing the section back.
//
// Eleven tabs became ten entries in three groups. Two merges, both semantic:
// `themePack` + `import` are the two ways to acquire a theme you didn't write
// ("library"); `typography` + `layout` are what you tune together, and
// `layout` alone was two controls. `personalization` and `plugins` are new
// homes for things that used to hang off the bottom of the section with no
// nav entry at all.

import {
  AccessibilityIcon,
  BlocksIcon,
  ImageIcon,
  MousePointer2Icon,
  PackageIcon,
  PaintbrushIcon,
  PaletteIcon,
  PuzzleIcon,
  ShapesIcon,
  SunMoonIcon,
  TypeIcon,
  UserRoundIcon,
  WrenchIcon,
} from "lucide-react"
import type { ComponentType } from "react"

export type AppearancePanelId =
  | "style"
  | "theme"
  | "auto"
  | "custom"
  | "library"
  | "wallpaper"
  | "typography"
  | "components"
  | "cursor"
  | "personalization"
  | "a11y"
  | "advanced"
  | "plugins"

export type AppearanceNavGroupId = "themeGroup" | "interfaceGroup" | "advancedGroup"

export interface AppearanceNavItem {
  id: AppearancePanelId
  icon: ComponentType<{ className?: string }>
}

export interface AppearanceNavGroup {
  id: AppearanceNavGroupId
  items: readonly AppearanceNavItem[]
}

// Group ids are suffixed so `nav.groups.themeGroup` never reads as
// `nav.items.theme` at a glance.
export const APPEARANCE_NAV_GROUPS: readonly AppearanceNavGroup[] = [
  {
    id: "themeGroup",
    items: [
      // ADR-0148 — shape before colour: the pack decides what every other
      // control in this section is tuning.
      { id: "style", icon: ShapesIcon },
      { id: "theme", icon: PaletteIcon },
      { id: "auto", icon: SunMoonIcon },
      { id: "custom", icon: PaintbrushIcon },
      { id: "library", icon: PackageIcon },
    ],
  },
  {
    id: "interfaceGroup",
    items: [
      { id: "wallpaper", icon: ImageIcon },
      { id: "typography", icon: TypeIcon },
      { id: "components", icon: BlocksIcon },
      { id: "cursor", icon: MousePointer2Icon },
      { id: "personalization", icon: UserRoundIcon },
    ],
  },
  {
    id: "advancedGroup",
    items: [
      { id: "a11y", icon: AccessibilityIcon },
      { id: "advanced", icon: WrenchIcon },
      { id: "plugins", icon: PuzzleIcon },
    ],
  },
]

const PANEL_IDS = new Set<string>(
  APPEARANCE_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id))
)

/**
 * Panel id → icon, derived from the groups above rather than declared twice.
 * The detail header renders the active panel's icon beside its label, and it
 * must be the same glyph the nav entry shows or the two read as unrelated.
 */
export const APPEARANCE_PANEL_ICONS = Object.fromEntries(
  APPEARANCE_NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.icon]))
) as Record<AppearancePanelId, ComponentType<{ className?: string }>>

/**
 * Old `?appearanceTab=` values that no longer name a panel. Deep links from
 * before the merge keep working; the URL is left as-is rather than rewritten,
 * which would cost an effect and a history entry for no user-visible gain.
 */
const LEGACY_PANEL_ALIASES: Record<string, AppearancePanelId> = {
  themePack: "library",
  import: "library",
  layout: "typography",
}

export const DEFAULT_APPEARANCE_PANEL: AppearancePanelId = "theme"

/**
 * Resolve a raw `?appearanceTab=` value: alias → validity → plugin gate →
 * default. `plugins` is only reachable while something contributes to the
 * slot, so a stale link to it lands on the default rather than an empty panel.
 */
export function resolveAppearancePanel(
  raw: string | null,
  pluginsAvailable: boolean
): AppearancePanelId {
  const mapped = (raw && LEGACY_PANEL_ALIASES[raw]) ?? raw
  if (!mapped || !PANEL_IDS.has(mapped)) return DEFAULT_APPEARANCE_PANEL
  if (mapped === "plugins" && !pluginsAvailable) return DEFAULT_APPEARANCE_PANEL
  return mapped as AppearancePanelId
}
