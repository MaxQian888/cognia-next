import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { getSettings } from "@/lib/db/settings"
import { getSession } from "@/lib/db/sessions"
import { resolveCharacterById } from "@/lib/db/characters"
import { listMessages } from "@/lib/db/messages"
import {
  appendMemoryAuditEvent,
  claimNextMemoryJob,
  finishMemoryJob,
  createMemoryEvidence,
  failMemoryJob,
} from "@/lib/db/memory-governance"
import { listMemories, updateMemory } from "@/lib/db/memories"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { resolveMemoryConfig, type MemoryConfig } from "@/types/memory/memory"
import type { MemoryJob } from "@/types/memory/governance"
import { resolveJobTranscriptWindow } from "@/lib/memory/lifecycle/transcript-window"
import { detectMemoryExternalContext } from "@/lib/memory/control-plane/contamination"
import { hasUntrustedMemoryContext } from "@/lib/memory/control-plane/policy"
import { resolveAgentMemoryPolicy } from "@/lib/memory/agent-policy"
import type { ConsolidationOp } from "@/lib/memory/consolidate/consolidator"
import { hasNoLeakingPii } from "@cognia/redact"

export interface MemoryJobWorkerDeps {
  claimNext: (workerId: string) => Promise<MemoryJob | undefined>
  finish: (id: string, outcome: MemoryJobProcessOutcome) => Promise<void>
  fail: (id: string, code: string) => Promise<unknown>
  process: (job: MemoryJob) => Promise<MemoryJobProcessOutcome>
}

export interface MemoryJobProcessOutcome {
  status: "succeeded" | "no_output" | "skipped"
  resultCode: string
}

export interface DrainMemoryJobsOptions {
  workerId?: string
  maxJobs?: number
}

export async function drainMemoryJobs(
  options: DrainMemoryJobsOptions = {},
  deps: MemoryJobWorkerDeps = defaultWorkerDeps
): Promise<number> {
  const workerId = options.workerId ?? "memory-job-worker"
  const maxJobs = options.maxJobs ?? 20
  let processed = 0
  while (processed < maxJobs) {
    const job = await deps.claimNext(workerId)
    if (!job) break
    try {
      const outcome = await deps.process(job)
      await deps.finish(job.id, outcome)
    } catch (error) {
      if (error instanceof MemoryJobTerminalError) {
        await deps.finish(job.id, { status: "skipped", resultCode: error.code })
        processed += 1
        continue
      }
      const code =
        error instanceof MemoryJobProcessingError ? error.code : "memory_job_processing_failed"
      await deps.fail(job.id, code)
    }
    processed += 1
  }
  return processed
}

export interface StartMemoryJobWorkerOptions extends DrainMemoryJobsOptions {
  intervalMs?: number
  deps?: MemoryJobWorkerDeps
}

export function startMemoryJobWorker(options: StartMemoryJobWorkerOptions = {}): () => void {
  const deps = options.deps ?? defaultWorkerDeps
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await drainMemoryJobs(options, deps)
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), options.intervalMs ?? 30_000)
  return () => clearInterval(timer)
}

class MemoryJobProcessingError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

class MemoryJobTerminalError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function effectiveConfig(settings: AppSettings): MemoryConfig {
  return resolveMemoryConfig(settings.memory)
}

async function loadJobContext(job: MemoryJob): Promise<{
  settings: AppSettings
  session: ChatSession
  config: MemoryConfig
  transcript: Array<{ id?: string; role: string; text: string; parts?: readonly unknown[] }>
  contaminationState: "clean" | "external-context"
  /** Set when the session advanced past the checkpoint but the window verified intact. */
  windowResultCode?: "revision_advanced_window_intact"
}> {
  if (!job.sessionId) throw new MemoryJobTerminalError("session_missing")
  const [settings, session, messages] = await Promise.all([
    getSettings(),
    getSession(job.sessionId),
    listMessages(job.sessionId),
  ])
  if (!settings || !session) throw new MemoryJobTerminalError("session_unavailable")
  const config = effectiveConfig(settings)
  const character = session.characterId
    ? await resolveCharacterById(session.characterId).catch(() => undefined)
    : undefined
  const fullTranscript = messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: extractPlainText(message.parts),
    parts: message.parts,
  }))
  const window = resolveJobTranscriptWindow(job, fullTranscript, session.transcriptRevision)
  if (!window.ok) {
    // Terminal codes mean the window can never resolve again (its messages were
    // deleted, or the slice no longer describes the conversation it was mined
    // from). Burning the retry budget on those is pure waste.
    throw window.terminal
      ? new MemoryJobTerminalError(window.code)
      : new MemoryJobProcessingError(window.code)
  }
  const transcript = window.transcript
  const externalContext = detectMemoryExternalContext(transcript)
  const policy = resolveAgentMemoryPolicy({
    config,
    session,
    agentPolicy: character?.memoryPolicy,
    externalContext,
  })
  if (!policy.canAutoLearn || !policy.writableScopes.includes(job.scope)) {
    await appendMemoryAuditEvent({
      action: "learn-denied",
      sessionId: job.sessionId,
      reason: policy.learnReason,
      metadata: { recoveredJob: true },
    })
    throw new MemoryJobTerminalError("learning_denied")
  }
  return {
    settings,
    session,
    config,
    transcript,
    contaminationState: hasUntrustedMemoryContext(externalContext) ? "external-context" : "clean",
    windowResultCode: window.resultCode,
  }
}

function lastCompletedPair(
  transcript: Array<{ id?: string; role: string; text: string }>
): { userText: string; assistantText: string; assistantMessageId?: string } | undefined {
  let assistantIndex = -1
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "assistant" && transcript[index]?.text.trim()) {
      assistantIndex = index
      break
    }
  }
  if (assistantIndex < 0) return undefined
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = transcript[index]
    if (message?.role === "user" && message.text.trim()) {
      return {
        userText: message.text,
        assistantText: transcript[assistantIndex]!.text,
        assistantMessageId: transcript[assistantIndex]!.id,
      }
    }
  }
  return undefined
}

async function recordRecoveredOperations(
  job: MemoryJob,
  operations: ConsolidationOp[],
  contaminationState: "clean" | "external-context"
): Promise<void> {
  for (const operation of operations) {
    const memoryId =
      operation.op === "ADD" || operation.op === "CONFLICT"
        ? operation.memory.id
        : operation.op === "UPDATE"
          ? operation.targetId
          : undefined
    if (!memoryId) continue
    const addedType =
      operation.op === "ADD" || operation.op === "CONFLICT" ? operation.memory.type : undefined
    await updateMemory(memoryId, {
      evidenceState: "supported",
      reviewStatus:
        operation.op === "CONFLICT"
          ? "conflict"
          : addedType === "procedural"
            ? "pending_instruction"
            : "unreviewed",
      contaminationState,
      sensitivity: "normal",
    })
    await createMemoryEvidence({
      memoryId,
      kind: "checkpoint",
      sourceId: `recovered-job:${job.id}`,
      sessionId: job.sessionId,
      contaminationState,
      reviewed: false,
      sourceRole: "user",
    })
    await appendMemoryAuditEvent({
      action:
        operation.op === "CONFLICT" ? "conflict" : operation.op === "ADD" ? "created" : "revised",
      memoryId,
      sessionId: job.sessionId,
      reason: "recovered_job",
    })
  }
}

/**
 * Compose the job's own result code with the transcript-window outcome, so a
 * recovered job that ran against a session whose revision had already advanced
 * is distinguishable in the console from one that replayed a pristine window.
 * `resultCode` is a free-form diagnostic string (`SAFE_IDENTIFIER` in the backup
 * sanitizer permits `:`), so the composed form round-trips through export.
 */
function withWindowOutcome(base: string, windowResultCode: string | undefined): string {
  return windowResultCode ? `${base}:${windowResultCode}` : base
}

async function processTurnExtraction(job: MemoryJob): Promise<MemoryJobProcessOutcome> {
  const context = await loadJobContext(job)
  const pair = lastCompletedPair(context.transcript)
  if (!pair) throw new MemoryJobProcessingError("turn_pair_unavailable")
  const { buildAutoExtractionDeps, runMemoryExtraction } =
    await import("@/lib/memory/write/run-memory-extraction")
  const deps = await buildAutoExtractionDeps(
    { session: context.session, appSettings: context.settings },
    context.config
  )
  if (!deps) throw new MemoryJobProcessingError("dependencies_unavailable")
  const result = await runMemoryExtraction(
    {
      newPair: { userText: pair.userText, assistantText: pair.assistantText },
      recentMessages: context.transcript.slice(-10),
      scope: job.scope,
      characterId: job.characterId,
      projectId: job.projectId,
      agentId: job.agentId,
      provenance: job.provenance,
      source: { sessionId: job.sessionId, messageId: pair.assistantMessageId },
      config: context.config,
    },
    deps
  )
  await recordRecoveredOperations(job, result.applied, context.contaminationState)
  return result.applied.some((operation) => operation.op !== "NOOP")
    ? {
        status: "succeeded",
        resultCode: withWindowOutcome("memories_applied", context.windowResultCode),
      }
    : {
        status: "no_output",
        resultCode: withWindowOutcome("nothing_durable", context.windowResultCode),
      }
}

async function processSessionDistill(job: MemoryJob): Promise<MemoryJobProcessOutcome> {
  const context = await loadJobContext(job)
  const { buildEpisodicMaintenanceDeps } =
    await import("@/lib/memory/lifecycle/build-maintenance-deps")
  const { runMemoryMaintenance } = await import("@/lib/memory/lifecycle/maintenance")
  const deps = await buildEpisodicMaintenanceDeps(
    { session: context.session, appSettings: context.settings },
    context.config
  )
  if (!deps) throw new MemoryJobProcessingError("dependencies_unavailable")
  await runMemoryMaintenance(
    {
      transcript: context.transcript,
      scope: job.scope,
      characterId: job.characterId,
      projectId: job.projectId,
      agentId: job.agentId,
      provenance: job.provenance,
      contaminationState: context.contaminationState,
      source: { sessionId: job.sessionId },
      config: context.config,
    },
    deps
  )
  return {
    status: "succeeded",
    resultCode: withWindowOutcome("maintenance_completed", context.windowResultCode),
  }
}

async function processVectorReconcile(): Promise<MemoryJobProcessOutcome> {
  const settings = await getSettings()
  const config = resolveMemoryConfig(settings?.memory)
  const { tryBuildMemoryVectorSink } = await import("@/lib/memory/runtime/build-deps")
  const sink = await tryBuildMemoryVectorSink(config)
  if (!sink) throw new MemoryJobProcessingError("vector_backend_unavailable")

  // Backend snapshot first (when the store can list) so both healing legs and
  // the orphan sweep work off one consistent view.
  const backendIds = sink.listIds ? new Set(await sink.listIds()) : undefined

  const rows = await listMemories({ status: "active" })
  const activeDocIds = new Set<string>()
  let changes = 0
  for (const row of rows) {
    // PII-bearing text must not live in the vector store; skipping the row
    // also lets the orphan sweep below remove any legacy embedding of it.
    if (!hasNoLeakingPii(row.text)) continue
    if (!row.vectorDocId) {
      // Never indexed (e.g. upsert failed at write time) — index it now.
      await sink.upsert(row.id, row.text)
      await updateMemory(row.id, { vectorDocId: row.id })
      changes += 1
      activeDocIds.add(row.id)
    } else {
      activeDocIds.add(row.vectorDocId)
      // Indexed on our side but missing backend-side — re-upsert.
      if (backendIds && !backendIds.has(row.vectorDocId)) {
        await sink.upsert(row.vectorDocId, row.text)
        changes += 1
      }
    }
  }

  // Orphans: backend docs no active memory points at (invalidated/hard-deleted
  // rows whose vector cleanup failed). Only possible with a listing API.
  if (backendIds) {
    const orphans = [...backendIds].filter((id) => !activeDocIds.has(id))
    if (orphans.length > 0) {
      await sink.delete(orphans)
      changes += orphans.length
    }
  }
  return changes > 0
    ? { status: "succeeded", resultCode: "vectors_reconciled" }
    : { status: "no_output", resultCode: "already_consistent" }
}

export async function processMemoryJob(job: MemoryJob): Promise<MemoryJobProcessOutcome> {
  if (job.kind === "turn-extraction") return processTurnExtraction(job)
  if (job.kind === "session-distill") return processSessionDistill(job)
  return processVectorReconcile()
}

const defaultWorkerDeps: MemoryJobWorkerDeps = {
  claimNext: claimNextMemoryJob,
  finish: (id, outcome) => finishMemoryJob(id, outcome.status, outcome.resultCode),
  fail: failMemoryJob,
  process: processMemoryJob,
}
