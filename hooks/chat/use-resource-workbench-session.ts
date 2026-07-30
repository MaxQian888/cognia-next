"use client"

import { useEffect, useMemo, useState } from "react"
import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import {
  ensureResourceWorkbenchSession,
  migrateResourceSessionBinding,
  surfaceBindingForContextResource,
  surfaceBindingKey,
} from "@/lib/context-workbench/resource-session"
import { resolveScopeProjectId } from "@/lib/db/project-scope"
import { getContextResourceKey, type ContextResource } from "@/types/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

export function useResourceWorkbenchSession(
  resource: ContextResource,
  enabled: boolean,
  workbenchInstanceId: string
): ChatSession | null {
  // `session` resources have no binding — they are already a chat session and
  // never own a nested resource-workbench session.
  const surfaceBinding = surfaceBindingForContextResource(resource)
  const bindingKey = surfaceBinding ? JSON.stringify(surfaceBinding) : null
  const binding = useMemo(
    () => (bindingKey ? (JSON.parse(bindingKey) as SessionSurfaceBinding) : null),
    [bindingKey]
  )
  const resourceKey = getContextResourceKey(resource)
  const sessionOverrideId = useContextWorkbenchStore(
    (state) => state.sessionOverrides?.[resourceKey]
  )
  const setSessionOverride = useContextWorkbenchStore((state) => state.setSessionOverride)
  const [session, setSession] = useState<ChatSession | null>(null)

  useEffect(() => {
    if (!enabled || !binding || resource.kind === "workflow") return
    let cancelled = false
    const db = getDb()
    const repository = {
      get: (id: string) => db.sessions.get(id),
      // Indexed since Dexie v131. This used to be `db.sessions.toArray()` plus
      // a `JSON.stringify` compare per row — a full scan of every session in
      // the profile on every workbench open.
      findByBinding: async (target: SessionSurfaceBinding) =>
        db.sessions.where("surfaceBindingKey").equals(surfaceBindingKey(target)).first(),
      put: (row: ChatSession) => db.sessions.put(row).then(() => undefined),
      update: (id: string, patch: Partial<ChatSession>) => db.sessions.update(id, patch),
      // A sidechat belongs to the workspace of the conversation it is an aside
      // to; every other binding is scoped to whatever is active.
      resolveProjectId: async (target: SessionSurfaceBinding) =>
        target.kind === "session"
          ? ((await db.sessions.get(target.sessionId))?.projectId ??
            (await resolveScopeProjectId()))
          : resolveScopeProjectId(),
    }
    const ensure = async () => {
      if (sessionOverrideId) {
        const overridden = await db.sessions.get(sessionOverrideId)
        if (overridden?.kind === "resource-workbench") {
          await migrateResourceSessionBinding(sessionOverrideId, binding, repository)
          return { ...overridden, surfaceBinding: binding }
        }
        setSessionOverride(resourceKey, null)
      }
      return ensureResourceWorkbenchSession(binding, resourceKey, repository, workbenchInstanceId)
    }
    void ensure()
      .then((nextSession) => {
        if (!cancelled) setSession(nextSession)
      })
      .catch((error) => {
        console.error("Failed to ensure resource workbench session", error)
      })
    return () => {
      cancelled = true
    }
  }, [
    binding,
    bindingKey,
    enabled,
    resource.kind,
    resourceKey,
    sessionOverrideId,
    setSessionOverride,
    workbenchInstanceId,
  ])

  return session && bindingKey && JSON.stringify(session.surfaceBinding) === bindingKey
    ? session
    : null
}
