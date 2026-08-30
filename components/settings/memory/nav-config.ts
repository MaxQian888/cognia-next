import {
  FolderGit2Icon,
  GaugeIcon,
  GraduationCapIcon,
  SearchIcon,
  ShieldIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"

/**
 * Panels of the Settings → Memory master/detail pane. Kept as plain data so the
 * nav, the deep-link resolver, and the tests all read the same list.
 */
export type MemoryPanelId =
  "overview" | "learning" | "retrieval" | "projectContext" | "maintenance" | "privacy"

export interface MemoryNavItem {
  id: MemoryPanelId
  icon: LucideIcon
}

export const MEMORY_NAV_ITEMS: readonly MemoryNavItem[] = [
  { id: "overview", icon: GaugeIcon },
  { id: "learning", icon: GraduationCapIcon },
  { id: "retrieval", icon: SearchIcon },
  // Beside retrieval, not under privacy. Both switches are about what the model
  // is told, which is the question the retrieval panel already answers for
  // personal memories.
  { id: "projectContext", icon: FolderGit2Icon },
  { id: "maintenance", icon: WrenchIcon },
  { id: "privacy", icon: ShieldIcon },
]

export const MEMORY_TAB_PARAM = "memoryTab"

export const DEFAULT_MEMORY_PANEL: MemoryPanelId = "overview"

/** Narrow an untrusted deep-link value, falling back to the overview. */
export function resolveMemoryPanel(raw: string | null | undefined): MemoryPanelId {
  return MEMORY_NAV_ITEMS.some((item) => item.id === raw)
    ? (raw as MemoryPanelId)
    : DEFAULT_MEMORY_PANEL
}
