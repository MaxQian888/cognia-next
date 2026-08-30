/**
 * Queue the post-turn long-term-memory work for a completed turn.
 *
 * This is the host-neutral half of what `runTurnMemory` used to do inline. Two
 * things made the old shape wrong. It read the renderer's Zustand settings
 * store and returned early without it, so it was inert on the brain and in the
 * CLI even though both run the worker. And it enqueued a job and then
 * immediately claimed and ran it, which meant `processTurnExtraction` was dead
 * code except after a crash, and the two paths had drifted into writing
 * different governance rows for the same outcome.
 *
 * Everything here is decision and enqueue. The work itself belongs to
 * `processMemoryJob`, which is now the only thing that runs it.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { getSettings } from "@/lib/db/settings"
import { getSession } from "@/lib/db/sessions"
import { resolveCharacterById } from "@/lib/db/characters"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { appendMemoryAuditEvent, enqueueMemoryJob } from "@/lib/db/memory-governance"
import {
  hasUntrustedMemoryContext,
  type MemoryExternalContextSource,
} from "@/lib/memory/control-plane/policy"
import { detectMemoryExternalContext } from "@/lib/memory/control-plane/contamination"
import { resolveAgentMemoryPolicy } from "@/lib/memory/agent-policy"
import {
  auditMemoryScopeRefusal,
  resolveMemoryWriteTarget,
} from "@/lib/memory/scope/resolve-write-target"
import { resolveMemoryAgentNamespace } from "@/lib/memory/twin-namespace"
import { buildJobCheckpoint, transcriptJobIdentity } from "@/lib/memory/lifecycle/transcript-window"

export interface TurnTranscriptEntry {
  /**
   * Source message id. Optional only for legacy callers: without it the job
   * falls back to count-based checkpointing, which replays the wrong content
   * after a same-length edit. Every in-tree caller supplies it.
   */
  id?: string
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
  /** Id of the turn's assistant message, stamped onto learned memories so chat chips can liveQuery them. */
  assistantMessageId?: string
  /** Context sources used by this turn; external sources contaminate automatic learning. */
  externalContext?: MemoryExternalContextSource[]
}

export interface EnqueueTurnMemoryInput extends TurnMemoryInput {
  sessionId: string
  /**
   * Settings the caller already has. Omitted, they are read from Dexie, which
   * is what lets this run on every host rather than only in the renderer.
   */
  settings?: AppSettings
}

export type EnqueueTurnMemoryReason =
  | "empty"
  | "disabled"
  | "settings_unavailable"
  | "session_missing"
  | "learn_denied"
  | "scope_denied"

export interface EnqueueTurnMemoryResult {
  enqueued: boolean
  jobId?: string
  reason?: EnqueueTurnMemoryReason
}

export async function enqueueTurnMemory(
  input: EnqueueTurnMemoryInput
): Promise<EnqueueTurnMemoryResult> {
  const { sessionId } = input
  if (!input.userText.trim()) return { enqueued: false, reason: "empty" }

  const settings = input.settings ?? (await getSettings().catch(() => undefined))
  if (!settings) return { enqueued: false, reason: "settings_unavailable" }
  const config = resolveMemoryConfig(settings.memory)
  if (!config.enabled || config.temporary) return { enqueued: false, reason: "disabled" }

  const sessionRow = await getSession(sessionId).catch(() => undefined)
  if (!sessionRow) return { enqueued: false, reason: "session_missing" }

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
    return { enqueued: false, reason: "learn_denied" }
  }

  const target = await resolveMemoryWriteTarget({
    configured: config.scopeDefault,
    policy,
    session: sessionRow,
    agentId: memoryAgentId,
  })
  if (!target.ok) {
    await auditMemoryScopeRefusal({ sessionId, attempted: target.attempted, surface: "turn" })
    return { enqueued: false, reason: "scope_denied" }
  }

  const { sessionProvenance } = await import("@/lib/memory/write/run-memory-extraction")
  const provenance = sessionProvenance(sessionRow)
  // Pin the job to real message ids. The identity still ends in the message
  // count, so a row whose checkpoint is ever lost still resolves through the
  // legacy trailing-`:<n>` path in `resolveJobTranscriptWindow`.
  const checkpoint = buildJobCheckpoint(input.transcript, sessionRow.transcriptRevision)
  const turnIdentity = `${sessionId}:${transcriptJobIdentity(
    checkpoint,
    `turn:${input.transcript.length}`
  )}`

  // No evidence is created here. It used to be written BEFORE the job existed,
  // with no `memoryId`, and stored as `job.evidenceIds` that the worker never
  // read. `deleteMemoryEvidence` keys on `memoryId`, so every turn leaked two
  // permanently unreachable rows. The worker now writes evidence in the same
  // transaction as the memory it supports.
  const job = await enqueueMemoryJob(
    {
      dedupeKey: `turn-extraction:${turnIdentity}`,
      kind: "turn-extraction",
      checkpoint,
      sessionId,
      projectId: sessionRow.projectId,
      characterId: sessionRow.characterId,
      agentId: target.scope === "agent" ? memoryAgentId : undefined,
      scope: target.scope,
      provenance,
      evidenceIds: [],
    },
    { reuseCompleted: true }
  )

  await appendMemoryAuditEvent({
    action: "learn-allowed",
    sessionId,
    reason: policy.learnReason,
    metadata: { externalContextCount: externalContext.length },
  }).catch(() => undefined)

  // Project-context mining. Only CLOSED windows are queued from the live turn
  // path: the trailing window is still growing, so its identity changes every
  // turn and mining it here would re-mine overlapping text on every send. The
  // idle maintenance tick flushes it once the conversation stops.
  if (
    config.mineProjectContext &&
    sessionRow.projectId &&
    policy.writableScopes.includes("workspace")
  ) {
    const { enqueueProjectMiningJobs } = await import("@/lib/memory/write/project-mining-enqueue")
    await enqueueProjectMiningJobs({
      sessionId,
      projectId: sessionRow.projectId,
      transcript: input.transcript
        .filter((entry): entry is TurnTranscriptEntry & { id: string } => Boolean(entry.id))
        .map((entry) => ({
          id: entry.id,
          role: entry.role,
          text: entry.text,
          parts: entry.parts,
        })),
      transcriptRevision: sessionRow.transcriptRevision,
      scope: "workspace",
      characterId: sessionRow.characterId,
      provenance,
      includeTrailing: false,
    }).catch(() => undefined)
  }

  // Schedule idle episodic distillation + capacity/access-time eviction.
  const { scheduleMemoryMaintenance } = await import("@/lib/memory/lifecycle/maintenance")
  scheduleMemoryMaintenance({
    sessionId,
    session: sessionRow,
    appSettings: settings,
    transcript: input.transcript,
    provenance,
    contaminationState,
    config: { ...config, scopeDefault: target.scope },
    agentId: memoryAgentId,
  })

  return { enqueued: true, jobId: job.id }
}
