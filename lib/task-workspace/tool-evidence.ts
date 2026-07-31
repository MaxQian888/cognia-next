import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import { recordTaskResourceToolEvent } from "./client"

type FileChange = Record<string, unknown>

function relativePath(executionRoot: string, candidate: string): string | null {
  const root = executionRoot.replace(/\\/g, "/").replace(/\/$/, "")
  let path = candidate.trim().replace(/\\/g, "/")
  if (!path) return null
  if (path.startsWith("/")) {
    if (path === root || !path.startsWith(`${root}/`)) return null
    path = path.slice(root.length + 1)
  }
  const segments = path.split("/")
  if (segments.some((segment) => segment === "..") || segments.length === 0) return null
  return segments.filter((segment) => segment !== "." && segment !== "").join("/") || null
}

function changeKind(value: unknown): "created" | "modified" | "deleted" | "renamed" {
  const kind = typeof value === "string" ? value.toLowerCase() : ""
  if (kind === "add" || kind === "added" || kind === "create" || kind === "created") {
    return "created"
  }
  if (kind === "delete" || kind === "deleted" || kind === "remove" || kind === "removed") {
    return "deleted"
  }
  if (kind === "rename" || kind === "renamed" || kind === "move" || kind === "moved") {
    return "renamed"
  }
  return "modified"
}

/** Persist tool-reported paths as causal hints; watcher/snapshot remain authoritative. */
export async function recordToolFileChanges(
  sessionId: string,
  toolCallId: string,
  changes: unknown
): Promise<void> {
  if (!Array.isArray(changes)) return
  const active = useTaskWorkspaceStore.getState().activeBySession[sessionId]
  if (!active) return
  const writes: Array<ReturnType<typeof recordTaskResourceToolEvent>> = []
  for (const raw of changes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const change = raw as FileChange
    const candidate = [change.path, change.file_path, change.filePath].find(
      (value): value is string => typeof value === "string"
    )
    if (!candidate) continue
    const path = relativePath(active.executionRoot, candidate)
    if (!path) continue
    const oldCandidate = [change.oldPath, change.old_path, change.from].find(
      (value): value is string => typeof value === "string"
    )
    const oldPath = oldCandidate ? relativePath(active.executionRoot, oldCandidate) : null
    writes.push(
      recordTaskResourceToolEvent({
        runId: active.runId,
        path,
        ...(oldPath ? { oldPath } : {}),
        kind: changeKind(change.type ?? change.kind),
        toolCallId,
      })
    )
  }
  await Promise.all(writes)
}
