// Action handler for the `/memory` slash command family (ADR-0069) — the
// read/manage counterpart to `/remember` (which writes).
//
// Surface:
//   /memory               — open the Memory settings/console panel
//   /memory status        — counts + enabled/temporary state as a system card
//   /memory list [n]      — newest n active memories (default 10, max 50)
//   /memory forget <id>   — soft-invalidate one memory (kept in history)
//
// Reads respect `memory.enabled`; `forget` uses the shared external mutator
// (soft-delete only — hard deletes stay in the console UI). Unknown
// subcommands fall through (`null`) so a user's custom `/memory-foo.md`
// command still wins.

import type { SlashContext } from "../builtin"
import { useSettingsStore } from "@/stores/settings"
import { resolveMemoryConfig } from "@/types/memory/memory"

export interface MemoryCommandResult {
  /** Markdown to push into the chat as a system message. */
  system?: string
  /** When true, the caller should open the Memory settings/panel. */
  openMemory?: boolean
}

export async function dispatchMemorySubcommand(
  ctx: SlashContext
): Promise<MemoryCommandResult | null> {
  const trimmed = (ctx.args ?? "").trim()
  if (!trimmed) return { openMemory: true }

  const space = trimmed.search(/\s/)
  const sub = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? "" : trimmed.slice(space).trim()

  const settings = useSettingsStore.getState().settings
  const config = resolveMemoryConfig(settings?.memory)

  switch (sub) {
    case "status": {
      if (!config.enabled) {
        return {
          system: "Long-term memory is **off**. Enable it in Settings → Memory.",
          openMemory: true,
        }
      }
      const { countActive } = await import("@/lib/db/memories")
      const globalCount = await countActive("global")
      const characterCount = await countActive("character")
      const lines = [
        `**Memory status**`,
        `- Enabled: yes${config.temporary ? " (temporary mode — paused)" : ""}`,
        `- Auto-extract: ${config.autoExtract ? "on" : "off"}`,
        `- Active memories: ${globalCount} global, ${characterCount} character-scoped`,
        `- Cap per scope: ${config.maxActivePerScope}`,
      ]
      return { system: lines.join("\n") }
    }

    case "list": {
      if (!config.enabled) {
        return {
          system: "Long-term memory is **off**. Enable it in Settings → Memory.",
          openMemory: true,
        }
      }
      const parsed = Number.parseInt(rest, 10)
      const limit = Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 10
      const { listMemories } = await import("@/lib/db/memories")
      const rows = (await listMemories({ status: "active" })).slice(0, limit)
      if (rows.length === 0) {
        return { system: "No active memories yet — save one with `/remember <fact>`." }
      }
      const lines = rows.map(
        (m) => `- ${m.pinned ? "📌 " : ""}${m.text} _( ${m.type} · \`${m.id}\` )_`
      )
      return {
        system: [`**Newest ${rows.length} memories** (\`/memory forget <id>\` to remove):`]
          .concat(lines)
          .join("\n"),
      }
    }

    case "forget": {
      if (!rest) {
        return { system: "Usage: `/memory forget <id>` — get ids from `/memory list`." }
      }
      const { forgetExternalMemory } = await import("@/lib/memory/api/mutate-memory")
      const result = await forgetExternalMemory(rest)
      if (!result.ok) {
        return result.reason === "not_found"
          ? { system: `No memory with id \`${rest}\` — check \`/memory list\`.` }
          : {
              system: "Long-term memory is **off**. Enable it in Settings → Memory.",
              openMemory: true,
            }
      }
      return { system: `Forgotten — memory \`${rest}\` is archived (recoverable in the console).` }
    }

    default:
      // Unknown subcommand → fall through so custom user commands can match.
      return null
  }
}
