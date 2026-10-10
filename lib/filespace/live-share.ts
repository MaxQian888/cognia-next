/**
 * Creating a live share (ADR-0222 §7, §9.1): the one door every live grant
 * goes through — the Files panel's dialog and the agent's `filespace_*` tools
 * alike — so the checks cannot be skipped by a caller that only knew about
 * `createLiveGrant`.
 *
 * The host re-checks the policy, the paths, the mounts and the sensitive
 * floor on its own. What it cannot know is the collaboration plane: a
 * conversation shared through an org may have its files published only by a
 * member the server allows (`files.share` plus the org policy). That answer is
 * asked here, before the host is asked for anything, exactly as
 * `createFileShare` does for snapshot links.
 *
 * A share for the conversation's members (`audience.kind === "collab"`, P3)
 * needs one more thing first: the host must be registered as the shared
 * conversation's file host (`ensureCollabFileHost`), so the share binds to
 * that registration and members' requests reach it. Only a shared
 * conversation has members.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import { suggestDeviceName } from "@/lib/account-sync/enrollment/platform"
import { ensureCollabFileHost } from "@/lib/collab/file-host"
import {
  assertSharedSessionFileShare,
  SharedSessionAccessError,
} from "@/lib/collab/shared-session-access"
import { getSession } from "@/lib/db/sessions"
import { CommandInvokeError } from "@/lib/tauri/command-error"
import type { CreatedLiveGrant, CreateLiveGrantRequest } from "@/types/filespace/live"

import { createLiveGrant, type FileShareTarget } from "./grants-client"

export interface CreateLiveFileShareDeps {
  getSession: (id: string) => Promise<Pick<ChatSession, "id" | "collaboration"> | undefined>
  authorizeSharedSession: typeof assertSharedSessionFileShare
  ensureCollabFileHost: typeof ensureCollabFileHost
  createLiveGrant: typeof createLiveGrant
}

export const defaultCreateLiveFileShareDeps: CreateLiveFileShareDeps = {
  getSession,
  authorizeSharedSession: assertSharedSessionFileShare,
  ensureCollabFileHost,
  createLiveGrant,
}

export interface CreateLiveFileShareOptions {
  /**
   * How members see the host when it registers for them; defaults to this
   * device's kind ("Mac", "Windows"…). Pass the host's own name when sharing
   * from another device.
   */
  hostLabel?: string
}

/** A product name for the host when nothing better is known; needs no translation. */
const FALLBACK_HOST_LABEL = "Cognia"

function refused(
  code: "shared_session_forbidden" | "shared_session_unavailable" | "collab_host_unregistered"
): Error {
  return new CommandInvokeError({
    code,
    message:
      code === "shared_session_forbidden"
        ? "the collaboration server does not let this person share this conversation's files"
        : code === "collab_host_unregistered"
          ? "only a shared conversation has members to share files with"
          : "the collaboration server could not be asked whether this conversation's files may be shared",
    retryable: code === "shared_session_unavailable",
    structured: true,
  })
}

/**
 * Check, then create the grant. A refusal carries a code from
 * `FILE_SHARE_ERROR_CODES`, like the host's own, so one error mapping serves
 * both.
 */
export async function createLiveFileShare(
  request: CreateLiveGrantRequest,
  target?: FileShareTarget,
  deps: CreateLiveFileShareDeps = defaultCreateLiveFileShareDeps,
  options: CreateLiveFileShareOptions = {}
): Promise<CreatedLiveGrant> {
  const session = await deps.getSession(request.sessionId)
  const forMembers = request.audience?.kind === "collab"
  if (forMembers && !session?.collaboration) throw refused("collab_host_unregistered")
  if (session?.collaboration) {
    try {
      await deps.authorizeSharedSession(session)
    } catch (error) {
      throw refused(
        error instanceof SharedSessionAccessError && error.reason === "forbidden"
          ? "shared_session_forbidden"
          : "shared_session_unavailable"
      )
    }
  }
  if (forMembers && session) {
    // `ensureCollabFileHost` answers with a `FILE_SHARE_ERROR_CODES` code.
    await deps.ensureCollabFileHost(
      session,
      options.hostLabel?.trim() || suggestDeviceName() || FALLBACK_HOST_LABEL,
      target
    )
  }
  return deps.createLiveGrant(request, target)
}
