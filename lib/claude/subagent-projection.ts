/**
 * Shared store-projection helpers for the two subagent execution engines.
 *
 * Concept A (SDK-native `Task`, projected by `sdk-subagent-bridge.ts`) and
 * Concept B (`dispatch_agent`, projected by `dispatch-runtime.ts`) run in
 * different places but both fold their runs into the SAME
 * `subagent-runtime-store` as `SubAgent` nodes. The node seed and the
 * indeterminate-progress heuristic were previously duplicated verbatim in both
 * bridges; this module is the single source so a `SubAgent`-shape change or a
 * heuristic tweak lands in one place.
 *
 * Pure — no React, no store. Both bridges import from here.
 */

import type { SubAgent } from "@/types/agent/sub-agent"

/**
 * Indeterminate progress from the number of tool calls a run has made so far.
 * A real subagent has no completion percentage, so this rises monotonically and
 * is capped below 100 (only an explicit "completed" transition reaches 100).
 * 10% per tool call, capped at 95%.
 */
export function indeterminateSubagentProgress(toolCount: number): number {
  return Math.min(95, Math.max(0, toolCount) * 10)
}

/** Fields a caller supplies; everything else gets the shared "fresh run" seed. */
export interface SubAgentNodeSeed {
  /** Unique run id (also the tree node id + thread id). */
  id: string
  /** Display name (usually the subagent id). */
  name: string
  /** The prompt/task handed to the subagent. */
  task: string
  /** Parent agent identity (chat sentinel, a session id, or a spawning agent). */
  parentAgentId: string
  /** Nesting level (1 = dispatched by top-level chat). */
  depth: number
  /** Spawning subagent RUN id (the tree edge). */
  parentSubagentId?: string
  /** Originating session id; when present, a `context` block is built from it. */
  sessionId?: string
  /** Whether the run was detached. */
  backgrounded?: boolean
}

/**
 * Build a fresh "running" `SubAgent` node with the shared defaults (empty
 * logs/messages/sources, progress 0, toolUses 0, synchronized timestamps).
 */
export function createSubAgentNode(seed: SubAgentNodeSeed): SubAgent {
  const now = new Date()
  return {
    id: seed.id,
    parentAgentId: seed.parentAgentId,
    name: seed.name,
    description: seed.name,
    task: seed.task,
    initialTask: seed.task,
    threadId: seed.id,
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 0,
    toolUses: 0,
    createdAt: now,
    lastActivityAt: now,
    startedAt: now,
    retryCount: 0,
    order: 0,
    depth: seed.depth,
    ...(seed.parentSubagentId ? { parentSubagentId: seed.parentSubagentId } : {}),
    ...(seed.sessionId
      ? {
          context: {
            parentAgentId: seed.parentAgentId,
            sessionId: seed.sessionId,
            startTime: now,
            currentStep: 0,
          },
        }
      : {}),
    ...(seed.backgrounded ? { backgrounded: true } : {}),
  }
}
