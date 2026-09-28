/**
 * The Go menu, section by section — one table for every surface that lists
 * destinations: the in-app Menubar and the compact hamburger dropdown in
 * `components/desktop/title-bar.tsx` (both through
 * `components/desktop/go-menu-items.tsx`), the command-center caret's curated
 * subset, and the id set `lib/desktop/menu-actions.ts` routes.
 *
 * Derived from the navigation catalog (`SIDEBAR_NAV_META`, which the desktop
 * shell shows in full) plus three destinations the catalog leaves out: the
 * two chat guilds (Chats, Canvas — they switch the rail's guild rather than
 * open a route) and the footer Settings button. {@link GO_MENU_LAYOUT} only
 * decides order and section breaks; labels and icons come from the rail, so
 * the menu and the rail speak one vocabulary (`desktop.guildRail.*`).
 *
 * The native menu (`src-tauri/src/menu.rs:GO_MENU_SECTIONS`) mirrors this
 * table id for id, section for section, with the rail's English labels;
 * `lib/desktop/menu-actions.test.ts` parses the Rust table and fails when the
 * two drift.
 *
 * No Go item carries a keyboard accelerator. ⌘1–⌘7 belong to the workbench
 * activities (`lib/shortcuts/app-catalog.ts`) and a native `CmdOrCtrl+<digit>`
 * accelerator would swallow them before the webview sees the key; pinned rail
 * destinations have ⌥1–⌥9 instead.
 *
 * Pure data plus lucide icon references — no stores, no Tauri — so any
 * component can import it without dragging the menu actions' module graph in.
 */

import { MessagesSquareIcon, PencilRulerIcon, SettingsIcon, type LucideIcon } from "lucide-react"

import { SIDEBAR_NAV_ICONS } from "@/lib/shell/sidebar-nav"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

/**
 * A Go-menu id: `go-<destination>`. A template-literal type rather than a
 * literal union because the catalog's ids are plain `string`s — the set of
 * valid values is {@link GO_MENU_IDS}.
 */
export type GoMenuId = `go-${string}`

/** One Go-menu entry. */
export interface GoMenuItem {
  /** The menu id both the native menu and the in-app menus dispatch. */
  id: GoMenuId
  /** Key under `desktop.guildRail` — the same label the rail shows. */
  labelKey: string
  /** The destination's rail icon. */
  Icon: LucideIcon
}

/**
 * Destinations outside the navigation catalog, keyed by the suffix of their
 * `go-` id. Labels and icons are the ones the rail draws for its DM guild,
 * its Canvas mode and its footer Settings button.
 */
const GO_MENU_EXTRAS: Readonly<Record<string, Omit<GoMenuItem, "id">>> = {
  dms: { labelKey: "directMessages", Icon: MessagesSquareIcon },
  canvas: { labelKey: "canvas", Icon: PencilRulerIcon },
  settings: { labelKey: "settings", Icon: SettingsIcon },
}

/**
 * Order and section breaks, by destination id (a catalog id or a
 * {@link GO_MENU_EXTRAS} key). A separator goes between sections. Every
 * catalog id should appear exactly once — `go-menu.test.ts` pins that — but
 * one that is missing still reaches the menu through
 * {@link resolveGoMenuSections}, so a new rail destination is never
 * unreachable from Go.
 */
export const GO_MENU_LAYOUT: readonly (readonly string[])[] = [
  ["inbox", "workflows", "sites", "twin", "skills", "plugins", "squads", "scheduler", "discover"],
  ["issues", "templates", "goals", "pet", "browser"],
  ["a2ui", "dms", "canvas", "files"],
  [
    "source-control",
    "agent-runs",
    "workspace",
    "memory",
    "servers",
    "integrations",
    "devices",
    "bots",
    "eval",
    "performance",
    "me",
  ],
  ["logs", "settings"],
]

/**
 * Resolve a layout against the catalog. Unknown ids are dropped (a layout
 * entry for a destination that no longer exists must not render a dead
 * item); catalog entries the layout does not place get their own section
 * just before the last one, so they stay reachable until someone files them.
 * Empty sections are dropped. Exported for tests.
 */
export function resolveGoMenuSections(
  layout: readonly (readonly string[])[]
): readonly (readonly GoMenuItem[])[] {
  const catalog = new Map(SIDEBAR_NAV_META.map((meta) => [meta.id, meta]))
  const placed = new Set<string>()
  const resolve = (key: string): GoMenuItem | null => {
    if (placed.has(key)) return null
    const meta = catalog.get(key)
    if (meta) {
      const Icon = SIDEBAR_NAV_ICONS[meta.id]
      if (!Icon) return null
      placed.add(key)
      return { id: `go-${meta.id}`, labelKey: meta.i18nKey, Icon }
    }
    const extra = GO_MENU_EXTRAS[key]
    if (!extra) return null
    placed.add(key)
    return { id: `go-${key}`, ...extra }
  }

  const sections = layout.map((section) =>
    section.map(resolve).filter((item): item is GoMenuItem => item !== null)
  )
  const unplaced = SIDEBAR_NAV_META.filter((meta) => !placed.has(meta.id))
    .map((meta) => resolve(meta.id))
    .filter((item): item is GoMenuItem => item !== null)
  if (unplaced.length > 0) sections.splice(Math.max(sections.length - 1, 0), 0, unplaced)
  return sections.filter((section) => section.length > 0)
}

/** The Go menu, section by section. */
export const GO_MENU_SECTIONS: readonly (readonly GoMenuItem[])[] =
  resolveGoMenuSections(GO_MENU_LAYOUT)

/** Every Go-menu id, in menu order. */
export const GO_MENU_IDS: readonly GoMenuId[] = GO_MENU_SECTIONS.flatMap((section) =>
  section.map((item) => item.id)
)

const GO_MENU_ITEMS_BY_ID: ReadonlyMap<string, GoMenuItem> = new Map(
  GO_MENU_SECTIONS.flatMap((section) => section.map((item) => [item.id, item] as const))
)

/** The Go-menu entry for `id`, or `undefined` when it is not a destination. */
export function getGoMenuItem(id: string): GoMenuItem | undefined {
  return GO_MENU_ITEMS_BY_ID.get(id)
}

/**
 * True when `id` is one of {@link GO_MENU_IDS}. Membership, not a prefix
 * test: `go-anything` is not a destination just because it is spelled like
 * one.
 */
export function isGoMenuId(id: string): id is GoMenuId {
  return GO_MENU_ITEMS_BY_ID.has(id)
}
