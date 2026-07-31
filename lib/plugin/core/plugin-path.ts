export type PluginPathViolation = "invalid_chars" | "absolute" | "traversal"

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const ABSOLUTE_OR_SCHEME = /^(?:[\\/]|[a-zA-Z]:|[a-zA-Z][a-zA-Z0-9+.-]*:)/
const ENCODED_PATH_CONTROL = /%(?:2e|2f|5c)/i

/**
 * Return every lexical reason a plugin-controlled path cannot be confined.
 * The policy intentionally treats both slash styles as separators on every
 * platform so a manifest cannot pass validation on macOS and escape later on
 * Windows.
 */
export function getPluginPathViolations(path: unknown): PluginPathViolation[] {
  if (typeof path !== "string" || path.length === 0) return ["invalid_chars"]

  const violations = new Set<PluginPathViolation>()
  if (CONTROL_CHARACTER.test(path) || ENCODED_PATH_CONTROL.test(path)) {
    violations.add("invalid_chars")
  }
  if (ABSOLUTE_OR_SCHEME.test(path)) violations.add("absolute")
  if (path.split(/[\\/]+/).some((segment) => segment === "..")) {
    violations.add("traversal")
  }
  return [...violations]
}

export function normalizePluginRelativePath(path: string): string {
  const violations = getPluginPathViolations(path)
  if (violations.length > 0) {
    throw new Error(
      `Unsafe plugin-relative path (${violations.join(", ")}): ${JSON.stringify(path)}`
    )
  }

  const normalized = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/")
  if (normalized.length === 0) {
    throw new Error(`Unsafe plugin-relative path (invalid_chars): ${JSON.stringify(path)}`)
  }
  return normalized
}

/** Resolve a lexically validated plugin path without platform-dependent rules. */
export function resolvePluginPath(installRoot: string, relativePath: string): string {
  if (
    typeof installRoot !== "string" ||
    installRoot.length === 0 ||
    CONTROL_CHARACTER.test(installRoot)
  ) {
    throw new Error("Plugin install root must be a non-empty path without control characters")
  }
  const root = installRoot.replace(/[\\/]+$/, "")
  return `${root}/${normalizePluginRelativePath(relativePath)}`
}
