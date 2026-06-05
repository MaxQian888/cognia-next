/**
 * Task-aware tool selection — lexical scoring layer.
 *
 * Synchronous heuristics (token overlap between the task text and a
 * tool's name/description) used by the custom-mode helpers to rank a
 * recommended tool subset. The ASYNC semantic layer (embedding-based
 * matching with persisted routes) lives in
 * `lib/ai/routing/semantic-tool-router.ts`; this module stays sync
 * because its callers score candidates inline during render.
 */

export interface TaskAwareSelectionOptions<T = string> {
  available: T[]
  task?: string
  maxSelected?: number
}

/** Tokenize for overlap scoring: lowercase word stems ≥3 chars. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9一-鿿]+/)
      .filter((token) => token.length >= 3 || /[一-鿿]/.test(token))
  )
}

function overlapScore(taskTokens: Set<string>, text: string): number {
  if (taskTokens.size === 0 || !text) return 0
  const candidateTokens = tokenize(text)
  if (candidateTokens.size === 0) return 0
  let hits = 0
  for (const token of candidateTokens) {
    if (taskTokens.has(token)) hits++
  }
  // Normalize by the smaller set so short tool names aren't penalized.
  return hits / Math.min(taskTokens.size, candidateTokens.size)
}

function describe(candidate: unknown): string {
  if (typeof candidate === "string") return candidate.replace(/[_.-]+/g, " ")
  if (candidate && typeof candidate === "object") {
    const obj = candidate as TaskAwareToolDescriptor
    return [obj.name ?? obj.id ?? "", obj.description ?? "", obj.serverName ?? ""]
      .join(" ")
      .replace(/[_.-]+/g, " ")
  }
  return ""
}

/**
 * Rank the available tools by lexical relevance to the task and return
 * the top `maxSelected`. Without a task (or with no signal at all) the
 * original order is preserved — the historical identity behavior.
 */
export function selectToolsForTask<T = string>(options: TaskAwareSelectionOptions<T>): T[] {
  const max = Math.max(0, options.maxSelected ?? options.available.length)
  const task = options.task?.trim()
  if (!task) return options.available.slice(0, max)

  const taskTokens = tokenize(task)
  const scored = options.available.map((candidate, index) => ({
    candidate,
    index,
    score: overlapScore(taskTokens, describe(candidate)),
  }))
  if (scored.every((s) => s.score === 0)) {
    return options.available.slice(0, max)
  }
  // Stable: score desc, original order as tiebreak.
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, max).map((s) => s.candidate)
}

export interface ToolCandidateScore {
  toolId: string
  score: number
  /** Cognia legacy: callers read `relevanceScore` for display. */
  relevanceScore: number
  reason?: string
}

export interface TaskAwareToolDescriptor {
  name?: string
  id?: string
  description?: string
  serverId?: string
  serverName?: string
  [key: string]: unknown
}

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

function taskText(task?: TaskAwareTaskContext): string {
  if (!task) return ""
  if (typeof task === "string") return task
  return [task.query ?? "", task.conversationContext ?? "", task.activeMode ?? ""]
    .filter(Boolean)
    .join(" ")
}

/**
 * Score one candidate against the task context. A neutral 0.5 is returned
 * when there is no task signal (the historical shape); otherwise the
 * lexical overlap is mapped into [0.05, 1] so "no overlap" is visibly
 * ranked below neutral.
 */
export function scoreTaskAwareToolCandidate(
  candidate: string | TaskAwareToolDescriptor | Record<string, unknown>,
  task?: TaskAwareTaskContext
): ToolCandidateScore {
  const toolId =
    typeof candidate === "string"
      ? candidate
      : ((candidate as TaskAwareToolDescriptor).id ??
        (candidate as TaskAwareToolDescriptor).name ??
        "unknown")

  const text = taskText(task)
  if (!text.trim()) {
    return { toolId, score: 0.5, relevanceScore: 0.5 }
  }

  const overlap = overlapScore(tokenize(text), describe(candidate))
  // Map raw overlap into a usable range: 0 → 0.05 (clearly irrelevant),
  // 1 → 1.0 (every task token matched).
  const score = Math.min(1, 0.05 + overlap * 0.95)
  return {
    toolId,
    score,
    relevanceScore: score,
    reason: overlap > 0 ? "lexical-overlap" : "no-overlap",
  }
}
