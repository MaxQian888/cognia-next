import type { PluginResolvedIcon } from "@/types/plugin"

interface ResolvePluginIconOptions {
  icon?: string | null
  pluginRoot?: string | null
}

interface PathParts {
  prefix: string
  segments: string[]
}

function parsePathParts(input: string): PathParts {
  const normalized = input.replace(/\\/g, "/")

  if (normalized.startsWith("/")) {
    return {
      prefix: "/",
      segments: normalized.slice(1).split("/").filter(Boolean),
    }
  }

  const driveMatch = normalized.match(/^[A-Za-z]:/)
  if (driveMatch) {
    return {
      prefix: driveMatch[0],
      segments: normalized
        .slice(driveMatch[0].length)
        .replace(/^\/+/, "")
        .split("/")
        .filter(Boolean),
    }
  }

  return {
    prefix: "",
    segments: normalized.split("/").filter(Boolean),
  }
}

function joinPathParts(parts: PathParts): string {
  if (parts.prefix === "/") {
    return `/${parts.segments.join("/")}`
  }
  if (parts.prefix) {
    return `${parts.prefix}/${parts.segments.join("/")}`
  }
  return parts.segments.join("/")
}

function isInlineIcon(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("blob:")
}

function isRemoteIcon(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://")
}

function isPublicPath(value: string): boolean {
  return value.startsWith("/")
}

function looksLikeRelativeAssetPath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /\.[A-Za-z0-9]+$/.test(value)
  )
}

function resolveRelativePluginPath(pluginRoot: string, relativePath: string): string | null {
  const root = parsePathParts(pluginRoot)
  const relativeSegments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean)
  const nextSegments = [...root.segments]

  for (const segment of relativeSegments) {
    if (segment === ".") continue
    if (segment === "..") {
      if (nextSegments.length <= root.segments.length) {
        return null
      }
      nextSegments.pop()
      continue
    }

    nextSegments.push(segment)
  }

  return joinPathParts({
    prefix: root.prefix,
    segments: nextSegments,
  })
}

export function resolvePluginIcon({
  icon,
  pluginRoot,
}: ResolvePluginIconOptions): PluginResolvedIcon | undefined {
  const trimmed = icon?.trim()
  if (!trimmed) {
    return undefined
  }

  if (isInlineIcon(trimmed)) {
    return {
      kind: "image",
      src: trimmed,
      original: trimmed,
      transport: "inline",
    }
  }

  if (isRemoteIcon(trimmed)) {
    return {
      kind: "image",
      src: trimmed,
      original: trimmed,
      transport: "remote",
    }
  }

  if (isPublicPath(trimmed)) {
    return {
      kind: "image",
      src: trimmed,
      original: trimmed,
      transport: "public",
    }
  }

  if (looksLikeRelativeAssetPath(trimmed)) {
    if (!pluginRoot) {
      return {
        kind: "fallback",
        original: trimmed,
        reason: "missing",
      }
    }

    const resolvedPath = resolveRelativePluginPath(pluginRoot, trimmed)
    if (!resolvedPath) {
      return {
        kind: "fallback",
        original: trimmed,
        reason: "outside-plugin-root",
      }
    }

    return {
      kind: "image",
      src: resolvedPath,
      original: trimmed,
      transport: "file",
    }
  }

  return {
    kind: "lucide",
    name: trimmed,
    original: trimmed,
  }
}
