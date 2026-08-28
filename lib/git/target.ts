const REMOTE_GIT_TARGET_PREFIX = "git-workspace:"

export type GitRepositoryTarget =
  | { kind: "local"; repoPath: string }
  | { kind: "remote"; workspaceId: string; relativePath: string }
  | { kind: "plugin-cache"; pluginId: string; segments: string[] }

export type HostWorkspaceRef =
  | { kind: "authorized-root"; rootId: string; relativePath: string }
  | { kind: "plugin-cache"; pluginId: string; segments: string[] }

function encode(value: string): string {
  return btoa(unescape(encodeURIComponent(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

function decode(value: string): string {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")
  return decodeURIComponent(escape(atob(padded)))
}

export function gitTargetFromRemote(workspaceId: string, relativePath = ""): string {
  return `${REMOTE_GIT_TARGET_PREFIX}${encode(JSON.stringify({ workspaceId, relativePath }))}`
}

export function gitTargetFromPluginCache(pluginId: string, segments: string[]): string {
  if (!pluginId.trim() || segments.length === 0 || segments.some((segment) => !segment.trim())) {
    throw new Error("Invalid plugin cache Git target")
  }
  return `${REMOTE_GIT_TARGET_PREFIX}${encode(
    JSON.stringify({ kind: "plugin-cache", pluginId, segments })
  )}`
}

export function parseGitTarget(value: string): GitRepositoryTarget {
  if (!value.startsWith(REMOTE_GIT_TARGET_PREFIX)) return { kind: "local", repoPath: value }
  try {
    const parsed = JSON.parse(decode(value.slice(REMOTE_GIT_TARGET_PREFIX.length))) as {
      kind?: unknown
      workspaceId?: unknown
      relativePath?: unknown
      pluginId?: unknown
      segments?: unknown
    }
    if (parsed.kind === "plugin-cache") {
      if (
        typeof parsed.pluginId !== "string" ||
        !Array.isArray(parsed.segments) ||
        !parsed.segments.every((segment) => typeof segment === "string" && segment.length > 0)
      ) {
        throw new Error("invalid plugin cache shape")
      }
      return {
        kind: "plugin-cache",
        pluginId: parsed.pluginId,
        segments: parsed.segments,
      }
    }
    if (typeof parsed.workspaceId !== "string" || typeof parsed.relativePath !== "string") {
      throw new Error("invalid shape")
    }
    return {
      kind: "remote",
      workspaceId: parsed.workspaceId,
      relativePath: parsed.relativePath,
    }
  } catch {
    throw new Error("Invalid remote Git target")
  }
}

export function gitTargetArgs(
  value: string
):
  | { repoPath: string }
  | { workspaceId: string; relativePath: string }
  | { workspaceRef: Extract<HostWorkspaceRef, { kind: "plugin-cache" }> } {
  const target = parseGitTarget(value)
  if (target.kind === "local") return { repoPath: target.repoPath }
  if (target.kind === "remote") {
    return { workspaceId: target.workspaceId, relativePath: target.relativePath }
  }
  return {
    workspaceRef: {
      kind: "plugin-cache",
      pluginId: target.pluginId,
      segments: target.segments,
    },
  }
}

export function isRemoteGitTarget(value: string): boolean {
  return value.startsWith(REMOTE_GIT_TARGET_PREFIX)
}
