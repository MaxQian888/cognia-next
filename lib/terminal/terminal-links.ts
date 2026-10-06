/** Terminal file links use the shared parser and resolve paths against the session cwd. */
export { matchFileLinks, type FileLinkMatch } from "@cognia/error-parsers/file-links"

/** True when `p` is an absolute path (POSIX root or Windows drive). */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * Resolve a (possibly relative) match path against the session cwd.
 * Absolute paths pass through. When cwd is unknown the path is returned
 * unchanged (the editor open will surface a not-found error).
 */
export function resolveLinkPath(cwd: string | null | undefined, p: string): string {
  if (isAbsolutePath(p)) return p
  if (!cwd) return p
  const stripped = p.replace(/^\.\//, "")
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/"
  return cwd.replace(/[\\/]+$/, "") + sep + stripped
}
