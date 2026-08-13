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
import { resolveCharacterById } from "@/lib/db/characters"
import { useSettingsStore } from "@/stores/settings"
import { resolveMemoryConfig } from "@/types/memory/memory"
import {
  appendMemoryAuditEvent,
  bindMemoryGovernanceOutcome,
  claimMemoryJob,
  finishMemoryJob,
  createMemoryEvidence,
  enqueueMemoryJob,
  failMemoryJob,
} from "@/lib/db/memory-governance"
import {
  hasUntrustedMemoryContext,
  type MemoryExternalContextSource,
} from "@/lib/memory/control-plane/policy"
import { detectMemoryExternalContext } from "@/lib/memory/control-plane/contamination"
import { resolveAgentMemoryPolicy } from "@/lib/memory/agent-policy"
import type { MemoryScope } from "@/types/memory/memory"
import { resolveMemoryAgentNamespace } from "@/lib/memory/twin-namespace"

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
  _configured: ReturnType<typeof resolveMemoryConfig>["scopeDefault"],
  session: { projectId?: string; characterId?: string },
  writableScopes: readonly MemoryScope[] = ["global", "workspace", "character", "agent"]
): MemoryScope | null {
  // Automatic learning starts at the workspace boundary. Character/agent and
  // branch/path narrowing require an explicit applicability rationale from the
  // extractor and are therefore not inferred here.
  if (session.projectId && writableScopes.includes("workspace")) return "workspace"
  if (writableScopes.includes("global")) return "global"
  return null
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
    const character = sessionRow.characterId
      ? await resolveCharacterById(sessionRow.characterId).catch(() => undefined)
      : undefined
    const memoryAgentId = resolveMemoryAgentNamespace({
      twinId: character?.twinId,
      characterId: sessionRow.characterId,
    })
    const externalContext = input.externalContext ?? detectMemoryExternalContext(input.transcript)
    const contaminationState = hasUntrustedMemoryContext(externalContext)
      ? "external-context"
      : "clean"
    const policy = resolveAgentMemoryPolicy({
      config,
      session: sessionRow,
      agentPolicy: character?.memoryPolicy,
      externalContext,
    })
    if (!policy.canAutoLearn) {
      await appendMemoryAuditEvent({
        action: "learn-denied",
        sessionId,
        reason: policy.learnReason,
        metadata: { externalContextCount: externalContext.length },
      }).catch(() => undefined)
      return
    }
    const automaticScope = resolveAutomaticMemoryScope(
      config.scopeDefault,
      sessionRow,
      policy.writableScopes
    )
    if (!automaticScope) {
      await appendMemoryAuditEvent({
        action: "learn-denied",
        sessionId,
        reason: "agent_scope_policy",
      }).catch(() => undefined)
      return
    }
    const effectiveConfig = {
      ...config,
      scopeDefault: automaticScope,
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
        sourceRole: "user",
      }),
      createMemoryEvidence({
        kind: "message",
        sourceId: `${turnIdentity}:assistant`,
        sessionId,
        contaminationState,
        reviewed: false,
        sourceRole: "assistant",
      }),
    ])
    const job = await enqueueMemoryJob(
      {
        dedupeKey: `turn-extraction:${turnIdentity}`,
        kind: "turn-extraction",
        sessionId,
        projectId: sessionRow.projectId,
        characterId: sessionRow.characterId,
        agentId: automaticScope === "agent" ? memoryAgentId : undefined,
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
          agentId: automaticScope === "agent" ? memoryAgentId : undefined,
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
        await bindMemoryGovernanceOutcome({
          memoryId,
          patch: {
            evidenceState: "supported",
            reviewStatus:
              operation.op === "CONFLICT"
                ? "conflict"
                : operation.op === "ADD" && operation.memory.type === "procedural"
                  ? "pending_instruction"
                  : "unreviewed",
            contaminationState,
            sensitivity: "normal",
          },
          evidence: {
            kind: "message",
            sourceId: turnIdentity,
            sessionId,
            contaminationState,
            reviewed: false,
          },
          audit: {
            action:
              operation.op === "CONFLICT"
                ? "conflict"
                : operation.op === "ADD"
                  ? "created"
                  : "revised",
            sessionId,
            reason: "automatic_learning",
          },
        })
      }
      const producedOutput = result.applied.some((operation) => operation.op !== "NOOP")
      await finishMemoryJob(
        job.id,
        producedOutput ? "succeeded" : "no_output",
        producedOutput ? "memories_applied" : "nothing_durable"
      )
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
      agentId: memoryAgentId,
    })
  } catch (err) {
    if (claimedJobId) {
      await failMemoryJob(claimedJobId, "turn_extraction_failed").catch(() => undefined)
    }
    console.warn("runTurnMemory failed", err)
  }
}
