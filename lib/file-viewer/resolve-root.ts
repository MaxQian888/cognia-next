/**
 * Which workspace root an absolute path belongs to, and where inside it.
 *
 * Pure — the roots are injected, so this module imports no store and can be
 * tested without one. The store-aware wrapper lives in `./open.ts`.
 *
 * Deliberately NOT the terminal session's `cwd`. A shell's working directory is
 * rewritten at runtime by OSC events (`lib/terminal/spawn-orchestrator.ts` calls
 * `setSessionCwd` on every `cwd_changed`), so using it as a boundary means
 * `cd /` widens the confinement to the whole filesystem while `cd src` narrows
 * it enough to break links to sibling files that worked a moment earlier. A
 * boundary that moves when the user types is not a boundary.
 */
import { isPathWithinRoot, normalizeFsPath } from "@/lib/files/permissions"

export interface FileViewerTarget {
  root: string
  /** POSIX-separated, relative to `root`, never empty and never containing `..`. */
  relPath: string
}

/**
 * Fails closed: returns `null` for a path outside every root, for a path that
 * *is* a root (a directory, not a file), for an unnormalizable path, and for
 * an empty root set.
 */
export function resolveViewerTarget(
  absolutePath: string,
  roots: readonly string[]
): FileViewerTarget | null {
  const target = normalizeFsPath(absolutePath)
  // `normalizeFsPath` returns "" for the ambiguous shapes — a drive-relative
  // `C:foo` with no cwd to resolve against, or an empty input.
  if (!target) return null

  let best: { root: string; normalized: string } | null = null
  for (const candidate of roots) {
    const normalized = normalizeFsPath(candidate)
    if (!normalized) continue
    if (!isPathWithinRoot(target, normalized)) continue
    // Deepest wins, so a nested worktree claims its own files rather than
    // leaving them attributed to the parent checkout that also contains them.
    if (best === null || normalized.length > best.normalized.length) {
      best = { root: candidate, normalized }
    }
  }
  if (!best) return null

  const relPath = target.slice(best.normalized.length).replace(/^\/+/, "")
  // Empty means the path *is* the root: a directory, which has no viewer.
  if (!relPath) return null
  // Unreachable after a lexical normalize, which resolves `..` without ever
  // popping above the rooting prefix — asserted rather than assumed, because
  // everything downstream treats this value as already safe.
  if (relPath.split("/").includes("..")) return null
  return { root: best.root, relPath }
}
