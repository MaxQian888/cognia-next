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
import { updateMemory } from "@/lib/db/memories"
import {
  appendMemoryAuditEvent,
  claimMemoryJob,
  completeMemoryJob,
  createMemoryEvidence,
  enqueueMemoryJob,
  failMemoryJob,
} from "@/lib/db/memory-governance"
import {
  resolveMemoryTurnPolicy,
  hasUntrustedMemoryContext,
  type MemoryExternalContextSource,
} from "@/lib/memory/control-plane/policy"
import { detectMemoryExternalContext } from "@/lib/memory/control-plane/contamination"

export interface TurnTranscriptEntry {
  role: string
  text: string
  parts?: readonly unknown[]
}

export interface TurnMemoryInput {
  /** The just-finished turn's user prompt (already extracted to plain text). */
  userText: string
  /** The turn's assistant reply (for a team turn: the final member/supervisor reply). */
  assistantText: string
  /** Rolling `{ role, text }` view of the conversation for recent-context + distillation. */
  transcript: TurnTranscriptEntry[]
  /** Id of the turn's assistant message — stamped onto learned memories so chat chips can liveQuery them. */
  assistantMessageId?: string
  /** Context sources used by this turn; external sources contaminate automatic learning. */
  externalContext?: MemoryExternalContextSource[]
}

export function resolveAutomaticMemoryScope(
  configured: ReturnType<typeof resolveMemoryConfig>["scopeDefault"],
  session: { projectId?: string; characterId?: string }
): "global" | "workspace" | "character" {
  if (configured !== "agent") return configured
  if (session.projectId) return "workspace"
  if (session.characterId) return "character"
  return "global"
}

export async function runTurnMemory(sessionId: string, input: TurnMemoryInput): Promise<void> {
  let claimedJobId: string | undefined
  try {
    if (!input.userText.trim()) return

    const settings = useSettingsStore.getState().settings
    if (!settings) return
    const config = resolveMemoryConfig(settings.memory)
    if (!config.enabled || config.temporary) return
    const sessionRow = await getSession(sessionId).catch(() => undefined)
    if (!sessionRow) return
    const externalContext = input.externalContext ?? detectMemoryExternalContext(input.transcript)
    const contaminationState = hasUntrustedMemoryContext(externalContext)
      ? "external-context"
      : "clean"
    const policy = resolveMemoryTurnPolicy({
      config,
      session: sessionRow,
      externalContext,
    })
    if (!policy.canLearn) {
      await appendMemoryAuditEvent({
        action: "learn-denied",
        sessionId,
        reason: policy.learnReason,
        metadata: { externalContextCount: externalContext.length },
      }).catch(() => undefined)
      return
    }
    const policyConfig =
      sessionRow.memoryLearn === true
        ? { ...config, learnFromChats: true, autoExtract: true }
        : config
    const effectiveConfig = {
      ...policyConfig,
      scopeDefault: resolveAutomaticMemoryScope(policyConfig.scopeDefault, sessionRow),
    }

    const { buildAutoExtractionDeps, runMemoryExtraction, sessionProvenance } =
      await import("@/lib/memory/write/run-memory-extraction")
    const provenance = sessionProvenance(sessionRow)
    const turnIdentity = `${sessionId}:turn:${input.transcript.length}`
    const evidence = await Promise.all([
      createMemoryEvidence({
        kind: "message",
        sourceId: `${turnIdentity}:user`,
        sessionId,
        contaminationState,
        reviewed: false,
      }),
      createMemoryEvidence({
        kind: "message",
        sourceId: `${turnIdentity}:assistant`,
        sessionId,
        contaminationState,
        reviewed: false,
      }),
    ])
    const job = await enqueueMemoryJob(
      {
        dedupeKey: `turn-extraction:${turnIdentity}`,
        kind: "turn-extraction",
        sessionId,
        projectId: sessionRow.projectId,
        characterId: sessionRow.characterId,
        scope: effectiveConfig.scopeDefault,
        provenance,
        evidenceIds: evidence.map((item) => item.id),
      },
      { reuseCompleted: true }
    )
    const deps = await buildAutoExtractionDeps(
      { session: sessionRow, appSettings: settings },
      effectiveConfig
    )
    const claimed = deps ? await claimMemoryJob(job.id, "renderer-turn-memory") : undefined
    if (deps && claimed) {
      claimedJobId = job.id
      const result = await runMemoryExtraction(
        {
          newPair: { userText: input.userText, assistantText: input.assistantText },
          recentMessages: input.transcript.slice(-10).map(({ role, text }) => ({ role, text })),
          scope: effectiveConfig.scopeDefault,
          characterId: sessionRow.characterId,
          projectId: sessionRow.projectId,
          provenance,
          source: { sessionId, messageId: input.assistantMessageId },
          config: effectiveConfig,
        },
        deps
      )
      for (const operation of result.applied) {
        const memoryId =
          operation.op === "ADD" || operation.op === "CONFLICT"
            ? operation.memory.id
            : operation.op === "UPDATE"
              ? operation.targetId
              : undefined
        if (!memoryId) continue
        await updateMemory(memoryId, {
          evidenceState: "supported",
          reviewStatus: operation.op === "CONFLICT" ? "conflict" : "unreviewed",
          contaminationState,
          sensitivity: "normal",
        })
        await createMemoryEvidence({
          memoryId,
          kind: "message",
          sourceId: turnIdentity,
          sessionId,
          contaminationState,
          reviewed: false,
        })
        await appendMemoryAuditEvent({
          action:
            operation.op === "CONFLICT"
              ? "conflict"
              : operation.op === "ADD"
                ? "created"
                : "revised",
          memoryId,
          sessionId,
          reason: "automatic_learning",
        })
      }
      await completeMemoryJob(job.id)
      claimedJobId = undefined
    }

    await appendMemoryAuditEvent({
      action: "learn-allowed",
      sessionId,
      reason: policy.learnReason,
      metadata: { externalContextCount: externalContext.length },
    }).catch(() => undefined)

    // Schedule idle episodic distillation + capacity/access-time eviction.
    const { scheduleMemoryMaintenance } = await import("@/lib/memory/lifecycle/maintenance")
    scheduleMemoryMaintenance({
      sessionId,
      session: sessionRow,
      appSettings: settings,
      transcript: input.transcript,
      provenance,
      contaminationState,
      config: effectiveConfig,
    })
  } catch (err) {
    if (claimedJobId) {
      await failMemoryJob(claimedJobId, "turn_extraction_failed").catch(() => undefined)
    }
    console.warn("runTurnMemory failed", err)
  }
}
