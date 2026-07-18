"use client"

import { useEffect, useMemo, useState } from "react"
import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import {
  ensureResourceWorkbenchSession,
  migrateResourceSessionBinding,
  surfaceBindingForContextResource,
} from "@/lib/context-workbench/resource-session"
import { getContextResourceKey, type ContextResource } from "@/types/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

export function useResourceWorkbenchSession(
  resource: ContextResource,
  enabled: boolean,
  workbenchInstanceId: string
): ChatSession | null {
  const bindingKey = JSON.stringify(surfaceBindingForContextResource(resource))
  const binding = useMemo(() => JSON.parse(bindingKey) as SessionSurfaceBinding, [bindingKey])
  const resourceKey = getContextResourceKey(resource)
  const sessionOverrideId = useContextWorkbenchStore(
    (state) => state.sessionOverrides?.[resourceKey]
  )
  const setSessionOverride = useContextWorkbenchStore((state) => state.setSessionOverride)
  const [session, setSession] = useState<ChatSession | null>(null)

  useEffect(() => {
    if (!enabled || resource.kind === "workflow") return
    let cancelled = false
    const db = getDb()
    const repository = {
      get: (id: string) => db.sessions.get(id),
      findByBinding: async (target: SessionSurfaceBinding) => {
        const sessions = await db.sessions.toArray()
        return sessions.find(
          (candidate) => JSON.stringify(candidate.surfaceBinding) === JSON.stringify(target)
        )
      },
      put: (row: ChatSession) => db.sessions.put(row).then(() => undefined),
      update: (id: string, patch: Partial<ChatSession>) => db.sessions.update(id, patch),
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

  return session && JSON.stringify(session.surfaceBinding) === bindingKey ? session : null
}
