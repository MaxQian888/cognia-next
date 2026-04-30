/**
 * Top-level type barrel — used by upstream-style imports of `@/types`.
 *
 * Keep this slim; only re-export type modules we have definitions for.
 */

export * from "./agent"
export * from "./mcp"
export * from "./artifact"

// `Skill` is intentionally NOT re-exported here. Always import it from
// `@/lib/claude/types` (cognia-next's authoritative shape) so we don't
// fork the model. See `lib/skills/executor.ts` for the bridge to the
// External Agent instruction stack.

/**
 * Project stub — referenced by `lib/ai/instructions/external-agent-instruction-stack.ts`.
 * cognia-next does not yet have a Project model; we expose a minimal
 * shape so the instruction stack typechecks. Replace when a real
 * project layer is migrated.
 */
export interface Project {
  id: string
  name: string
  description?: string
  rootDir?: string
  customInstructions?: string
  knowledgeBase?: unknown[]
  metadata?: Record<string, unknown>
}
