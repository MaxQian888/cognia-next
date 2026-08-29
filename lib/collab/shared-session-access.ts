"use client"

import type { ChatSession, SessionAction } from "@cognia/agent-config-types"
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
  const binding = session.collaboration
  if (!binding) return
  const context = await resolveContext()
  if (!context || context.orgId !== binding.orgId) {
    throw new SharedSessionAccessError("not_found")
  }
  try {
    const [remote, members] = await Promise.all([
      context.client.getSharedSession(binding.orgId, binding.sessionId),
      context.client.listSessionMembers(binding.orgId, binding.sessionId),
    ])
    const member = members.find((candidate) => candidate.userId === context.userId) ?? null
    const decision = authorizeSessionAction(member, "session.read", remote.policyRevision)
    if (!decision.allowed) throw new SharedSessionAccessError("not_found")
  } catch (error) {
    if (error instanceof SharedSessionAccessError) throw error
    throw new SharedSessionAccessError("not_found")
  }
}

export function assertLocalMutationAllowed(
  session: Pick<ChatSession, "collaboration">,
  _action: Extract<SessionAction, "session.post" | "message.correctOwn" | "message.redactOwn">
): void {
  if (session.collaboration) throw new SharedSessionAccessError("server_required")
}
