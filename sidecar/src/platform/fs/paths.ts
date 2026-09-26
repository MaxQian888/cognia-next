// Path resolution and containment for tools that take filesystem paths.
//
// Pure: no I/O beyond path canonicalisation.

import fs from "node:fs"
import path from "node:path"

/** Resolve a possibly-relative tool path against the session cwd. */
export function resolveToolPath(cwd: string | undefined, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd ?? process.cwd(), p)
}

/** The symlink-resolved path, or null when it does not exist (or cannot be read). */
export function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/**
 * Canonicalise a path that may not exist yet (write targets). Resolves the
 * longest existing ancestor via realpath — so platform symlinks like macOS's
 * `/var` -> `/private/var` are collapsed the same way the root is — then
 * re-appends the not-yet-created trailing segments. Without this, a write
 * target under a symlinked temp dir is compared lexically against a realpath'd
 * root and falsely reported as escaping it.
 */
export function canonicalisePartial(absTarget: string): string {
  let current = absTarget
  const missing: string[] = [] // segments collected deepest-first
  for (;;) {
    const real = safeRealpath(current)
    if (real !== null) {
      return missing.length ? path.join(real, ...missing.reverse()) : real
    }
    const parent = path.dirname(current)
    if (parent === current) break // reached the filesystem root; nothing exists
    missing.push(path.basename(current))
    current = parent
  }
  return absTarget
}

/**
 * Canonicalise both root and target, then assert that target lives inside
 * root, returning the canonical target. Mirrors the Tauri side's
 * `fs_read_workspace_file` guard (src-tauri/src/files.rs:240-260). Throws with
 * a clear message on escape.
 */
export function assertPathInside(rootCwd: unknown, target: unknown): string {
  if (typeof rootCwd !== "string" || rootCwd.length === 0) {
    throw new Error("rootCwd must be a non-empty string")
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("target must be a non-empty string")
  }
  const absRoot = path.resolve(rootCwd)
  const absTarget = path.isAbsolute(target) ? target : path.resolve(absRoot, target)
  // Use realpath where possible so symlink escapes are caught. Fall back to
  // the lexically resolved path when the target doesn't exist yet (e.g.
  // before file_write).
  const canonicalRoot = safeRealpath(absRoot) ?? absRoot
  const canonicalTarget = canonicalisePartial(absTarget)
  // Normalise trailing separators so a root of "/a" doesn't accept "/aa".
  const rootWithSep = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(rootWithSep)) {
    throw new Error(`path escapes root: ${canonicalTarget} (root: ${canonicalRoot})`)
  }
  return canonicalTarget
}

/**
 * Convenience wrapper for tools that don't take a custom root: defends
 * against absolute paths that point at filesystem roots the user clearly
 * didn't intend to expose. Currently a no-op pass-through — the SDK's own
 * `additionalDirectories` mechanism is the primary scope guard. We keep this
 * indirection so a future "user-confined sandbox" mode has a single place
 * to plug in.
 */
export function normaliseAbsolutePath(target: unknown): string {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("path must be a non-empty string")
  }
  return path.resolve(target)
}
