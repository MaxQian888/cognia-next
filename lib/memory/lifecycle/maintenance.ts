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
import type { MemoryConfig, MemoryProvenance, MemoryScope } from "@/types/memory/memory"
import {
  runEpisodicDistill,
  type RunEpisodicDistillDeps,
} from "@/lib/memory/write/run-episodic-distill"
import { evictOverflow, expireStale, type DecayDeps } from "@/lib/memory/forget/decay"

export interface MemoryMaintenanceInput {
  transcript: { role: string; text: string }[]
  scope: MemoryScope
  characterId?: string
  provenance: MemoryProvenance
  source?: { sessionId?: string }
  config: MemoryConfig
  /** Clock injection for `expireStale` (tests); defaults to `Date.now()`. */
  now?: number
}

export interface MemoryMaintenanceDeps {
  distillDeps: RunEpisodicDistillDeps
  decayDeps: DecayDeps
}

/** Pure core: distill the session's episodes, then evict scope overflow. */
export async function runMemoryMaintenance(
  input: MemoryMaintenanceInput,
  deps: MemoryMaintenanceDeps
): Promise<void> {
  await runEpisodicDistill(
    {
      transcript: input.transcript,
      scope: input.scope,
      characterId: input.characterId,
      provenance: input.provenance,
      source: input.source,
      config: input.config,
    },
    deps.distillDeps
  )
  // Global-scope memories are persisted with `characterId: undefined` (see
  // `Memory.characterId` — "Set iff scope === character"). The decay queries
  // filter rows by characterId, so passing a session's characterId while the
  // active scope is global matches *nothing*: eviction/expiry silently no-op and
  // `maxActivePerScope` is never enforced. Drop characterId for non-character
  // scopes, mirroring how the write path nulls it for global memories.
  const decayCharacterId = input.scope === "character" ? input.characterId : undefined
  await evictOverflow(
    {
      scope: input.scope,
      characterId: decayCharacterId,
      maxActivePerScope: input.config.maxActivePerScope,
    },
    deps.decayDeps
  )
  // Access-time forgetting (opt-in via `maxIdleDays > 0`; a no-op otherwise).
  // Runs on the same scope as eviction, so it forgets stale memories across the
  // active scope whenever maintenance fires.
  await expireStale(
    {
      scope: input.scope,
      characterId: decayCharacterId,
      maxIdleDays: input.config.maxIdleDays ?? 0,
      now: input.now,
    },
    deps.decayDeps
  )
}

// Once-per-session guard (per app run). Exposed for test reset.
const distilledSessions = new Set<string>()
export const __resetMaintenanceGuard = () => distilledSessions.clear()

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
  if (!config.enabled || !config.autoExtract || config.temporary) return
  if (params.provenance === "inbound") return
  if (distilledSessions.has(sessionId)) return

  const minTurns = params.minAssistantTurns ?? 2
  const assistantTurns = params.transcript.filter((m) => m.role === "assistant").length
  if (assistantTurns < minTurns) return

  distilledSessions.add(sessionId)
  onIdle(() => {
    void (async () => {
      try {
        const [{ buildEpisodicMaintenanceDeps }] = await Promise.all([
          import("./build-maintenance-deps"),
        ])
        const deps = await buildEpisodicMaintenanceDeps(
          { session: params.session, appSettings: params.appSettings },
          config
        )
        if (!deps) {
          distilledSessions.delete(sessionId) // allow a retry next turn
          return
        }
        await runMemoryMaintenance(
          {
            transcript: params.transcript,
            scope: config.scopeDefault,
            characterId: params.session?.characterId,
            provenance: params.provenance,
            source: { sessionId },
            config,
          },
          deps
        )
      } catch {
        // best-effort
      }
    })()
  })
}
