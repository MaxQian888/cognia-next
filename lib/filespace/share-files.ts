/**
 * Publishing a conversation's files as a snapshot link (ADR-0222 §6.3–6.4):
 * the one door every "share with files" path goes through, so the checks
 * cannot be skipped by a caller that only knew about `createShareLink`.
 *
 * Before anything is read or uploaded:
 * 1. a conversation shared through a collaboration org asks the plane whether
 *    this person may publish its files (`files.share` plus the org policy) —
 *    the server's answer, not the client's belief;
 * 2. the effective policy (local ∩ org) must allow public snapshots for the
 *    lifetime asked for;
 * 3. a file the sensitive floor flags is carried only when the person opted
 *    into that file by path.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import {
  assertSharedSessionFileShare,
  SharedSessionAccessError,
} from "@/lib/collab/shared-session-access"
import {
  createShareLink,
  type CreateShareFile,
  type CreateShareInput,
  type CreatedShare,
} from "@/lib/share/client"
import type { ShareEndpoint } from "@/lib/share/config"
import type { ShareFileCandidate } from "@/lib/share/file-selection"

import {
  checkSnapshotFileShare,
  loadEffectiveFileSharingPolicy,
  type SnapshotFileShareDenial,
} from "./policy"

export type FileShareRefusal =
  | SnapshotFileShareDenial
  | "shared-session-forbidden"
  | "shared-session-unavailable"
  | "sensitive-not-confirmed"

/** A file share refused before anything left the device. */
export class FileShareRefusedError extends Error {
  constructor(readonly reason: FileShareRefusal) {
    super(`File share refused: ${reason}`)
    this.name = "FileShareRefusedError"
  }
}

export interface CreateFileShareInput extends Omit<CreateShareInput, "files" | "sessionId"> {
  /** The conversation the files come from; checked when it is shared through an org. */
  session?: Pick<ChatSession, "id" | "collaboration">
  files: ShareFileCandidate[]
  /**
   * Files the payload's builder produced itself — media a transcript could
   * not inline (`lib/share/chat-media.ts`). Not from the FileSpace, so the
   * sensitive floor does not apply, but they are files: policy does.
   */
  attachments?: CreateShareFile[]
  /** FileSpace paths of sensitive files the person explicitly chose to include. */
  confirmedSensitive?: ReadonlySet<string>
}

export interface CreateFileShareDeps {
  authorizeSharedSession: typeof assertSharedSessionFileShare
  loadPolicy: typeof loadEffectiveFileSharingPolicy
  createShareLink: typeof createShareLink
}

export const defaultCreateFileShareDeps: CreateFileShareDeps = {
  authorizeSharedSession: assertSharedSessionFileShare,
  loadPolicy: loadEffectiveFileSharingPolicy,
  createShareLink,
}

/** Check, then create the share. A share without files skips the file checks. */
export async function createFileShare(
  input: CreateFileShareInput,
  endpoint?: ShareEndpoint,
  deps: CreateFileShareDeps = defaultCreateFileShareDeps
): Promise<CreatedShare> {
  const { session, files, attachments = [], confirmedSensitive, ...share } = input
  if (files.length > 0 || attachments.length > 0) {
    const unconfirmed = files.some((file) => file.sensitive && !confirmedSensitive?.has(file.path))
    if (unconfirmed) throw new FileShareRefusedError("sensitive-not-confirmed")

    let decided: { policyRevision: number } | null = null
    if (session) {
      try {
        decided = await deps.authorizeSharedSession(session)
      } catch (error) {
        throw new FileShareRefusedError(
          error instanceof SharedSessionAccessError && error.reason === "forbidden"
            ? "shared-session-forbidden"
            : "shared-session-unavailable"
        )
      }
    }
    const effective = await deps.loadPolicy({ minOrgRevision: decided?.policyRevision })
    const denial = checkSnapshotFileShare(effective.policy, share.ttlSeconds)
    if (denial) throw new FileShareRefusedError(denial)
  }
  return deps.createShareLink(
    {
      ...share,
      sessionId: session?.id,
      files: [
        ...files.map((file) => ({
          path: file.path,
          name: file.name,
          mime: file.mime,
          open: file.open,
        })),
        ...attachments,
      ],
    },
    endpoint
  )
}
