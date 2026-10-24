/**
 * Read the request origin of a run from the session it runs in (ADR-0239).
 *
 * The pure rules live in `request-origin.ts`; this module only gathers their
 * inputs:
 *
 * - the root session, through `resolveRootSessionId`, so a subagent, a nested
 *   subagent and a team member share their root's requester and epoch;
 * - the requester: the verified sender of the running inbound job for an IM
 *   conversation (`resolveWorkflowTriggerOrigin`, the same source approval
 *   scoping uses), the member a shared session's live run serves, or else the
 *   local person;
 * - the epoch: the requester's newest instruction in the root session, found
 *   by walking the `[sessionId+createdAt]` index backwards and stopping at the
 *   first match. A fixed window would lose an instruction that a long run had
 *   pushed out of it, and an epoch that falls back to "none" there would bring
 *   an old fence back.
 *
 * The epoch lookup is cached per root, requester and newest message id, so a
 * run that checks many tool calls between two messages reads the session once.
 */

import { resolveRootSessionId } from "@/lib/claude/agents/root-session"
import { getDb } from "@/lib/db/schema"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

import type { OutboundTarget } from "./outbound-targets"
import { isRequesterInstruction, sessionOriginThread, type ActionRequester } from "./request-origin"

export interface RequestOrigin {
  rootSessionId: string
  requester: ActionRequester
  /** The conversation the request came from; delivering there needs no grant. */
  originThread?: OutboundTarget
  /**
   * The requester's current instruction. `none:<root>` when they have given
   * none in the root session, which happens only for a run automation started
   * in a fresh session.
   */
  instructionEpoch: string
}

export interface ResolveRequestOriginDeps {
  getSession?: (id: string) => Promise<ChatSession | undefined>
  /** The requester's newest instruction id in `sessionId`, newest first. */
  findLatestInstruction?: (
    sessionId: string,
    requester: ActionRequester
  ) => Promise<string | undefined>
  /** The id of the newest message in `sessionId`, the cache key. */
  latestMessageId?: (sessionId: string) => Promise<string | undefined>
}

const CACHE_LIMIT = 64
const epochCache = new Map<string, string>()

function requesterKey(requester: ActionRequester): string {
  switch (requester.kind) {
    case "local":
      return "local"
    case "im":
      return `im:${requester.remoteUserId}`
    case "member":
      return `member:${requester.userId}`
  }
}

function sessionRange(sessionId: string) {
  return getDb()
    .messages.where("[sessionId+createdAt]")
    .between([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])
    .reverse()
}

/** A stored row in the shape `isRequesterInstruction` reads (collaboration is a column). */
function asInstructionCandidate(row: StoredMessage) {
  return {
    role: row.role,
    metadata: {
      ...(row.metadata ?? {}),
      ...(row.collaboration ? { collaboration: row.collaboration } : {}),
    },
  }
}

async function findLatestInstructionInDb(
  sessionId: string,
  requester: ActionRequester
): Promise<string | undefined> {
  const row = await sessionRange(sessionId)
    .filter((candidate) => isRequesterInstruction(asInstructionCandidate(candidate), requester))
    .first()
  return row?.id
}

async function latestMessageIdInDb(sessionId: string): Promise<string | undefined> {
  return (await sessionRange(sessionId).first())?.id
}

async function getSessionFromDb(id: string): Promise<ChatSession | undefined> {
  return getDb().sessions.get(id)
}

async function resolveRequester(session: ChatSession | undefined): Promise<ActionRequester> {
  if (!session) return { kind: "local" }
  if (session.platformBinding) {
    const { resolveWorkflowTriggerOrigin } = await import("@/lib/workflow/runtime/trigger-origin")
    const origin = await resolveWorkflowTriggerOrigin(session.id)
    const initiator = origin?.initiator
    if (initiator?.remoteUserId) {
      return {
        kind: "im",
        remoteUserId: initiator.remoteUserId,
        ...(initiator.platformIdentityId
          ? { platformIdentityId: initiator.platformIdentityId }
          : {}),
      }
    }
    return { kind: "local" }
  }
  if (!session.collaboration) return { kind: "local" }
  const { getSharedRunRequester } = await import("@/lib/collab/shared-run-coordinator")
  const member = getSharedRunRequester(session.id)
  return member ? { kind: "member", userId: member } : { kind: "local" }
}

/** The request origin of a run in `sessionId` (any session, root or not). */
export async function resolveSessionRequestOrigin(
  sessionId: string,
  deps: ResolveRequestOriginDeps = {}
): Promise<RequestOrigin> {
  const rootSessionId = resolveRootSessionId(sessionId)
  const session = await (deps.getSession ?? getSessionFromDb)(rootSessionId)
  const requester = await resolveRequester(session)
  const originThread = session ? sessionOriginThread(session) : undefined

  const newest = await (deps.latestMessageId ?? latestMessageIdInDb)(rootSessionId)
  const cacheKey = `${rootSessionId}|${requesterKey(requester)}|${newest ?? ""}`
  let epoch = epochCache.get(cacheKey)
  if (epoch === undefined) {
    const found = newest
      ? await (deps.findLatestInstruction ?? findLatestInstructionInDb)(rootSessionId, requester)
      : undefined
    epoch = found ? `msg:${found}` : `none:${rootSessionId}`
    if (epochCache.size >= CACHE_LIMIT) {
      const oldest = epochCache.keys().next().value
      if (oldest !== undefined) epochCache.delete(oldest)
    }
    epochCache.set(cacheKey, epoch)
  }

  return {
    rootSessionId,
    requester,
    ...(originThread ? { originThread } : {}),
    instructionEpoch: epoch,
  }
}

export function __clearRequestOriginCacheForTesting(): void {
  epochCache.clear()
}
