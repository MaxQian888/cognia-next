/**
 * Pure file-access permission engine.
 *
 * `lib/file/file-operations.ts` notes that "plugin code is expected to gate
 * write operations behind a permission check before calling here" — this module
 * *is* that gate. It is deliberately pure (no fs, no Tauri, no React) so the
 * security-critical containment logic is exhaustively unit-testable and can run
 * in any runtime (renderer, sidecar, tests).
 *
 * Containment is checked against the active workspace roots (see
 * `lib/workspace/roots.ts`), mirroring how the Rust `fs_*_workspace` commands
 * confine access to a caller-supplied root.
 */

import type {
  FileAccessDecision,
  FileAccessPolicy,
  FileOperation,
  MutatingFileOperation,
} from "@/types/files"

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
 * `.` segments, resolved `..` segments (never popping above the root), and no
 * trailing slash (except a bare root). This is a *lexical* resolve — it does
 * not touch the filesystem — which is exactly what a pre-flight permission
 * check needs.
 */
export function normalizeFsPath(input: string): string {
  let p = input.trim().replace(/\\/g, "/")
  if (p === "") return ""

  // Detect and preserve a Windows drive prefix ("C:") or a posix-absolute root.
  let prefix = ""
  const driveMatch = /^([A-Za-z]:)\//.exec(p)
  if (driveMatch) {
    prefix = driveMatch[1]
    p = p.slice(prefix.length) // keep the leading slash on the remainder
  }
  const isAbsolute = p.startsWith("/")

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
    // Windows drive paths are always rooted at the drive.
    return body ? `${prefix}/${body}` : `${prefix}/`
  }
  if (isAbsolute) {
    return body ? `/${body}` : "/"
  }
  return body
}

/** Windows paths (drive-letter prefixed) compare case-insensitively. */
function isWindowsLike(normalized: string): boolean {
  return /^[A-Za-z]:\//.test(normalized)
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

interface CheckContext {
  /** Bytes the read/write will move — checked against `policy.maxBytes`. */
  bytes?: number
  /** Destination path for copy/move — also confined to the policy roots. */
  destPath?: string
}

function deny(reason: FileAccessDecision["reason"], detail: string): FileAccessDecision {
  return { allowed: false, reason, detail }
}

/**
 * Decide whether `op` on `path` is permitted under `policy`. Pure and
 * synchronous — callers run this before touching the filesystem and surface
 * `decision.detail` to the user / audit log on denial.
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

  // Denied substrings (secrets, VCS internals) trump everything else.
  const lowered = normalized.toLowerCase()
  for (const glob of policy.deniedGlobs ?? []) {
    if (glob && lowered.includes(glob.toLowerCase())) {
      return deny("denied_glob", `path matches denied pattern "${glob}"`)
    }
    if (
      glob &&
      ctx.destPath &&
      normalizeFsPath(ctx.destPath).toLowerCase().includes(glob.toLowerCase())
    ) {
      return deny("denied_glob", `destination matches denied pattern "${glob}"`)
    }
  }

  // Containment against the allowed roots (unless explicitly bypassed).
  if (!policy.allowAnyPath) {
    if (policy.allowedRoots.length === 0) {
      return deny("no_roots", "policy permits no directories")
    }
    const matchedRoot = policy.allowedRoots.find((root) => isWithinRoot(normalized, root))
    if (!matchedRoot) {
      return deny("outside_roots", `path escapes the allowed roots`)
    }
    // Copy/move destinations must also stay inside the sandbox.
    if (ctx.destPath && !policy.allowedRoots.some((root) => isWithinRoot(ctx.destPath!, root))) {
      return deny("outside_roots", `destination escapes the allowed roots`)
    }
    return { allowed: true, reason: "ok", matchedRoot }
  }

  return { allowed: true, reason: "ok" }
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
