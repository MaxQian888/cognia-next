"use client"

import type { ChatSession, SessionAction } from "@cognia/agent-config-types"
import { CollabError } from "./client"
import { authorizeSessionAction } from "./session-permissions"
import { resolveCurrentCollabContext, type CurrentCollabContext } from "./runtime-client"

export class SharedSessionAccessError extends Error {
  constructor(readonly reason: "not_found" | "forbidden" | "server_required") {
    super(reason === "server_required" ? "SHARED_SESSION_SERVER_REQUIRED" : "SESSION_NOT_FOUND")
    this.name = "SharedSessionAccessError"
  }
}

export async function assertSharedSessionRead(
  session: Pick<ChatSession, "collaboration">,
  resolveContext: () => Promise<CurrentCollabContext | null> = resolveCurrentCollabContext
): Promise<void> {
  return assertSharedSessionAccess(session, "session.read", resolveContext)
}

export async function assertSharedSessionExport(
  session: Pick<ChatSession, "collaboration">,
  resolveContext: () => Promise<CurrentCollabContext | null> = resolveCurrentCollabContext
): Promise<void> {
  return assertSharedSessionAccess(session, "session.export", resolveContext)
}

async function assertSharedSessionAccess(
  session: Pick<ChatSession, "collaboration">,
  action: "session.read" | "session.export",
  resolveContext: () => Promise<CurrentCollabContext | null>
): Promise<void> {
  const binding = session.collaboration
  if (!binding) return
  const context = await resolveContext()
  if (
    !context ||
    context.orgId !== binding.orgId ||
    (binding.endpoint && binding.endpoint !== context.client.baseUrl)
  ) {
    throw new SharedSessionAccessError("not_found")
  }
  try {
    if (action === "session.export") {
      await context.client.authorizeSessionExport(binding.orgId, binding.sessionId)
    } else {
      const [remote, members] = await Promise.all([
        context.client.getSharedSession(binding.orgId, binding.sessionId),
        context.client.listSessionMembers(binding.orgId, binding.sessionId),
      ])
      const member = members.find((candidate) => candidate.userId === context.userId) ?? null
      const decision = authorizeSessionAction(member, action, remote.policyRevision)
      if (!decision.allowed) throw new SharedSessionAccessError("not_found")
    }
    // Authorization must not outlive the account or endpoint that requested it.
    const current = await resolveContext()
    if (
      !current ||
      current.localAccountId !== context.localAccountId ||
      current.userId !== context.userId ||
      current.orgId !== context.orgId ||
      current.client.baseUrl !== context.client.baseUrl
    ) {
      throw new SharedSessionAccessError("not_found")
    }
  } catch (error) {
    if (error instanceof SharedSessionAccessError) throw error
    throw new SharedSessionAccessError("not_found")
  }
}

/**
 * May the current person publish a shared conversation's files (ADR-0222)?
 * Resolves to `null` for a conversation that is not shared — local policy
 * alone decides there — or to the org and the policy revision the server
 * decided under. A refusal by role or by org policy is `forbidden`; an
 * unreachable server, a switched account or a conversation the person cannot
 * see is `not_found`, like every other shared-session check.
 */
export async function assertSharedSessionFileShare(
  session: Pick<ChatSession, "collaboration">,
  resolveContext: () => Promise<CurrentCollabContext | null> = resolveCurrentCollabContext
): Promise<{ orgId: string; policyRevision: number } | null> {
  const binding = session.collaboration
  if (!binding) return null
  const context = await resolveContext()
  if (
    !context ||
    context.orgId !== binding.orgId ||
    (binding.endpoint && binding.endpoint !== context.client.baseUrl)
  ) {
    throw new SharedSessionAccessError("not_found")
  }
  let decided: { policyRevision: number }
  try {
    decided = await context.client.authorizeSessionFileShare(binding.orgId, binding.sessionId)
  } catch (error) {
    throw new SharedSessionAccessError(
      error instanceof CollabError && error.status === 403 ? "forbidden" : "not_found"
    )
  }
  const current = await resolveContext()
  if (
    !current ||
    current.localAccountId !== context.localAccountId ||
    current.userId !== context.userId ||
    current.orgId !== context.orgId ||
    current.client.baseUrl !== context.client.baseUrl
  ) {
    throw new SharedSessionAccessError("not_found")
  }
  return { orgId: binding.orgId, policyRevision: decided.policyRevision }
}

export function assertLocalMutationAllowed(
  session: Pick<ChatSession, "collaboration">,
  _action: Extract<SessionAction, "session.post" | "message.correctOwn" | "message.redactOwn">
): void {
  if (session.collaboration) throw new SharedSessionAccessError("server_required")
}
