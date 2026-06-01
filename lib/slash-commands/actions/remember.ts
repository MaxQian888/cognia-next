// Action handler for the `/remember` slash command (autonomous long-term
// memory — explicit capture path).
//
//   /remember <text>   — deliberately store a durable fact about the user.
//
// Explicit capture bypasses the salience gate and the extraction LLM (the text
// IS the memory) but still flows through the SAME consolidator as auto-extracted
// memories — so it dedupes / updates / supersedes existing memories instead of
// blindly piling up. Provenance is `explicit` (trusted, so it may become a
// procedural rule). It respects `memory.enabled` + temporary mode but NOT
// `autoExtract` (this is a deliberate user action).

import type { SlashContext } from "../builtin"
import { useSettingsStore } from "@/stores/settings"
import { getSession } from "@/lib/db/sessions"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { hasNoLeakingPii } from "@/lib/twin/ingest/redact"

export interface RememberCommandResult {
  system?: string
  /** When true, the caller should open the Memory settings/panel. */
  openMemory?: boolean
}

export async function dispatchRememberCommand(
  ctx: SlashContext
): Promise<RememberCommandResult | null> {
  const text = (ctx.args ?? "").trim()
  if (!text) {
    return {
      system: "Usage: `/remember <fact>` — e.g. `/remember I always use pnpm`.",
    }
  }

  const settings = useSettingsStore.getState().settings
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) {
    return {
      system: "Long-term memory is turned off. Enable it in Settings → Memory.",
      openMemory: true,
    }
  }
  if (config.temporary) {
    return { system: "Temporary mode is on — memory is paused, so nothing was saved." }
  }
  if (!hasNoLeakingPii(text)) {
    return {
      system:
        "That looks like it contains sensitive data (an email, key, or similar), so it was **not** saved to memory.",
    }
  }

  try {
    const sessionRow = ctx.activeSessionId
      ? await getSession(ctx.activeSessionId).catch(() => undefined)
      : undefined

    const { buildAutoExtractionDeps } = await import("@/lib/memory/write/run-memory-extraction")
    const deps = await buildAutoExtractionDeps(
      { session: sessionRow ?? null, appSettings: settings },
      config
    )
    if (!deps) {
      return { system: "Couldn't reach the memory store right now — please try again." }
    }

    await deps.consolidate({
      candidates: [{ type: "semantic", text, importance: 7 }],
      scope: config.scopeDefault,
      characterId: config.scopeDefault === "character" ? sessionRow?.characterId : undefined,
      provenance: "explicit",
      source: { sessionId: ctx.activeSessionId ?? undefined },
    })
    return { system: `Got it — I'll remember: _${text}_` }
  } catch {
    return { system: "Something went wrong saving that to memory." }
  }
}
