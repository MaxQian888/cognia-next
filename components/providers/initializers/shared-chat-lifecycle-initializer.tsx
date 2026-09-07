"use client"

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { subscribeCollabConnection } from "@/lib/collab/connection"
import { resolveCurrentCollabContext } from "@/lib/collab/runtime-client"
import { isSharedChatClientEnabled } from "@/lib/collab/shared-chat-feature"
import {
  recoverSharedSessionRun,
  suspendSharedSessionRuns,
} from "@/lib/collab/shared-run-coordinator"
import {
  connectSharedSessionStream,
  listAndCacheSharedSessions,
  syncSharedSession,
} from "@/lib/collab/shared-chat-sync"
import { getDb } from "@/lib/db/schema"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
import { useAccountStore } from "@/stores/account/account-store"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"

/** Own collaboration independently of whether the conversation settings are open. */
export function SharedChatLifecycleInitializer() {
  const accountId = useAccountStore((state) => state.unlockedAccountId)
  const workspaceId = useProjectStore((state) => state.activeProjectId)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const [connectionRevision, setConnectionRevision] = useState(0)
  const [endpointRevision, setEndpointRevision] = useState(0)
  const registry = useMemo(() => new UserBindingRegistry(), [])
  const identity = useLiveQuery(
    () => (accountId ? registry.get(accountId) : undefined),
    [accountId, registry]
  )
  const identityRevision = identity
    ? `${identity.userId}:${identity.orgId}:${identity.updatedAt}`
    : ""
  const session = useLiveQuery(
    () => (activeSessionId && accountId ? getDb().sessions.get(activeSessionId) : undefined),
    [activeSessionId, accountId]
  )
  const orgId = session?.collaboration?.orgId
  const sharedSessionId = session?.collaboration?.sessionId
  const endpoint = session?.collaboration?.endpoint

  useEffect(() => () => suspendSharedSessionRuns(), [accountId, identityRevision, endpointRevision])

  useEffect(() => {
    const refresh = () => setConnectionRevision((revision) => revision + 1)
    const foreground = () => {
      if (document.visibilityState === "visible") refresh()
    }
    const unsubscribe = subscribeCollabConnection(() => {
      setEndpointRevision((revision) => revision + 1)
      refresh()
    })
    window.addEventListener("online", refresh)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", foreground)
    return () => {
      unsubscribe()
      window.removeEventListener("online", refresh)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", foreground)
    }
  }, [])

  useEffect(() => {
    if (!accountId || !workspaceId || !isSharedChatClientEnabled() || !navigator.onLine) return
    const abort = new AbortController()
    void (async () => {
      const context = await resolveCurrentCollabContext({ localAccountId: accountId })
      if (!context || abort.signal.aborted) return
      const sessions = await listAndCacheSharedSessions(
        context.client,
        context.orgId,
        workspaceId,
        { signal: abort.signal }
      )
      for (const shared of sessions) {
        if (abort.signal.aborted) return
        // Project discovered sessions so the existing Dexie-backed navigation sees them.
        await syncSharedSession(context.client, context.orgId, shared.id, { signal: abort.signal })
      }
    })().catch((error) => console.warn("shared chat discovery unavailable", error))
    return () => {
      abort.abort()
    }
  }, [accountId, workspaceId, connectionRevision, identityRevision])

  useEffect(() => {
    if (!accountId || !orgId || !sharedSessionId || !isSharedChatClientEnabled()) return
    const abort = new AbortController()
    let close: (() => void) | undefined
    void (async () => {
      const context = await resolveCurrentCollabContext({ localAccountId: accountId })
      if (
        !context ||
        context.orgId !== orgId ||
        (endpoint && endpoint !== context.client.baseUrl) ||
        abort.signal.aborted
      )
        return
      const stream = await connectSharedSessionStream(context.client, orgId, sharedSessionId, {
        signal: abort.signal,
      })
      if (abort.signal.aborted) stream.close()
      else {
        close = () => stream.close()
        const current = activeSessionId ? await getDb().sessions.get(activeSessionId) : undefined
        if (current && !abort.signal.aborted) await recoverSharedSessionRun(current)
      }
    })().catch((error) => {
      if (!abort.signal.aborted) console.warn("shared chat stream unavailable", error)
    })
    return () => {
      abort.abort()
      close?.()
    }
  }, [
    accountId,
    activeSessionId,
    orgId,
    sharedSessionId,
    endpoint,
    connectionRevision,
    identityRevision,
  ])

  return null
}
