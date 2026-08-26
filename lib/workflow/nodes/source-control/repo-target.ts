/**
 * Addressing and param helpers shared by every Source Control workflow node
 * (`action.git.*` and `action.stack.*`).
 *
 * Extracted so the stack nodes resolve their repository the same way the git
 * nodes do — one ladder, one error message, one place to change it.
 */

import { useGitStore } from "@/stores/git/git-store"
import type { StepExecutionContext } from "@/types/workflow/visual"

export function strParam(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

export function boolParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params[key]
  return typeof v === "boolean" ? v : undefined
}

export function pathsParam(params: Record<string, unknown>): string[] {
  const v = params.paths
  if (!Array.isArray(v)) return ["."]
  const paths = v.filter((x): x is string => typeof x === "string" && x.length > 0)
  return paths.length > 0 ? paths : ["."]
}

/**
 * Resolve the target repository for a git node.
 *
 * In order: an explicit `repoPath`, the workspace named on the node, the
 * workspace the run belongs to, and only then the folder open in the Source
 * Control panel.
 *
 * That last rung used to be the only one, which made every git node depend on
 * a UI store. It reads correctly while someone is watching — the panel is open,
 * `rootDir` is set — and is empty for exactly the runs that most need it:
 * scheduled, webhook-triggered, headless, or a placed run on another device,
 * none of which have a panel at all. The node then failed with a message
 * telling the user to open a folder in an app that was not running.
 */
export async function resolveRepo(ctx: StepExecutionContext): Promise<string> {
  const explicit = strParam(ctx.params, "repoPath")
  if (explicit) return explicit

  const projectId = strParam(ctx.params, "projectId") ?? ctx.projectId
  if (projectId) {
    const root = await workspacePrimaryRoot(projectId)
    if (root) return root
  }

  // The panel's selection is a legitimate answer when a person is driving an
  // editor run, and nothing at all otherwise.
  const bound = useGitStore.getState().rootDir
  if (bound) return bound

  throw new Error(
    projectId
      ? `action.git: workspace ${projectId} has no root directory (set repoPath on the node)`
      : "action.git: no repo (set repoPath, bind the run to a workspace, or open a folder in Source Control)"
  )
}

/** The primary root path of a workspace, or undefined when it has none. */
async function workspacePrimaryRoot(projectId: string): Promise<string | undefined> {
  try {
    const [{ getDb }, { primaryRootOf }] = await Promise.all([
      import("@/lib/db/schema"),
      import("@/lib/workspace/roots"),
    ])
    const project = await getDb().projects.get(projectId)
    if (!project) return undefined
    return primaryRootOf(project)?.path?.trim() || undefined
  } catch {
    // No database on this host (a remote step broker, a test harness). Fall
    // through to the remaining rungs rather than failing the whole node here.
    return undefined
  }
}
