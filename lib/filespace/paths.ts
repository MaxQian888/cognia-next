/**
 * FileSpace path grammar (ADR-0222).
 *
 * A FileSpace path is what a link, a share manifest and (later) a live grant
 * carry, so it has exactly one spelling: POSIX, absolute, NFC-normalized, with
 * empty segments collapsed and `.`/`..` refused rather than resolved. Refusing
 * `..` instead of normalizing it is the point: a path that climbs is never one
 * this codebase minted, so it is either a bug or an attack, and resolving it
 * would turn `/workspace/../uploads/x` into a different mount than the one the
 * string started in.
 *
 * The Rust gateway (P2) mirrors these rules; `paths.test.ts` holds the vectors.
 */

import { normalizeFsPath, relativePathWithinRoot } from "@/lib/files/permissions"
import type { ConversationFileSpace, FileSpaceMount, FileSpacePath } from "@/types/filespace"

/** Characters no segment may carry: NUL, other C0 controls, DEL, and the Windows separator. */
const FORBIDDEN_SEGMENT_CHARS = /[\u0000-\u001f\u007f\\]/

/** `C:` style drive designators would read as a mount name on one OS and a root on another. */
const DRIVE_DESIGNATOR = /^[A-Za-z]:$/

/** Longest accepted path, in UTF-16 units. Generous for real trees, bounded for parsers. */
export const MAX_FILESPACE_PATH_LENGTH = 4096

/**
 * The single minting function for {@link FileSpacePath}.
 *
 * Accepts a leading slash or not (`workspace/a` and `/workspace/a` are the
 * same path), collapses repeated and trailing slashes, and returns `null` for
 * anything that is not a path in this grammar. `/` alone is the FileSpace root.
 */
export function normalizeFileSpacePath(input: string): FileSpacePath | null {
  if (typeof input !== "string") return null
  const composed = input.normalize("NFC")
  if (composed.length === 0 || composed.length > MAX_FILESPACE_PATH_LENGTH) return null
  const segments: string[] = []
  for (const segment of composed.split("/")) {
    if (segment === "") continue
    if (segment === "." || segment === "..") return null
    if (FORBIDDEN_SEGMENT_CHARS.test(segment)) return null
    if (segments.length === 0 && DRIVE_DESIGNATOR.test(segment)) return null
    segments.push(segment)
  }
  return `/${segments.join("/")}` as FileSpacePath
}

/** The segments of a normalized path; `[]` for the root. */
export function fileSpacePathSegments(path: FileSpacePath): string[] {
  return path === "/" ? [] : path.slice(1).split("/")
}

/**
 * Append a relative tail to a FileSpace prefix. The tail goes through the same
 * grammar, so a `..` in it yields `null` rather than escaping the prefix.
 */
export function joinFileSpacePath(prefix: string, tail: string): FileSpacePath | null {
  const base = normalizeFileSpacePath(prefix)
  if (!base) return null
  if (tail.trim() === "") return base
  return normalizeFileSpacePath(`${base}/${tail.replace(/\\/g, "/")}`)
}

/** Whether `path` is `prefix` itself or sits under it, segment-wise. */
export function isFileSpacePathWithin(path: FileSpacePath, prefix: FileSpacePath): boolean {
  if (prefix === "/") return true
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * The mount a path belongs to, and the path's remainder inside it.
 *
 * Mount prefixes never nest today (`/workspace`, `/roots/<id>`, `/uploads`,
 * `/artifacts`), but the longest prefix still wins so a future nested mount
 * cannot be shadowed by its parent. `relPath` is `""` for the mount itself.
 */
export function locateFileSpacePath(
  space: Pick<ConversationFileSpace, "mounts">,
  path: FileSpacePath
): { mount: FileSpaceMount; relPath: string } | null {
  let best: { mount: FileSpaceMount; relPath: string } | null = null
  for (const mount of space.mounts) {
    const prefix = normalizeFileSpacePath(mount.virtualPath)
    if (!prefix || !isFileSpacePathWithin(path, prefix)) continue
    if (best && best.mount.virtualPath.length >= mount.virtualPath.length) continue
    best = { mount, relPath: path === prefix ? "" : path.slice(prefix.length + 1) }
  }
  return best
}

/**
 * The FileSpace path of an absolute host path, or `null` when no disk mount
 * contains it. The inverse of resolving a disk location, used to turn what a
 * tool reported (an absolute path on this machine) into a link.
 *
 * Deepest host root wins: an additional root nested inside the primary one
 * (a monorepo package added as its own root) addresses its files by its own
 * prefix, which is the one the user picked.
 */
export function toFileSpacePath(
  space: Pick<ConversationFileSpace, "mounts">,
  absoluteHostPath: string
): FileSpacePath | null {
  const target = normalizeFsPath(absoluteHostPath)
  if (!target) return null
  let best: { mount: FileSpaceMount; rel: string; depth: number } | null = null
  for (const mount of space.mounts) {
    if (mount.backing !== "disk" || !mount.hostPath) continue
    const root = normalizeFsPath(mount.hostPath)
    if (!root) continue
    const rel = sameFsPath(target, root) ? "" : relativePathWithinRoot(target, root)
    if (rel === null) continue
    if (best && best.depth >= root.length) continue
    best = { mount, rel, depth: root.length }
  }
  if (!best) return null
  return joinFileSpacePath(best.mount.virtualPath, best.rel)
}

/**
 * Equality under the comparison `relativePathWithinRoot` uses for containment
 * (including its case rule for Windows drive paths). That helper answers
 * `null` for the root itself, so equality is asked as "is a child of `a` a
 * direct child of `b`".
 */
function sameFsPath(a: string, b: string): boolean {
  const strip = (value: string) => value.replace(/\/+$/, "")
  if (strip(a) === strip(b)) return true
  return relativePathWithinRoot(`${strip(a)}/probe`, strip(b)) === "probe"
}
