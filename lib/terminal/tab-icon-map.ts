/**
 * Maps tab icon preset keys to lucide-react components.
 *
 * Shared between `terminal-tab.tsx` (renders the icon in the tab) and
 * `terminal-tab-appearance-picker.tsx` (renders the icon grid).
 */

import type { ComponentType } from "react"
import {
  TerminalIcon,
  ServerIcon,
  DatabaseIcon,
  GlobeIcon,
  CodeIcon,
  BugIcon,
  RocketIcon,
  ContainerIcon,
} from "lucide-react"

import type { TabIconPreset } from "@/lib/terminal/tab-appearance"

/** Map icon preset key → lucide component. `"none"` maps to `null`. */
export const TAB_ICON_COMPONENTS: Record<
  TabIconPreset,
  ComponentType<{ className?: string }> | null
> = {
  none: null,
  terminal: TerminalIcon,
  server: ServerIcon,
  database: DatabaseIcon,
  globe: GlobeIcon,
  code: CodeIcon,
  bug: BugIcon,
  rocket: RocketIcon,
  container: ContainerIcon,
}
