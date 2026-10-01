"use client"

/**
 * Who a collaboration-issue comment can mention: the issue's workspace roster,
 * minus the person writing. ADR-0207 §2.
 *
 * # Why the server, not the local roster mirror
 *
 * The server refuses (400) a mention of anybody who is not a CURRENT member of
 * the workspace. The mirrored roster is only as fresh as the last pull, so
 * offering it would let the picker produce a comment the server then rejects.
 * Asking the server each time the composer opens costs one request and makes
 * the picker and the validator agree.
 *
 * # Failure is "nobody to mention", never an error
 *
 * No collaboration server, not signed in, offline, a revoked read, an issue
 * mirrored from an org this session is no longer bound to: every one of those
 * yields an empty list, and the composer simply offers no picker. The comment
 * itself still goes through the outbound queue, so being unable to mention is
 * never a reason to be unable to comment.
 */

import { useEffect, useState } from "react"

import { resolveCurrentCollabContext, type CurrentCollabContext } from "@/lib/collab/runtime-client"

export interface CollabMentionCandidate {
  userId: string
  displayName: string
}

export interface CollabMentionScope {
  orgId: string
  workspaceId: string
}

export interface UseCollabMentionCandidatesDeps {
  resolveContext?: () => Promise<CurrentCollabContext | null>
}

const NONE: readonly CollabMentionCandidate[] = Object.freeze([])

/** Server roster → candidates: self removed, ids de-duplicated, sorted by name. */
export function toMentionCandidates(
  members: readonly { userId: string; displayName: string }[],
  selfUserId: string
): CollabMentionCandidate[] {
  const seen = new Set<string>([selfUserId])
  const candidates: CollabMentionCandidate[] = []
  for (const member of members) {
    if (!member.userId || seen.has(member.userId)) continue
    seen.add(member.userId)
    candidates.push({
      userId: member.userId,
      displayName: member.displayName.trim() || member.userId,
    })
  }
  return candidates.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

function scopeKey(scope: CollabMentionScope | null): string | null {
  return scope && scope.orgId && scope.workspaceId ? `${scope.orgId}/${scope.workspaceId}` : null
}

export function useCollabMentionCandidates(
  scope: CollabMentionScope | null,
  deps: UseCollabMentionCandidatesDeps = {}
): readonly CollabMentionCandidate[] {
  const resolveContext = deps.resolveContext ?? resolveCurrentCollabContext
  const key = scopeKey(scope)
  const orgId = scope?.orgId ?? ""
  const workspaceId = scope?.workspaceId ?? ""
  // Tagged with the scope it was loaded for, so a stale answer for the
  // previous issue is never shown against the next one, and there is no
  // synchronous reset inside the effect.
  const [loaded, setLoaded] = useState<{
    key: string
    candidates: readonly CollabMentionCandidate[]
  } | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    void (async () => {
      let candidates: readonly CollabMentionCandidate[] = NONE
      try {
        const context = await resolveContext()
        // An issue mirrored under another org cannot be commented on with
        // this session's grant, let alone mention anybody in it.
        if (context && context.orgId === orgId) {
          const members = await context.client.listWorkspaceMembers(orgId, workspaceId)
          candidates = toMentionCandidates(members, context.userId)
        }
      } catch {
        candidates = NONE
      }
      if (!cancelled) setLoaded({ key, candidates })
    })()
    return () => {
      cancelled = true
    }
  }, [key, orgId, workspaceId, resolveContext])

  return key && loaded?.key === key ? loaded.candidates : NONE
}
