"use client"

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { subscribeCollabConnection } from "@/lib/collab/connection"
import { resolveCurrentCollabContext } from "@/lib/collab/runtime-client"
import { useSharedChatEnabled } from "@/hooks/collab/use-shared-chat-enabled"
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
  const enabled = useSharedChatEnabled()
  const sessionIdsKey = useChatStore((state) =>
    JSON.stringify(
      [
        ...new Set([
          ...(state.activeSessionId ? [state.activeSessionId] : []),
          ...state.openSessionIds,
          ...Object.keys(state.paneIdsBySession),
        ]),
      ].sort()
    )
  )
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
  const sessions = useLiveQuery(
    () => (accountId ? getDb().sessions.bulkGet(JSON.parse(sessionIdsKey) as string[]) : []),
    [sessionIdsKey, accountId]
  )

  useEffect(
    () => () => suspendSharedSessionRuns(),
    [accountId, identityRevision, endpointRevision, enabled]
  )

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
    if (!accountId || !workspaceId || !enabled || !navigator.onLine) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const discover = async () => {
      try {
        if (!navigator.onLine || document.visibilityState === "hidden") return
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
          try {
            // One revoked conversation must not starve the rest of the workspace.
            await syncSharedSession(context.client, context.orgId, shared.id, {
              signal: abort.signal,
            })
          } catch (error) {
            if (!abort.signal.aborted)
              console.warn("shared chat session refresh unavailable", error)
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) console.warn("shared chat discovery unavailable", error)
      } finally {
        // Schedule after completion so slow pulls cannot build up a work queue.
        if (!abort.signal.aborted)
          timer = setTimeout(() => {
            void discover()
          }, 30_000)
      }
    }
    void discover()
    return () => {
      abort.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [accountId, workspaceId, connectionRevision, identityRevision, enabled])

  if (!accountId || !enabled) return null
  const bindings = new Map<
    string,
    { localSessionId: string; orgId: string; sharedSessionId: string; endpoint?: string }
  >()
  for (const session of sessions ?? []) {
    const binding = session?.collaboration
    if (!binding) continue
    const key = JSON.stringify([binding.endpoint ?? "", binding.orgId, binding.sessionId])
    if (!bindings.has(key))
      bindings.set(key, {
        localSessionId: session.id,
        orgId: binding.orgId,
        sharedSessionId: binding.sessionId,
        endpoint: binding.endpoint,
      })
  }
  return (
    <>
      {[...bindings].map(([key, binding]) => (
        <SharedSessionLifecycle
          key={key}
          {...binding}
          accountId={accountId}
          connectionRevision={connectionRevision}
          identityRevision={identityRevision}
        />
      ))}
    </>
  )
}

/** A retained pane owns its connection even when another tab is active. */
function SharedSessionLifecycle({
  accountId,
  localSessionId,
  orgId,
  sharedSessionId,
  endpoint,
  connectionRevision,
  identityRevision,
}: {
  accountId: string
  localSessionId: string
  orgId: string
  sharedSessionId: string
  endpoint?: string
  connectionRevision: number
  identityRevision: string
}) {
  useEffect(() => {
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
        const current = await getDb().sessions.get(localSessionId)
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
    localSessionId,
    orgId,
    sharedSessionId,
    endpoint,
    connectionRevision,
    identityRevision,
  ])
  return null
}
