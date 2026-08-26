/**
 * Where a plan's steps run.
 *
 * # The directory
 *
 * `agent_turn` steps dispatched `executeAgent` with no `cwd` at all, so every
 * plan ran wherever the app's default happened to point — not in the workspace
 * the plan belongs to. That reads as "the agent ignored my repository", and it
 * is wrong at any concurrency, not only in parallel.
 *
 * The root is resolved once per run, from the plan's own workspace, and every
 * step of the run shares it. Per-STEP isolation would be worse than none: a
 * plan is one piece of work, and step 3 that cannot see what step 2 wrote is
 * not a plan at all. That is the difference from an Agent Team, whose members
 * are doing independent things and reconcile at the end.
 *
 * # The slot
 *
 * Sharing one directory is right and is exactly why parallel steps must not
 * overlap in it. `maxConcurrency` admits several steps at once; two agents
 * editing one checkout at the same time interleave edits, builds and git
 * operations, which is the corruption `lib/execution/slot-key.ts` exists to
 * prevent. Steps therefore take the execution slot for their directory, which
 * serializes the ones that write while leaving approval gates, MCP calls and
 * anything with no directory to run in parallel as before.
 */

import type { AgentPlan } from "@/types/agent/plan"

/** The directory a plan run works in, and how it was found. */
export interface PlanExecutionRoot {
  root: string
  /**
   * `workspace` — the plan's workspace primary root.
   * `session` — the chat session's own working directory.
   *
   * Recorded because a plan that ran somewhere surprising is a question the
   * run log should be able to answer.
   */
  source: "workspace" | "session"
}

export interface ResolvePlanExecutionRootDeps {
  /** The workspace row, for its mounted roots. */
  loadWorkspace: (projectId: string) => Promise<{ roots?: unknown } | undefined>
  /** The chat session, for its own working directory. */
  loadSession: (sessionId: string) => Promise<{ workingDir?: string | null } | undefined>
}

function defaultDeps(): ResolvePlanExecutionRootDeps {
  return {
    loadWorkspace: async (projectId) => {
      const { getDb } = await import("@/lib/db/schema")
      return getDb().projects.get(projectId)
    },
    loadSession: async (sessionId) => {
      const { getDb } = await import("@/lib/db/schema")
      return getDb().sessions.get(sessionId)
    },
  }
}

/**
 * The directory this plan's steps should run in, or undefined when it has none.
 *
 * Undefined is a real answer, not a failure: a plan created in a session with
 * no workspace and no working directory has nothing to point an agent at, and
 * inventing a path would be worse than letting the runner use its own default.
 * The caller then also skips the execution slot — there is no directory to
 * exclude anyone from.
 */
export async function resolvePlanExecutionRoot(
  plan: Pick<AgentPlan, "projectId" | "sessionId">,
  overrides: Partial<ResolvePlanExecutionRootDeps> = {}
): Promise<PlanExecutionRoot | undefined> {
  const deps = { ...defaultDeps(), ...overrides }

  if (plan.projectId) {
    const workspace = await deps.loadWorkspace(plan.projectId).catch(() => undefined)
    const root = primaryRootPath(workspace)
    if (root) return { root, source: "workspace" }
  }

  if (plan.sessionId) {
    const session = await deps.loadSession(plan.sessionId).catch(() => undefined)
    const workingDir = session?.workingDir?.trim()
    if (workingDir) return { root: workingDir, source: "session" }
  }

  return undefined
}

/**
 * The workspace's primary root path.
 *
 * Read through `primaryRootOf` rather than by indexing `roots[0]`, because the
 * primary is a flag on the row and not a position — the workspace's own
 * ordering is not the answer.
 */
function primaryRootPath(workspace: { roots?: unknown } | undefined): string | undefined {
  const roots = workspace?.roots
  if (!Array.isArray(roots) || roots.length === 0) return undefined
  const primary = roots.find((root) => (root as { isPrimary?: boolean })?.isPrimary) ?? roots[0]
  const path = (primary as { path?: unknown })?.path
  return typeof path === "string" && path.trim() ? path.trim() : undefined
}
