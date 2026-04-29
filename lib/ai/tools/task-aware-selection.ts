/**
 * Minimal task-aware-selection stub.
 *
 * The Cognia custom-mode helpers use this to pick a recommended tool
 * subset based on the active task. cognia-next does not yet have that
 * heuristic layer; we expose an identity selector so existing code
 * compiles without changing behavior.
 */

export interface TaskAwareSelectionOptions<T = string> {
  available: T[]
  task?: string
  maxSelected?: number
}

export function selectToolsForTask<T = string>(options: TaskAwareSelectionOptions<T>): T[] {
  const max = options.maxSelected ?? options.available.length
  return options.available.slice(0, Math.max(0, max))
}

export interface ToolCandidateScore {
  toolId: string
  score: number
  /** Cognia legacy: callers read `relevanceScore` for display. */
  relevanceScore: number
  reason?: string
}

/**
 * Stub scoring function — returns a flat 0.5 score so callers receive
 * a deterministic shape without ranking heuristics. Accepts either a
 * tool id string or any tool descriptor object (Cognia's helpers pass
 * the full descriptor with name / description / serverId).
 */
export interface TaskAwareToolDescriptor {
  name?: string
  id?: string
  description?: string
  serverId?: string
  serverName?: string
  [key: string]: unknown
}

/**
 * Accepts the upstream candidate shape (string id, descriptor object, or
 * a free-form context bag with `query`/`conversationContext`/`activeMode`
 * — the latter is how Cognia helpers pass scoring metadata).
 */
/**
 * The "task" half of the scoring call — Cognia helpers pass either a raw
 * string or a context bag (`query`, `conversationContext`, `activeMode`).
 */
export type TaskAwareTaskContext =
  | string
  | {
      query?: string
      conversationContext?: string
      activeMode?: string
      [key: string]: unknown
    }

export function scoreTaskAwareToolCandidate(
  candidate: string | TaskAwareToolDescriptor | Record<string, unknown>,
  _task?: TaskAwareTaskContext
): ToolCandidateScore {
  if (typeof candidate === "string") {
    return { toolId: candidate, score: 0.5, relevanceScore: 0.5 }
  }
  const obj = candidate as TaskAwareToolDescriptor
  const toolId = obj.id ?? obj.name ?? "unknown"
  return { toolId, score: 0.5, relevanceScore: 0.5 }
}
