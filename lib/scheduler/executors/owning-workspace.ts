/**
 * The workspace a scheduled run resolves against: what `resolveSendOptions`
 * sees as the turn's `activeProject`.
 *
 * That is the one named by the run's owning `projectId`, never the one active
 * in the UI (ADR-0144). A schedule fires for the workspace that owns its
 * conversation, which is rarely the one on screen when the timer fires, and
 * often nothing is on screen at all. Goes through `resolveSessionWorkspace`,
 * the resolver interactive chat uses, with no active-workspace fallback. A
 * workspace that no longer exists resolves to `null`, as it does for an
 * interactive turn.
 *
 * Read from Dexie rather than `useProjectStore`: the headless brain and a
 * timer firing before the renderer hydrates have no store to read. A failed
 * read falls back to `null` so the run proceeds as it would with no workspace
 * (no workspace instructions, no workspace roots), and says so.
 *
 * Own module because both the chat-style executors and the headless goal
 * runner resolve it, and the executor index already imports the goal path.
 */

import type { Project } from "@/types"
import { getAllProjects } from "@/lib/db/projects"
import { resolveSessionWorkspace } from "@/lib/workspace/session-workspace"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

export async function loadOwningWorkspace(
  projectId: string | null | undefined,
  logContext: Record<string, string>
): Promise<Project | null> {
  if (!projectId) return null
  try {
    return resolveSessionWorkspace({ projectId }, await getAllProjects())
  } catch (err) {
    log.warn("Scheduler: loading the owning workspace failed; running without it", {
      ...logContext,
      projectId,
      err: String(err),
    })
    return null
  }
}
