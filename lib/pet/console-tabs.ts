// The canonical /pet console tab ids — one source shared by the console (tab
// bar + `?tab=` deep link), the panel quick-nav, and the cross-window bridge's
// "open-console" message validation. Pure and dependency-free so the wire
// protocol can import it.

export const PET_CONSOLE_TABS = [
  "nurture",
  "chat",
  "shop",
  "customize",
  "insights",
  "dex",
  "achievements",
  "binding",
  "plugins",
] as const

export type PetConsoleTab = (typeof PET_CONSOLE_TABS)[number]

const TAB_SET: ReadonlySet<string> = new Set(PET_CONSOLE_TABS)

export function isPetConsoleTab(value: unknown): value is PetConsoleTab {
  return typeof value === "string" && TAB_SET.has(value)
}
