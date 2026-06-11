/**
 * File-access permission engine (lexical pre-flight).
 *
 * `lib/file/file-operations.ts` notes that "plugin code is expected to gate
 * write operations behind a permission check before calling here" — this module
 * *is* that gate. It is deliberately pure (no fs, no Tauri, no React) so the
 * containment logic is exhaustively unit-testable and can run in any runtime
 * (renderer, sidecar, tests).
 *
 * IMPORTANT — this is an *advisory lexical pre-flight*, not the authoritative
 * boundary. `normalizeFsPath` resolves `.`/`..` lexically but does NOT touch the
 * filesystem, so it cannot see a symlink that escapes a root. The authoritative,
 * on-disk containment (canonicalize + reject writes through a symlinked final
 * component) lives in the Rust `*_confined` commands in `src-tauri/src/files.rs`,
 * which the secure-fs write path calls after this check passes. This pre-flight
 * gives a fast, i18n-able, audit-logged denial before the IPC round-trip and is
 * the only check available in web mode (no Rust host).
 */

import type {
  FileAccessDecision,
  FileAccessPolicy,
  FileOperation,
  MutatingFileOperation,
} from "@/types/files"
import { matchesDeniedGlob } from "./glob-match"

const MUTATING_OPS: ReadonlySet<MutatingFileOperation> = new Set([
  "write",
  "delete",
  "copy",
  "move",
  "mkdir",
])

/** True when `op` writes to the filesystem (denied by a read-only policy). */
export function isMutatingOperation(op: FileOperation): boolean {
  return MUTATING_OPS.has(op as MutatingFileOperation)
}

/**
 * Normalize a filesystem path to a comparable form: forward slashes, collapsed
 * `.` segments, resolved `..` segments (never popping above the rooting prefix),
 * and no trailing slash (except a bare root). This is a *lexical* resolve — it
 * does not touch the filesystem — which is what a pre-flight permission check
 * needs.
 *
 * Handles Windows drive paths (`C:/…`), UNC shares (`//server/share/…`), and
 * extended-length / device prefixes (`\\?\C:\…`, `\\?\UNC\server\share\…`).
 * Drive-relative paths (`C:foo`, no slash after the colon) are ambiguous without
 * a current directory and are rejected (returns `""`).
 */
export function normalizeFsPath(input: string): string {
  let p = input.trim().replace(/\\/g, "/")
  if (p === "") return ""

  // Strip Windows extended-length / device prefixes (\\?\ , \\.\ , \\?\UNC\).
  if (/^\/\/[?.]\/UNC\//i.test(p)) {
    p = `//${p.slice("//?/UNC/".length)}` // -> //server/share/...
  } else if (/^\/\/[?.]\//.test(p)) {
    p = p.slice("//?/".length) // -> C:/... (or a bare relative body)
  }

  // Drive-relative ("C:foo") — no cwd available to resolve against; reject.
  if (/^[A-Za-z]:(?!\/)/.test(p)) return ""

  let prefix = ""
  let floorIsAbsolute = false

  const driveMatch = /^([A-Za-z]:)\//.exec(p)
  const uncMatch = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(p)
  if (driveMatch) {
    prefix = driveMatch[1] // "C:"
    p = p.slice(prefix.length) // keep the leading slash on the remainder
    floorIsAbsolute = true
  } else if (uncMatch) {
    prefix = `//${uncMatch[1]}/${uncMatch[2]}` // "//server/share"
    p = p.slice(prefix.length)
    floorIsAbsolute = true
  } else if (p.startsWith("/")) {
    floorIsAbsolute = true
  }

  const segments = p.split("/")
  const out: string[] = []
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(seg)
  }

  const body = out.join("/")
  if (prefix) {
    // Drive / UNC paths are always rooted at the prefix floor.
    return body ? `${prefix}/${body}` : `${prefix}/`
  }
  if (floorIsAbsolute) {
    return body ? `/${body}` : "/"
  }
  return body
}

/** Windows-like paths (drive-letter or UNC prefixed) compare case-insensitively. */
function isWindowsLike(normalized: string): boolean {
  return /^[A-Za-z]:\//.test(normalized) || /^\/\/[^/]+\/[^/]+/.test(normalized)
}

function forCompare(normalized: string): string {
  return isWindowsLike(normalized) ? normalized.toLowerCase() : normalized
}

/** True when `target` resolves to `root` itself or a descendant of it. */
function isWithinRoot(target: string, root: string): boolean {
  const t = forCompare(normalizeFsPath(target))
  const r = forCompare(normalizeFsPath(root))
  if (r === "") return false
  if (t === r) return true
  const rWithSep = r.endsWith("/") ? r : `${r}/`
  return t.startsWith(rWithSep)
}

/**
 * Strip the rooting prefix (drive / UNC / posix root) from a normalized path,
 * yielding the segment body. Used to match denied globs against the in-sandbox
 * portion only (so a denied token in a root's own prefix can't deny everything).
 */
function pathBody(normalized: string): string {
  const drive = /^[A-Za-z]:\//.exec(normalized)
  if (drive) return normalized.slice(drive[0].length)
  const unc = /^\/\/[^/]+\/[^/]+\//.exec(normalized)
  if (unc) return normalized.slice(unc[0].length)
  if (normalized.startsWith("/")) return normalized.replace(/^\/+/, "")
  return normalized
}

/** The portion of `normalized` relative to `root` (or its body if no root). */
function relativeToRoot(normalized: string, root: string | undefined): string {
  if (!root) return pathBody(normalized)
  const nr = normalizeFsPath(root)
  // Lengths align even when case differs (prefix is a true prefix by length).
  return normalized.slice(nr.length).replace(/^\/+/, "")
}

interface CheckContext {
  /** Bytes the read/write will move — checked against `policy.maxBytes`. */
  bytes?: number
  /** Destination path for copy/move — also confined to the policy roots. */
  destPath?: string
}

function deny(reason: FileAccessDecision["reason"], detail: string): FileAccessDecision {
  return { allowed: false, reason, detail }
}

/** True when `relPath` matches any denied glob (case-insensitive, segment-aware). */
function matchesAnyDeniedGlob(relPath: string, globs: readonly string[]): string | null {
  const lowered = relPath.toLowerCase()
  for (const glob of globs) {
    if (glob && matchesDeniedGlob(lowered, glob.toLowerCase())) return glob
  }
  return null
}

/**
 * Decide whether `op` on `path` is permitted under `policy`. Pure and
 * synchronous — callers run this before touching the filesystem and surface
 * `decision.detail` to the user / audit log on denial.
 *
 * Order: empty-path → read-only → byte ceiling → root containment → denied
 * globs (matched against the path *relative to its matched root*, so a denied
 * token in the root prefix never denies the whole tree).
 */
export function checkFileAccess(
  path: string,
  op: FileOperation,
  policy: FileAccessPolicy,
  ctx: CheckContext = {}
): FileAccessDecision {
  const normalized = normalizeFsPath(path)
  if (normalized === "") {
    return deny("empty_path", "path is empty")
  }

  // Read-only policies reject every mutating operation up front.
  if (policy.readOnly && isMutatingOperation(op)) {
    return deny("read_only", `operation "${op}" is blocked by a read-only policy`)
  }

  // Byte ceiling for data-moving ops.
  if (
    typeof policy.maxBytes === "number" &&
    typeof ctx.bytes === "number" &&
    ctx.bytes > policy.maxBytes
  ) {
    return deny("too_large", `payload ${ctx.bytes}B exceeds limit ${policy.maxBytes}B`)
  }

  // Containment against the allowed roots (unless explicitly bypassed).
  let matchedRoot: string | undefined
  let destRoot: string | undefined
  const destNormalized = ctx.destPath ? normalizeFsPath(ctx.destPath) : undefined
  if (!policy.allowAnyPath) {
    if (policy.allowedRoots.length === 0) {
      return deny("no_roots", "policy permits no directories")
    }
    matchedRoot = policy.allowedRoots.find((root) => isWithinRoot(normalized, root))
    if (!matchedRoot) {
      return deny("outside_roots", "path escapes the allowed roots")
    }
    if (destNormalized) {
      destRoot = policy.allowedRoots.find((root) => isWithinRoot(destNormalized, root))
      if (!destRoot) {
        return deny("outside_roots", "destination escapes the allowed roots")
      }
    }
  }

  // Denied patterns (secrets, VCS internals) — matched against the in-sandbox
  // relative portion so a token in the root prefix cannot deny everything.
  const deniedGlobs = policy.deniedGlobs ?? []
  if (deniedGlobs.length > 0) {
    const rel = relativeToRoot(normalized, matchedRoot)
    const hit = matchesAnyDeniedGlob(rel, deniedGlobs)
    if (hit) {
      return deny("denied_glob", `path matches denied pattern "${hit}"`)
    }
    if (destNormalized) {
      const destRel = relativeToRoot(destNormalized, destRoot)
      const destHit = matchesAnyDeniedGlob(destRel, deniedGlobs)
      if (destHit) {
        return deny("denied_glob", `destination matches denied pattern "${destHit}"`)
      }
    }
  }

  return matchedRoot !== undefined
    ? { allowed: true, reason: "ok", matchedRoot }
    : { allowed: true, reason: "ok" }
}

/**
 * Build a policy from a list of workspace root paths (typically
 * `allRootPaths(project)`), dropping empties. Pass `overrides` to layer on
 * read-only mode, denied globs, or a byte ceiling.
 */
export function defaultFilePolicy(
  rootPaths: string[],
  overrides: Omit<FileAccessPolicy, "allowedRoots"> = {}
): FileAccessPolicy {
  const allowedRoots = rootPaths.map((p) => p?.trim()).filter((p): p is string => !!p)
  return { allowedRoots, ...overrides }
}
