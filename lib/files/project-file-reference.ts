export interface ProjectFileReference {
  absolutePath: string
  line?: number
  column?: number
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/
const KNOWN_EXTENSIONLESS_FILES = new Set(["Dockerfile", "LICENSE", "Makefile", "README"])

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_RE.test(path)
}

function looksLikeFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? ""
  return name.includes(".") || KNOWN_EXTENSIONLESS_FILES.has(name)
}

function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path).replace(/\\/g, "/")
  } catch {
    return null
  }
}

function hasTraversal(path: string): boolean {
  return path.split("/").some((segment) => segment === "..")
}

function trimRelativePrefix(path: string): string {
  return path.replace(/^\.\//, "")
}

/** Parse a Markdown href or inline reference into an editor-ready file target. */
export function parseProjectFileReference(
  reference: string,
  projectRoot?: string | null
): ProjectFileReference | null {
  const raw = reference.trim()
  if (!raw || raw.startsWith("#")) return null

  let pathWithLocation = raw
  let fragment = ""
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      pathWithLocation = url.pathname
      fragment = url.hash.slice(1)
      if (/^\/[A-Za-z]:\//.test(pathWithLocation)) pathWithLocation = pathWithLocation.slice(1)
    } catch {
      return null
    }
  } else {
    if (SCHEME_RE.test(raw) && !WINDOWS_ABSOLUTE_RE.test(raw)) return null
    const hashIndex = raw.indexOf("#")
    if (hashIndex >= 0) {
      pathWithLocation = raw.slice(0, hashIndex)
      fragment = raw.slice(hashIndex + 1)
    }
  }

  let line: number | undefined
  let column: number | undefined
  const fragmentLocation = /^L(\d+)(?:C(\d+))?$/i.exec(fragment)
  if (fragmentLocation) {
    line = Number(fragmentLocation[1])
    column = fragmentLocation[2] ? Number(fragmentLocation[2]) : undefined
  }

  if (line === undefined) {
    const parenLocation = /\((\d+),(\d+)\)$/.exec(pathWithLocation)
    const colonLocation = /:(\d+)(?::(\d+))?$/.exec(pathWithLocation)
    const location = parenLocation ?? colonLocation
    if (location) {
      pathWithLocation = pathWithLocation.slice(0, location.index)
      line = Number(location[1])
      column = location[2] ? Number(location[2]) : undefined
    }
  }

  if (line !== undefined && line < 1) return null
  if (column !== undefined && column < 1) return null

  const decoded = decodePath(pathWithLocation)
  if (!decoded || hasTraversal(decoded) || !looksLikeFile(decoded)) return null

  let absolutePath = decoded
  if (!isAbsolutePath(decoded)) {
    if (!projectRoot) return null
    const normalizedRoot = decodePath(projectRoot)?.replace(/\/+$/, "")
    if (!normalizedRoot || !isAbsolutePath(normalizedRoot) || hasTraversal(normalizedRoot))
      return null
    absolutePath = `${normalizedRoot}/${trimRelativePrefix(decoded)}`
  }

  return {
    absolutePath,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  }
}
