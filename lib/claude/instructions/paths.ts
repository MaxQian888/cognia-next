/**
 * Tiny, dependency-free cross-platform path helpers for instruction-file
 * discovery. We deliberately avoid Node's `path` module: this code runs in the
 * renderer (and is bundled for the mobile/static-export target where `path` is
 * stubbed), and the separator must follow the *input string* (a Windows
 * `C:\proj` cwd vs a posix `/home/x` cwd) rather than the host platform.
 *
 * Mirrors the separator-detection trick already used by
 * `lib/lsp/project-file-reader.ts:joinRoot`.
 */

/** Pick the separator implied by a path string (backslash only when it has `\` and no `/`). */
export function detectSep(p: string): "\\" | "/" {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/"
}

/** Strip a single trailing separator (but keep a bare root like `/` or `C:\`). */
export function stripTrailingSep(p: string): string {
  if (p.length <= 1) return p
  // Keep drive roots intact: `C:\` and `C:/` are 3 chars.
  if (/^[A-Za-z]:[\\/]$/.test(p)) return p
  return p.endsWith("/") || p.endsWith("\\") ? p.slice(0, -1) : p
}

/** Join a base dir with a `/`-delimited relative path using the base's separator. */
export function joinPath(base: string, rel: string): string {
  const sep = detectSep(base)
  const trimmed = stripTrailingSep(base)
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  return parts.length ? `${trimmed}${sep}${parts.join(sep)}` : trimmed
}

/** The parent directory of a path, or the path itself once at a root. */
export function dirname(p: string): string {
  const trimmed = stripTrailingSep(p)
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  if (idx < 0) return trimmed
  // Posix root: `/foo` → `/`.
  if (idx === 0) return trimmed.slice(0, 1)
  const head = trimmed.slice(0, idx)
  // Windows drive root: `C:\foo` → `C:\`.
  if (/^[A-Za-z]:$/.test(head)) return `${head}${detectSep(p)}`
  return head
}

/** The last path segment (filename), without a trailing separator. */
export function basename(p: string): string {
  const trimmed = stripTrailingSep(p)
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return idx < 0 ? trimmed : trimmed.slice(idx + 1)
}

/** True once `dirname(p) === p` (filesystem root reached). */
export function isRoot(p: string): boolean {
  return dirname(p) === stripTrailingSep(p)
}

/** Case-normalized comparison key (Windows paths are case-insensitive). */
export function pathKey(p: string): string {
  const norm = stripTrailingSep(p).replace(/\\/g, "/")
  return detectSep(p) === "\\" ? norm.toLowerCase() : norm
}

/** True when `child` is `parent` or sits underneath it. */
export function isDescendant(parent: string, child: string): boolean {
  const a = pathKey(parent)
  const b = pathKey(child)
  return b === a || b.startsWith(a.endsWith("/") ? a : `${a}/`)
}

/**
 * Directory chain from `cwd` walking UP to (and including) `stopAt` when
 * `stopAt` is an ancestor of `cwd`; otherwise up to the filesystem root, capped
 * at `maxDepth` levels so a stray cwd can never trigger a whole-disk scan.
 * Returned cwd-first (nearest first).
 */
export function ancestorChain(cwd: string, stopAt?: string, maxDepth = 40): string[] {
  const out: string[] = []
  let cur = stripTrailingSep(cwd)
  const stop = stopAt ? pathKey(stopAt) : undefined
  for (let i = 0; i < maxDepth; i++) {
    out.push(cur)
    if (stop && pathKey(cur) === stop) break
    if (isRoot(cur)) break
    cur = dirname(cur)
  }
  return out
}

/** Relative label of `child` under `root` (posix slashes), else the basename. */
export function relLabel(root: string | undefined, child: string): string {
  if (root && isDescendant(root, child)) {
    const a = stripTrailingSep(root).replace(/\\/g, "/")
    const b = stripTrailingSep(child).replace(/\\/g, "/")
    const rel = b.slice(a.length).replace(/^\/+/, "")
    return rel || basename(child)
  }
  return basename(child)
}
