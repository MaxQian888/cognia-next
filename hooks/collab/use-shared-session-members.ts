"use client"

/**
 * The members of a shared conversation, as the server lists them now
 * (ADR-0222 §6): whom a share for the conversation's members can name.
 *
 * Asked of the server each time, like the mention picker's roster: a share
 * naming someone who already left would admit nobody. Failure (no server, not
 * signed in, another org) yields no members, never an error: the share can
 * still go to everyone at a role.
 */

import { useEffect, useState } from "react"
import type { SessionMembership } from "@cognia/agent-config-types"

import { resolveCurrentCollabContext, type CurrentCollabContext } from "@/lib/collab/runtime-client"

export interface SharedSessionScope {
  orgId: string
  /** The conversation's id on the collaboration server. */
  sessionId: string
}

export interface SharedSessionMembers {
  /** Whether the server has answered (or failed) for this scope. */
  loaded: boolean
  members: readonly SessionMembership[]
  /** The signed-in member, so a picker can leave them out. */
  selfUserId: string | null
}

export interface UseSharedSessionMembersDeps {
  resolveContext?: () => Promise<CurrentCollabContext | null>
}

const NONE: readonly SessionMembership[] = Object.freeze([])

function scopeKey(scope: SharedSessionScope | null): string | null {
  return scope && scope.orgId && scope.sessionId ? `${scope.orgId}/${scope.sessionId}` : null
}

export function useSharedSessionMembers(
  scope: SharedSessionScope | null,
  deps: UseSharedSessionMembersDeps = {}
): SharedSessionMembers {
  const resolveContext = deps.resolveContext ?? resolveCurrentCollabContext
  const key = scopeKey(scope)
  const orgId = scope?.orgId ?? ""
  const sessionId = scope?.sessionId ?? ""
  // Tagged with the scope it was loaded for: an answer for the previous
  // conversation is never shown against the next one.
  const [loaded, setLoaded] = useState<{
    key: string
    members: readonly SessionMembership[]
    selfUserId: string | null
  } | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    void (async () => {
      let members: readonly SessionMembership[] = NONE
      let selfUserId: string | null = null
      try {
        const context = await resolveContext()
        if (context && context.orgId === orgId) {
          members = await context.client.listSessionMembers(orgId, sessionId)
          selfUserId = context.userId
        }
      } catch {
        members = NONE
      }
      if (!cancelled) setLoaded({ key, members, selfUserId })
    })()
    return () => {
      cancelled = true
    }
  }, [key, orgId, sessionId, resolveContext])

  if (!key) return { loaded: true, members: NONE, selfUserId: null }
  if (loaded?.key !== key) return { loaded: false, members: NONE, selfUserId: null }
  return { loaded: true, members: loaded.members, selfUserId: loaded.selfUserId }
}
