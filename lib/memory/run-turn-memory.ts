/**
 * Shared post-turn long-term-memory pass: extract semantic/procedural memories
 * from a completed turn, then schedule idle episodic distillation + eviction.
 *
 * Lifted out of `hooks/chat/use-claude-chat.ts` (`runMemoryTasks`) so BOTH the
 * direct-chat hook and the team-chat hook drive the same write path. Previously
 * only direct chat wrote long-term memory, so multi-agent (team) conversations
 * never contributed to the store even though teammates already *read* it through
 * `resolveSendOptions` — this closes the team↔direct memory parity gap.
 *
 * The caller supplies the already-extracted `newPair` (so each hook keeps its own
 * text-extraction nuance — direct chat uses `extractAssistantText` for the reply
 * but `extractPlainText` for the rolling transcript) plus a `{ role, text }`
 * transcript used for recent-context and maintenance. Fire-and-forget at the call
 * site; this never throws — memory must never break a send.
 */

import { getSession } from "@/lib/db/sessions"
import { useSettingsStore } from "@/stores/settings"
import { resolveMemoryConfig } from "@/types/memory/memory"

export interface TurnTranscriptEntry {
  role: string
  text: string
}

export interface TurnMemoryInput {
  /** The just-finished turn's user prompt (already extracted to plain text). */
  userText: string
  /** The turn's assistant reply (for a team turn: the final member/supervisor reply). */
  assistantText: string
  /** Rolling `{ role, text }` view of the conversation for recent-context + distillation. */
  transcript: TurnTranscriptEntry[]
}

export async function runTurnMemory(sessionId: string, input: TurnMemoryInput): Promise<void> {
  try {
    if (!input.userText.trim()) return

    const settings = useSettingsStore.getState().settings
    if (!settings) return
    const config = resolveMemoryConfig(settings.memory)
    if (!config.enabled || !config.autoExtract || config.temporary) return
    const sessionRow = await getSession(sessionId).catch(() => undefined)
    if (!sessionRow) return

    const { buildAutoExtractionDeps, runMemoryExtraction, sessionProvenance } =
      await import("@/lib/memory/write/run-memory-extraction")
    const provenance = sessionProvenance(sessionRow)
    const deps = await buildAutoExtractionDeps(
      { session: sessionRow, appSettings: settings },
      config
    )
    if (deps) {
      await runMemoryExtraction(
        {
          newPair: { userText: input.userText, assistantText: input.assistantText },
          recentMessages: input.transcript.slice(-10),
          scope: config.scopeDefault,
          characterId: sessionRow.characterId,
          provenance,
          source: { sessionId },
          config,
        },
        deps
      )
    }

    // Schedule idle episodic distillation + capacity/access-time eviction.
    const { scheduleMemoryMaintenance } = await import("@/lib/memory/lifecycle/maintenance")
    scheduleMemoryMaintenance({
      sessionId,
      session: sessionRow,
      appSettings: settings,
      transcript: input.transcript,
      provenance,
      config,
    })
  } catch (err) {
    console.warn("runTurnMemory failed", err)
  }
}
