// Builds the "All Commands ▶" submenu by joining the two existing command
// registries with the plugin-contributed tray items. Reuses:
//   - `lib/slash-commands/registry.ts:99` listSlashCommands
//   - `lib/plugin/commands/registry.ts:128` listCommandsByPlugin
//   - `lib/tray/registry.ts`               listTrayItems
//
// Output is a flat list of `TrayMenuItem.Submenu` nodes — one per category
// bucket — each containing the actions in that bucket. Empty buckets are
// dropped. Items inside a bucket are sorted alphabetically by label so the
// menu order is deterministic across rebuilds.

import { listSlashCommands } from "@/lib/slash-commands/registry"
import { getCommands, getCommand } from "@/lib/plugin/commands/registry"
import { listTrayItems } from "./registry"
import type { TrayActionPayload, TrayMenuItem, TrayMenuSubmenu } from "./types"

/**
 * Canonical category buckets. Anything outside this list falls into "other".
 * Display labels are i18n keys (`tray.categories.<bucket>`) that the
 * renderer resolves before flushing the DTO to Rust.
 */
const CATEGORY_ORDER = [
  "chat",
  "diagnostics",
  "system",
  "goal",
  "template",
  "help",
  "plugins",
  "other",
] as const

export type Category = (typeof CATEGORY_ORDER)[number]

function bucketOf(rawCategory: string | undefined, fallback: Category): Category {
  if (!rawCategory) return fallback
  return (CATEGORY_ORDER as readonly string[]).includes(rawCategory)
    ? (rawCategory as Category)
    : "other"
}

function action(id: string, label: string, payload: TrayActionPayload): TrayMenuItem {
  return { kind: "action", id, label, payload }
}

/**
 * Build the full submenu tree. The renderer mounts the result under the
 * synthetic id `tray.all-commands`; `lib/tray/builder.ts` swaps the items
 * field of the placeholder submenu in `defaults.ts` with what we return.
 */
export function buildAllCommandsSubmenu(): TrayMenuSubmenu {
  const buckets = new Map<Category, TrayMenuItem[]>()
  for (const c of CATEGORY_ORDER) buckets.set(c, [])

  // Slash commands (builtin + plugin slash) ─ source: lib/slash-commands.
  for (const cmd of listSlashCommands()) {
    const bucket = bucketOf(cmd.category, cmd.source === "plugin" ? "plugins" : "chat")
    buckets.get(bucket)!.push(
      action(`slash:${cmd.id}`, `/${cmd.name}`, {
        kind: "slash",
        command: cmd.name,
      })
    )
  }

  // Plugin-contributed tray items ─ source: lib/tray/registry.
  for (const item of listTrayItems()) {
    const bucket = bucketOf(item.category, "plugins")
    buckets.get(bucket)!.push(
      action(`tray-item:${item.id}`, item.label, {
        kind: "command",
        commandId: item.id,
      })
    )
  }

  // Unified command registry — covers cognia-native and VS Code-extension
  // commands registered via `lib/plugin/commands/registry.ts`. Slash
  // commands and tray items already have dedicated buckets above; this is
  // the path for anything registered as a plain `CommandRegistration`.
  for (const id of getCommands(true)) {
    const cmd = getCommand(id)
    if (!cmd) continue
    const bucket = bucketOf(cmd.category, cmd.pluginId ? "plugins" : "system")
    buckets.get(bucket)!.push(
      action(`command:${id}`, cmd.title ?? id, {
        kind: "command",
        commandId: id,
      })
    )
  }

  const children: TrayMenuItem[] = []
  for (const bucket of CATEGORY_ORDER) {
    const entries = buckets.get(bucket) ?? []
    if (entries.length === 0) continue
    entries.sort((a, b) => {
      const la = a.kind === "action" ? a.label : ""
      const lb = b.kind === "action" ? b.label : ""
      return la.localeCompare(lb)
    })
    children.push({
      kind: "submenu",
      id: `tray.all-commands.${bucket}`,
      label: `tray.categories.${bucket}`,
      items: entries,
    })
  }

  return {
    kind: "submenu",
    id: "tray.all-commands",
    label: "tray.allCommands",
    items: children,
  }
}
