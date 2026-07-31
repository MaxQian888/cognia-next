// v131 upgrade backfill. Repairs the two families of session rows that were
// written straight to Dexie without a `projectId`, and stamps the new
// `surfaceBindingKey` index column.
//
// Why rows are missing a column the v86 backfill already added: v86 stamped
// every row that existed *then*. Two writers created rows afterwards that
// bypass `createSession` (the only helper that calls `resolveScopeProjectId`)
// and `put` a hand-built row instead:
//
//   • `lib/chat/branch-session.ts:buildChildRow` — conversation branches.
//   • `lib/context-workbench/resource-session.ts:ensureResourceWorkbenchSession`
//     — workbench sidechats.
//
// A row without `projectId` is not merely mis-scoped, it is unreachable:
// `listScopedSessions` reads through `[projectId+updatedAt]`, and Dexie omits
// any row whose key path contains `undefined` from a compound index. So every
// branch ever created has been absent from the sidebar since the first reload,
// and every sidechat has been outside `deleteProjectCascade` — surviving, with
// its messages, the deletion of the workspace it belonged to.
//
// Attribution is by lineage, not by whatever workspace happens to be active
// now: a branch belongs where its parent lives, and an aside belongs where its
// main conversation lives. Only rows with no lineage left to follow fall back
// to the active/Default workspace.
//
// Extracted from the inline `schema.ts` upgrade for the same reason as
// `project-scope-backfill.ts`: the logic is error-prone and deserves unit
// tests. Operates purely on the passed Dexie transaction; never calls `getDb()`.

import type { Transaction } from "dexie"
import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import { buildDefaultProject } from "./project-defaults"

const SETTINGS_SINGLETON_ID = "singleton"

/**
 * Flat rendering of a surface binding.
 *
 * Intentionally duplicated from `lib/context-workbench/resource-session.ts`
 * rather than imported: a migration must reproduce the format as it stood when
 * this version shipped, and importing the live helper would silently re-key
 * historical rows the day that helper changes. The two are pinned together by
 * `session-lineage-backfill.test.ts`.
 */
export function bindingKeyForBackfill(binding: SessionSurfaceBinding): string {
  const parts: string[] = (() => {
    switch (binding.kind) {
      case "canvas-document":
        return ["canvas", binding.documentId]
      case "project-file":
        return ["project", binding.projectId, binding.rootId, binding.relPath]
      case "artifact":
        return ["artifact", binding.artifactId]
      case "workflow":
        return ["workflow", binding.workflowId]
      case "session":
        return ["session", binding.sessionId]
    }
  })()
  return parts.map(encodeURIComponent).join(":")
}

/** The session a row inherits its workspace from, or null when it has no lineage. */
function lineageParentOf(session: ChatSession): string | null {
  if (typeof session.parentSessionId === "string") return session.parentSessionId
  const binding = session.surfaceBinding
  if (binding?.kind === "session" && typeof binding.sessionId === "string") {
    return binding.sessionId
  }
  return null
}

/**
 * Resolve the fallback workspace id, creating + activating a Default workspace
 * when none is active. Mirrors `resolveFallback` in `project-scope-backfill.ts`
 * — repeated rather than shared because that one is pinned to the v86 shape.
 */
async function resolveFallbackProjectId(tx: Transaction): Promise<string> {
  const projectsTable = tx.table("projects")
  const settingsTable = tx.table("settings")
  const projects = (await projectsTable.toArray()) as Project[]
  const settings = (await settingsTable.get(SETTINGS_SINGLETON_ID)) as
    (Record<string, unknown> & { activeProjectId?: string }) | undefined
  const activeId = settings?.activeProjectId

  if (activeId && projects.some((p) => p.id === activeId)) return activeId

  const def = buildDefaultProject()
  await projectsTable.put(def)
  await settingsTable.put({
    ...(settings ?? { id: SETTINGS_SINGLETON_ID }),
    activeProjectId: def.id,
  })
  return def.id
}

/**
 * Walk a row's lineage until a session that already has a `projectId` is
 * reached, memoising every id resolved on the way.
 *
 * Chains are followed rather than resolved one hop: a branch of a branch, or an
 * aside of a branch, has an unstamped intermediate, and stopping at the first
 * hop would drop the whole chain onto the fallback workspace. `seen` breaks
 * cycles — `parentSessionId` has never been validated on write, and a
 * self-referencing or looped row must not hang the upgrade.
 */
function resolveProjectId(
  id: string,
  byId: Map<string, ChatSession>,
  memo: Map<string, string>,
  fallbackId: string
): string {
  const chain: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = id
  let resolved = fallbackId

  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor)
    const memoised = memo.get(cursor)
    if (memoised !== undefined) {
      resolved = memoised
      break
    }
    const session: ChatSession | undefined = byId.get(cursor)
    // A dangling pointer (parent deleted) ends the walk on the fallback.
    if (!session) break
    if (typeof session.projectId === "string") {
      resolved = session.projectId
      break
    }
    chain.push(cursor)
    cursor = lineageParentOf(session)
  }

  for (const link of chain) memo.set(link, resolved)
  return resolved
}

/**
 * Backfill `projectId` + `surfaceBindingKey` on session rows, then propagate
 * the workspace onto their messages.
 *
 * Idempotent: only rows whose column is `undefined` are touched, so re-running
 * over an already-migrated database is a no-op.
 */
export async function backfillSessionLineageV131(tx: Transaction): Promise<void> {
  const sessionsTable = tx.table("sessions")
  const sessions = (await sessionsTable.toArray()) as ChatSession[]

  const byId = new Map<string, ChatSession>()
  for (const session of sessions) byId.set(session.id, session)

  const orphans = sessions.filter((s) => s.projectId === undefined)
  const needsBindingKey = sessions.filter(
    (s) => s.surfaceBinding !== undefined && s.surfaceBindingKey === undefined
  )
  if (orphans.length === 0 && needsBindingKey.length === 0) return

  // Only pay for (and only ever auto-create) a Default workspace when there is
  // actually a row that might land on it.
  const memo = new Map<string, string>()
  const fallbackId = orphans.length > 0 ? await resolveFallbackProjectId(tx) : ""

  const resolvedBySession = new Map<string, string>()
  for (const orphan of orphans) {
    resolvedBySession.set(orphan.id, resolveProjectId(orphan.id, byId, memo, fallbackId))
  }

  await sessionsTable.toCollection().modify((row: ChatSession) => {
    if (row.projectId === undefined) {
      const projectId = resolvedBySession.get(row.id)
      if (projectId !== undefined) row.projectId = projectId
    }
    if (row.surfaceBinding !== undefined && row.surfaceBindingKey === undefined) {
      row.surfaceBindingKey = bindingKeyForBackfill(row.surfaceBinding)
    }
  })

  // Messages of a rescued session carry the same gap — they were written by
  // `persistMessages`, which copies the workspace off the session row.
  if (resolvedBySession.size > 0) {
    await tx
      .table("messages")
      .toCollection()
      .modify((row: Record<string, unknown>) => {
        if (row.projectId !== undefined) return
        const projectId = resolvedBySession.get(row.sessionId as string)
        if (projectId !== undefined) row.projectId = projectId
      })
  }
}
