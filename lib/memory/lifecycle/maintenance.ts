/**
 * Idle memory maintenance — episodic distillation + capacity eviction.
 *
 * There is no explicit "session ended" event, so maintenance is triggered on an
 * idle tick after a turn completes (a good proxy) and guarded to run at most
 * once per session per app run. The pure core (`runMemoryMaintenance`) is
 * dependency-injected; `scheduleMemoryMaintenance` wires the real backends and
 * schedules the work off the hot path.
 */

import type { ChatSession, AppSettings } from "@cognia/agent-config-types"
import type {
  MemoryConfig,
  MemoryContaminationState,
  MemoryProvenance,
  MemoryScope,
} from "@/types/memory/memory"
import {
  runEpisodicDistill,
  type RunEpisodicDistillDeps,
} from "@/lib/memory/write/run-episodic-distill"
import { evictOverflow, expireStale, type DecayDeps } from "@/lib/memory/forget/decay"
import type { ConsolidationOp } from "@/lib/memory/consolidate/consolidator"

export interface MemoryMaintenanceInput {
  transcript: { role: string; text: string }[]
  scope: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  provenance: MemoryProvenance
  contaminationState?: MemoryContaminationState
  source?: { sessionId?: string }
  config: MemoryConfig
  /** Clock injection for `expireStale` (tests); defaults to `Date.now()`. */
  now?: number
}

/** What a decay pass invalidated, for the audit trail. */
export interface MemoryDecayRecord {
  /** `capacity` = over `maxActivePerScope`; `idle` = untouched past `maxIdleDays`. */
  reason: "capacity" | "idle"
  memoryIds: string[]
  sessionId?: string
}

export interface MemoryMaintenanceDeps {
  distillDeps: RunEpisodicDistillDeps
  decayDeps: DecayDeps
  recordDistillation?: (
    input: MemoryMaintenanceInput,
    operations: ConsolidationOp[]
  ) => Promise<void>
  /**
   * Audit what decay removed. Without this, eviction and idle-expiry are
   * invisible: `deps.invalidate` writes no audit event, so a user who set
   * `maxIdleDays` has no way to tell whether it ever fired.
   */
  recordDecay?: (record: MemoryDecayRecord) => Promise<void>
}

/** Pure core: distill the session's episodes, then evict scope overflow. */
export async function runMemoryMaintenance(
  input: MemoryMaintenanceInput,
  deps: MemoryMaintenanceDeps
): Promise<void> {
  const result = await runEpisodicDistill(
    {
      transcript: input.transcript,
      scope: input.scope,
      characterId: input.characterId,
      projectId: input.projectId,
      agentId: input.agentId,
      branch: input.branch,
      pathPattern: input.pathPattern,
      provenance: input.provenance,
      source: input.source,
      config: input.config,
    },
    deps.distillDeps
  )
  await deps.recordDistillation?.(input, result.applied)
  // Global-scope memories are persisted with `characterId: undefined` (see
  // `Memory.characterId` — "Set iff scope === character"). The decay queries
  // filter rows by characterId, so passing a session's characterId while the
  // active scope is global matches *nothing*: eviction/expiry silently no-op and
  // `maxActivePerScope` is never enforced. Drop characterId for non-character
  // scopes, mirroring how the write path nulls it for global memories.
  const decayNamespace = {
    characterId: input.scope === "character" ? input.characterId : undefined,
    projectId: input.projectId,
    agentId: input.scope === "agent" ? input.agentId : undefined,
    branch: input.branch,
    pathPattern: input.pathPattern,
  }
  const { evicted } = await evictOverflow(
    {
      scope: input.scope,
      ...decayNamespace,
      maxActivePerScope: input.config.maxActivePerScope,
    },
    deps.decayDeps
  )
  if (evicted.length > 0) {
    await deps.recordDecay?.({
      reason: "capacity",
      memoryIds: evicted,
      sessionId: input.source?.sessionId,
    })
  }
  // Access-time forgetting (opt-in via `maxIdleDays > 0`; a no-op otherwise).
  // Runs on the same scope as eviction, so it forgets stale memories across the
  // active scope whenever maintenance fires.
  const { expired } = await expireStale(
    {
      scope: input.scope,
      ...decayNamespace,
      maxIdleDays: input.config.maxIdleDays ?? 0,
      now: input.now,
    },
    deps.decayDeps
  )
  if (expired.length > 0) {
    await deps.recordDecay?.({
      reason: "idle",
      memoryIds: expired,
      sessionId: input.source?.sessionId,
    })
  }
}

// Scheduling is deduped durably by `(session, transcript length)` in memoryJobs.
// Retained as a compatibility test hook; no process-local correctness state remains.
export const __resetMaintenanceGuard = () => undefined

function onIdle(fn: () => void): void {
  const g = globalThis as { requestIdleCallback?: (cb: () => void) => void }
  if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(fn)
  else setTimeout(fn, 0)
}

export interface ScheduleMemoryMaintenanceParams {
  sessionId: string
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  transcript: { role: string; text: string }[]
  provenance: MemoryProvenance
  contaminationState?: MemoryContaminationState
  config: MemoryConfig
  /** Min assistant turns before a session is worth distilling. Default 2. */
  minAssistantTurns?: number
}

/**
 * Fire-and-forget: schedule one maintenance pass for a session on the next idle
 * tick. No-ops if memory is off, the session was already distilled this run, or
 * the conversation is too short. Never throws.
 */
export function scheduleMemoryMaintenance(params: ScheduleMemoryMaintenanceParams): void {
  const { config, sessionId } = params
  if (!config.enabled || !config.learnFromChats || config.temporary) return
  if (params.provenance === "inbound") return

  const minTurns = params.minAssistantTurns ?? 2
  const assistantTurns = params.transcript.filter((m) => m.role === "assistant").length
  if (assistantTurns < minTurns) return

  void (async () => {
    // Piggyback the day-bucketed vector drift sweep on the same idle tick —
    // the worker loop drains it; at most one sweep per day.
    const { enqueueDailyVectorReconcile } = await import("./enqueue-reconcile")
    void enqueueDailyVectorReconcile()

    const { enqueueMemoryJob } = await import("@/lib/db/memory-governance")
    const job = await enqueueMemoryJob(
      {
        dedupeKey: `session-distill:${sessionId}:${params.transcript.length}`,
        kind: "session-distill",
        sessionId,
        projectId: params.session?.projectId,
        characterId: params.session?.characterId,
        agentId: config.scopeDefault === "agent" ? params.session?.characterId : undefined,
        scope: config.scopeDefault,
        provenance: params.provenance,
        evidenceIds: [],
      },
      { reuseCompleted: true }
    )
    onIdle(() => {
      void (async () => {
        try {
          const { claimMemoryJob, completeMemoryJob, failMemoryJob } =
            await import("@/lib/db/memory-governance")
          const claimed = await claimMemoryJob(job.id, "renderer-memory-maintenance")
          if (!claimed) return
          const [{ buildEpisodicMaintenanceDeps }] = await Promise.all([
            import("./build-maintenance-deps"),
          ])
          const deps = await buildEpisodicMaintenanceDeps(
            { session: params.session, appSettings: params.appSettings },
            config
          )
          if (!deps) {
            await failMemoryJob(job.id, "dependencies_unavailable")
            return
          }
          await runMemoryMaintenance(
            {
              transcript: params.transcript,
              scope: config.scopeDefault,
              characterId: params.session?.characterId,
              projectId: params.session?.projectId,
              agentId: config.scopeDefault === "agent" ? params.session?.characterId : undefined,
              provenance: params.provenance,
              contaminationState: params.contaminationState,
              source: { sessionId },
              config,
            },
            deps
          )
          await completeMemoryJob(job.id)
        } catch {
          const { failMemoryJob } = await import("@/lib/db/memory-governance")
          await failMemoryJob(job.id, "maintenance_failed").catch(() => undefined)
        }
      })()
    })
  })().catch(() => undefined)
}
