/**
 * A recursive workspace listing every Host can answer.
 *
 * `walkWorkspace` (`fs_walk_workspace`) is the one export of `workspace-fs.ts`
 * that does not honour that module's own header: it is registered at
 * `src-tauri/src/lib.rs` and nowhere else, absent from the companion RPC
 * allowlist, from the generated command index, and from the `workspace.files`
 * operation list in the host feature manifest. Calling it from a paired
 * client, the headless brain or a desktop routed to a remote Host hands the
 * caller a raw `unknown_command`. So off the local desktop this degrades to a
 * bounded breadth-first walk built out of `fs_list_workspace_dir`, which
 * every Host answers and which applies the ignore rules per directory.
 *
 * Shared by the workflow `action.fs.list` node and file sharing (ADR-0222).
 */

import { detectPlatform } from "@/lib/platform/detect"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { isSensitiveDirectory, isSensitiveFileName } from "@/lib/filespace/sensitive"
import type { WorkspaceEntry } from "@/lib/files/types"

import {
  listWorkspaceDir,
  walkWorkspace,
  type WorkspaceWalkOptions,
  type WorkspaceWalkResult,
} from "./workspace-fs"

/** Caps for the degraded walk. Mirror `fs_walk_workspace`'s own. */
export const WALK_DEFAULT_MAX_ENTRIES = 5_000
export const WALK_CEILING_MAX_ENTRIES = 50_000
export const WALK_DEFAULT_MAX_DEPTH = 24

/** Whether `fs_walk_workspace` can be reached from here. */
export function canWalkWorkspace(): boolean {
  return detectPlatform() === "tauri" && !isRemoteHostActive()
}

export interface WorkspaceTreeWalkOptions extends WorkspaceWalkOptions {
  /**
   * Apply the sensitive floor (`lib/filespace/sensitive.ts`) to a degraded
   * walk, which the depth-1 command does not report on. The native walk
   * always applies it. Off by default so a caller that never claimed a count
   * keeps reporting `skippedSensitive: 0` for the degraded path.
   */
  sensitiveFloor?: boolean
}

export interface WorkspaceTreeWalk extends WorkspaceWalkResult {
  /** True when the walk was assembled from depth-1 listings. */
  degraded: boolean
}

/** Recursively list `root`/`relPath` on whichever Host the transport reaches. */
export async function walkWorkspaceTree(
  root: string,
  options: WorkspaceTreeWalkOptions = {}
): Promise<WorkspaceTreeWalk> {
  const { sensitiveFloor, ...walkOptions } = options
  if (canWalkWorkspace()) {
    return { ...(await walkWorkspace(root, walkOptions)), degraded: false }
  }
  return { ...(await breadthFirstList(root, walkOptions, Boolean(sensitiveFloor))), degraded: true }
}

function parentAndName(relPath: string): { parent: string | undefined; name: string } {
  const segments = relPath.split("/")
  const name = segments.pop() ?? ""
  return { parent: segments.at(-1), name }
}

/**
 * Breadth-first so a cap truncates the deepest level rather than an arbitrary
 * subtree, which is the same shape `walkWorkspace` reports.
 */
async function breadthFirstList(
  root: string,
  options: WorkspaceWalkOptions,
  sensitiveFloor: boolean
): Promise<WorkspaceWalkResult> {
  const maxEntries = Math.min(
    Math.max(1, options.maxEntries ?? WALK_DEFAULT_MAX_ENTRIES),
    WALK_CEILING_MAX_ENTRIES
  )
  const maxDepth = Math.max(1, options.maxDepth ?? WALK_DEFAULT_MAX_DEPTH)
  const entries: WorkspaceEntry[] = []
  let skippedSensitive = 0
  let queue: Array<{ path: string | undefined; depth: number }> = [
    { path: options.relPath, depth: 0 },
  ]
  let truncated = false

  while (queue.length > 0) {
    const next: Array<{ path: string | undefined; depth: number }> = []
    for (const dir of queue) {
      const children = await listWorkspaceDir(root, dir.path, options.includeIgnored)
      for (const child of children) {
        const { parent, name } = parentAndName(child.relPath)
        if (child.isDir) {
          if (sensitiveFloor && isSensitiveDirectory(parent, name)) {
            skippedSensitive++
            continue
          }
          if (options.includeDirs) {
            if (entries.length >= maxEntries) return { entries, truncated: true, skippedSensitive }
            entries.push(child)
          }
          if (dir.depth + 1 < maxDepth) next.push({ path: child.relPath, depth: dir.depth + 1 })
          else truncated = true
        } else {
          if (sensitiveFloor && isSensitiveFileName(name)) {
            skippedSensitive++
            continue
          }
          if (entries.length >= maxEntries) return { entries, truncated: true, skippedSensitive }
          entries.push(child)
        }
      }
    }
    queue = next
  }
  return { entries, truncated, skippedSensitive }
}
