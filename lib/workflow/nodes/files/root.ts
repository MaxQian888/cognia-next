/**
 * Root resolution for the `action.fs.*` nodes.
 *
 * Every `lib/files/workspace-fs.ts` operation is addressed as `(root,
 * relPath)`, and the Host canonicalises both and refuses anything that escapes
 * `root`. Confinement is therefore structural rather than a check this module
 * adds. What this module owns is the *other* half: which root, resolved so that
 * the same saved workflow means something on a desktop, on the cloud brain, and
 * against a remote Host.
 *
 * That is why the node takes a root *selector* and not a path. An absolute path
 * authored on a desktop (`/Users/me/proj`) is refused outright by a brain whose
 * only browsable root is `COGNIA_WORKSPACES_DIR`, so baking one in would make
 * every fs node a desktop-only node by accident.
 *
 * The ladder mirrors `source-control/repo-target.ts:resolveRepo`, with one
 * rung added and one removed:
 *
 *   - added `host-default`, because a Host *declares* its roots
 *     (`fs_workspace_roots`). On a server that is an exact answer, not a guess,
 *     and it is the rung that makes a workflow portable.
 *   - no Source Control panel rung. A panel selection is a real answer while
 *     someone is watching and an empty one for exactly the runs that need it
 *     most, and the fs nodes have `host-default` to fall back on instead.
 */

import { listWorkspaceRoots } from "@/lib/files/workspace-fs"
import { nonRetryable } from "../shared/executor-support"
import type { StepExecutionContext } from "@/types/workflow/visual"

export type FsRootMode = "project" | "host-default" | "explicit"

/** How the resolved root was chosen. Echoed in every node's output. */
export interface ResolvedFsRoot {
  root: string
  mode: FsRootMode
}

function trimmedString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function fsRootMode(params: Record<string, unknown>): FsRootMode {
  const raw = params.rootMode
  return raw === "explicit" || raw === "host-default" ? raw : "project"
}

/**
 * Resolve the workspace root this step addresses.
 *
 * `explicit` is passed through verbatim. This module deliberately does NOT
 * check it against `listWorkspaceRoots()`: the authoritative answer is
 * per-Host (`authorize_workspace_root` in the companion RPC layer), a remote
 * Host's roots are not the local Host's, and a second opinion here would refuse
 * paths the Host would have accepted while adding no safety the Host does not
 * already provide.
 */
export async function resolveFsRoot(ctx: StepExecutionContext): Promise<ResolvedFsRoot> {
  const params = ctx.params as Record<string, unknown>
  const mode = fsRootMode(params)

  if (mode === "explicit") {
    const explicit = trimmedString(params, "rootPath")
    if (!explicit) {
      throw nonRetryable("action.fs: rootMode is 'explicit' but rootPath is empty")
    }
    return { root: explicit, mode }
  }

  if (mode === "project") {
    const projectId = trimmedString(params, "projectId") ?? ctx.projectId
    if (projectId) {
      const root = await workspacePrimaryRoot(projectId)
      if (root) return { root, mode }
    }
  }

  const declared = await listWorkspaceRoots()
  if (declared.length > 0) return { root: declared[0].path, mode: "host-default" }

  throw nonRetryable(
    "action.fs: no workspace root. Bind the run to a workspace, set rootMode to " +
      "'explicit' with a rootPath, or open a folder this Host will browse."
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
    // No database on this host (a test harness, a stripped runtime). Fall
    // through to the declared-roots rung rather than failing the node here.
    return undefined
  }
}

/**
 * Validate an authored `relPath`.
 *
 * The security boundary is Rust, which canonicalises and range-checks. This is
 * an error-quality gate: an absolute path or a `..` prefix is always an
 * authoring mistake, and saying so by name beats a Host refusal that names a
 * canonicalised path the author never wrote.
 */
export function requireRelPath(params: Record<string, unknown>, key: string, kind: string): string {
  const value = trimmedString(params, key)
  if (!value) throw nonRetryable(`${kind} requires '${key}'`)
  assertRelative(value, key, kind)
  return value
}

export function optionalRelPath(
  params: Record<string, unknown>,
  key: string,
  kind: string
): string | undefined {
  const value = trimmedString(params, key)
  if (value === undefined) return undefined
  assertRelative(value, key, kind)
  return value
}

function assertRelative(value: string, key: string, kind: string): void {
  const normalized = value.replace(/\\/g, "/")
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw nonRetryable(
      `${kind}: '${key}' must be relative to the workspace root, not an absolute path`
    )
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw nonRetryable(`${kind}: '${key}' must not escape the workspace root`)
  }
}
