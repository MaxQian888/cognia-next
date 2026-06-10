/**
 * Group the command catalog into labelled sections for `/help` and the palette.
 * Pure presenter — fixed display order, empty categories omitted.
 */
import type { CommandCategory, CommandDescriptor } from "./types"

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  chat: "Chat",
  session: "Session",
  cognia: "Cognia",
  mcp: "MCP",
  plugin: "Plugins",
  config: "Configuration",
  system: "System",
}

/** Sections render in this order; anything else falls into "system". */
const ORDER: CommandCategory[] = ["chat", "session", "cognia", "mcp", "plugin", "config", "system"]

export interface CategoryGroup {
  category: CommandCategory
  label: string
  commands: CommandDescriptor[]
}

export function groupByCategory(commands: CommandDescriptor[]): CategoryGroup[] {
  const buckets = new Map<CommandCategory, CommandDescriptor[]>()
  for (const c of commands) {
    const cat: CommandCategory = ORDER.includes(c.category) ? c.category : "system"
    const list = buckets.get(cat) ?? []
    list.push(c)
    buckets.set(cat, list)
  }
  const groups: CategoryGroup[] = []
  for (const category of ORDER) {
    const cmds = buckets.get(category)
    if (cmds && cmds.length > 0) {
      groups.push({ category, label: CATEGORY_LABELS[category], commands: cmds })
    }
  }
  return groups
}
