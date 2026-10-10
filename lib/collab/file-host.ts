"use client"

/**
 * Making a host the file host of a shared conversation (ADR-0222 §6).
 *
 * A conversation shared through an org has a counterpart on the collaboration
 * server. Before its members can be given live access to its files, the host
 * that holds them registers there: a member who may share the files
 * (`files.share`) asks the server for a host token, and the host keeps it
 * (`file_collab_host_set`) to answer members' requests and mirror its shares.
 * Registering again replaces the previous registration and ends the shares
 * made under it, on both sides, so an existing usable registration is reused.
 *
 * The registration is made with the person's own sign-in, here; the host
 * never sees that sign-in, only the token.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import {
  getCollabHostStatus,
  setCollabHost,
  type FileShareTarget,
} from "@/lib/filespace/grants-client"
import { CommandInvokeError } from "@/lib/tauri/command-error"
import type { CollabHostStatus } from "@/types/filespace/live"

import { CollabError } from "./client"
import { resolveCurrentCollabContext, type CurrentCollabContext } from "./runtime-client"

export interface CollabFileHostDeps {
  resolveContext: () => Promise<CurrentCollabContext | null>
  getStatus: typeof getCollabHostStatus
  setHost: typeof setCollabHost
}

export const defaultCollabFileHostDeps: CollabFileHostDeps = {
  resolveContext: resolveCurrentCollabContext,
  getStatus: getCollabHostStatus,
  setHost: setCollabHost,
}

type SharedSession = Pick<ChatSession, "id" | "collaboration">

function refused(code: "shared_session_forbidden" | "shared_session_unavailable"): Error {
  return new CommandInvokeError({
    code,
    message:
      code === "shared_session_forbidden"
        ? "the collaboration server does not let this person share this conversation's files"
        : "the collaboration server could not register this host for the conversation",
    retryable: code === "shared_session_unavailable",
    structured: true,
  })
}

function sameServer(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "")
}

/** Whether the host's registration serves this conversation's counterpart now. */
export function registrationMatches(
  status: CollabHostStatus,
  session: SharedSession,
  serverUrl?: string
): boolean {
  const binding = session.collaboration
  const registration = status.registration
  if (!binding || !registration || !status.tokenPresent) return false
  if (registration.orgId !== binding.orgId) return false
  if (registration.collabSessionId !== binding.sessionId) return false
  if (serverUrl && !sameServer(registration.serverUrl, serverUrl)) return false
  return status.lastError !== "host_unregistered"
}

async function currentContext(
  session: SharedSession,
  deps: CollabFileHostDeps
): Promise<CurrentCollabContext> {
  const binding = session.collaboration
  if (!binding) throw refused("shared_session_unavailable")
  const context = await deps.resolveContext()
  if (
    !context ||
    context.orgId !== binding.orgId ||
    (binding.endpoint && !sameServer(binding.endpoint, context.client.baseUrl))
  ) {
    throw refused("shared_session_unavailable")
  }
  return context
}

/**
 * Make sure the host serving `session`'s files is registered for its shared
 * counterpart, registering it when it is not. Resolves to the host's status.
 * A refusal carries a `FILE_SHARE_ERROR_CODES` code.
 */
export async function ensureCollabFileHost(
  session: SharedSession,
  hostLabel: string,
  target?: FileShareTarget,
  deps: CollabFileHostDeps = defaultCollabFileHostDeps
): Promise<CollabHostStatus> {
  const context = await currentContext(session, deps)
  const binding = session.collaboration!
  const status = await deps.getStatus(session.id, target)
  if (registrationMatches(status, session, context.client.baseUrl)) return status
  let token: string
  try {
    token = (await context.client.registerFileHost(binding.orgId, binding.sessionId, hostLabel))
      .hostToken
  } catch (error) {
    throw refused(
      error instanceof CollabError && error.status === 403
        ? "shared_session_forbidden"
        : "shared_session_unavailable"
    )
  }
  return deps.setHost(
    session.id,
    {
      orgId: binding.orgId,
      collabSessionId: binding.sessionId,
      serverUrl: context.client.baseUrl,
      hostLabel,
      hostToken: token,
    },
    target
  )
}

/**
 * Stop serving `session`'s members: the host unregisters with its own token
 * and revokes the members' shares. Resolves to the host's status.
 */
export async function endCollabFileHost(
  session: SharedSession,
  target?: FileShareTarget,
  deps: Pick<CollabFileHostDeps, "setHost"> = defaultCollabFileHostDeps
): Promise<CollabHostStatus> {
  return deps.setHost(session.id, null, target)
}
