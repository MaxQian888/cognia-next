import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { getSettings } from "@/lib/db/settings"
import { getSession } from "@/lib/db/sessions"
import { listMessages } from "@/lib/db/messages"
import {
  appendMemoryAuditEvent,
  claimNextMemoryJob,
  completeMemoryJob,
  createMemoryEvidence,
  failMemoryJob,
} from "@/lib/db/memory-governance"
import { listMemories, updateMemory } from "@/lib/db/memories"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { resolveMemoryConfig, type MemoryConfig } from "@/types/memory/memory"
import type { MemoryJob } from "@/types/memory/governance"
import { detectMemoryExternalContext } from "@/lib/memory/control-plane/contamination"
import {
  hasUntrustedMemoryContext,
  resolveMemoryTurnPolicy,
} from "@/lib/memory/control-plane/policy"
import type { ConsolidationOp } from "@/lib/memory/consolidate/consolidator"
import { hasNoLeakingPii } from "@cognia/redact"

export interface MemoryJobWorkerDeps {
  claimNext: (workerId: string) => Promise<MemoryJob | undefined>
  complete: (id: string) => Promise<void>
  fail: (id: string, code: string) => Promise<unknown>
  process: (job: MemoryJob) => Promise<void>
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
      await deps.process(job)
      await deps.complete(job.id)
    } catch (error) {
      if (error instanceof MemoryJobTerminalError) {
        await deps.complete(job.id)
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

class MemoryJobTerminalError extends Error {}

function effectiveConfig(settings: AppSettings, session: ChatSession): MemoryConfig {
  const config = resolveMemoryConfig(settings.memory)
  return session.memoryLearn === true
    ? { ...config, learnFromChats: true, autoExtract: true }
    : config
}

async function loadJobContext(job: MemoryJob): Promise<{
  settings: AppSettings
  session: ChatSession
  config: MemoryConfig
  transcript: Array<{ role: string; text: string; parts?: readonly unknown[] }>
  contaminationState: "clean" | "external-context"
}> {
  if (!job.sessionId) throw new MemoryJobTerminalError("session_missing")
  const [settings, session, messages] = await Promise.all([
    getSettings(),
    getSession(job.sessionId),
    listMessages(job.sessionId),
  ])
  if (!settings || !session) throw new MemoryJobTerminalError("session_unavailable")
  const config = effectiveConfig(settings, session)
  const fullTranscript = messages.map((message) => ({
    role: message.role,
    text: extractPlainText(message.parts),
    parts: message.parts,
  }))
  const checkpointLength = jobTranscriptCheckpoint(job)
  if (checkpointLength === undefined || checkpointLength > fullTranscript.length) {
    throw new MemoryJobProcessingError("transcript_checkpoint_unavailable")
  }
  const transcript = fullTranscript.slice(0, checkpointLength)
  const externalContext = detectMemoryExternalContext(transcript)
  const policy = resolveMemoryTurnPolicy({ config, session, externalContext })
  if (!policy.canLearn) {
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
  }
}

/**
 * Learning jobs intentionally persist only source identities, never transcript
 * content. Their dedupe key therefore doubles as the durable transcript
 * checkpoint: recovery must replay the conversation prefix that existed when
 * the job was enqueued, not whatever newer messages exist when a worker starts.
 */
function jobTranscriptCheckpoint(job: MemoryJob): number | undefined {
  const match = job.dedupeKey.match(/:(\d+)$/)
  if (!match) return undefined
  const length = Number(match[1])
  return Number.isSafeInteger(length) && length > 0 ? length : undefined
}

function lastCompletedPair(
  transcript: Array<{ role: string; text: string }>
): { userText: string; assistantText: string } | undefined {
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
      return { userText: message.text, assistantText: transcript[assistantIndex]!.text }
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
    await updateMemory(memoryId, {
      evidenceState: "supported",
      reviewStatus: operation.op === "CONFLICT" ? "conflict" : "unreviewed",
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

async function processTurnExtraction(job: MemoryJob): Promise<void> {
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
      newPair: pair,
      recentMessages: context.transcript.slice(-10),
      scope: job.scope,
      characterId: job.characterId,
      projectId: job.projectId,
      provenance: job.provenance,
      source: { sessionId: job.sessionId },
      config: context.config,
    },
    deps
  )
  await recordRecoveredOperations(job, result.applied, context.contaminationState)
}

async function processSessionDistill(job: MemoryJob): Promise<void> {
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
      provenance: job.provenance,
      contaminationState: context.contaminationState,
      source: { sessionId: job.sessionId },
      config: context.config,
    },
    deps
  )
}

async function processVectorReconcile(): Promise<void> {
  const settings = await getSettings()
  const config = resolveMemoryConfig(settings?.memory)
  const { tryBuildMemoryVectorSink } = await import("@/lib/memory/runtime/build-deps")
  const sink = await tryBuildMemoryVectorSink(config)
  if (!sink) throw new MemoryJobProcessingError("vector_backend_unavailable")
  const rows = await listMemories({ status: "active" })
  for (const row of rows) {
    if (row.vectorDocId || !hasNoLeakingPii(row.text)) continue
    await sink.upsert(row.id, row.text)
    await updateMemory(row.id, { vectorDocId: row.id })
  }
}

export async function processMemoryJob(job: MemoryJob): Promise<void> {
  if (job.kind === "turn-extraction") return processTurnExtraction(job)
  if (job.kind === "session-distill") return processSessionDistill(job)
  return processVectorReconcile()
}

const defaultWorkerDeps: MemoryJobWorkerDeps = {
  claimNext: claimNextMemoryJob,
  complete: completeMemoryJob,
  fail: failMemoryJob,
  process: processMemoryJob,
}
