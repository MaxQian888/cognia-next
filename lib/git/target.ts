const REMOTE_GIT_TARGET_PREFIX = "git-workspace:"

export type GitRepositoryTarget =
  | { kind: "local"; repoPath: string }
  | { kind: "remote"; workspaceId: string; relativePath: string }

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

export function parseGitTarget(value: string): GitRepositoryTarget {
  if (!value.startsWith(REMOTE_GIT_TARGET_PREFIX)) return { kind: "local", repoPath: value }
  try {
    const parsed = JSON.parse(decode(value.slice(REMOTE_GIT_TARGET_PREFIX.length))) as {
      workspaceId?: unknown
      relativePath?: unknown
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
): { repoPath: string } | { workspaceId: string; relativePath: string } {
  const target = parseGitTarget(value)
  return target.kind === "local"
    ? { repoPath: target.repoPath }
    : { workspaceId: target.workspaceId, relativePath: target.relativePath }
}

export function isRemoteGitTarget(value: string): boolean {
  return value.startsWith(REMOTE_GIT_TARGET_PREFIX)
}
