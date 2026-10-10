/**
 * The host effects of the `filespace_*` agent tools (ADR-0222 §9), wired to
 * the same modules the Files panel uses: the FileSpace loader, the selection
 * expander, `createFileShare` and `createLiveFileShare` (the one door for
 * each kind of share, with the shared-conversation and policy checks), the
 * share-link mirror and the host's grants client. The tools never reach
 * around them, so an agent's share is checked exactly like the person's.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { FilespaceToolDeps } from "@/lib/claude/filespace-builtin-tools"
import { getSession } from "@/lib/db/sessions"
import { listSharedLinksForSession } from "@/lib/db/shared-links"
import { listWorkspaceDir } from "@/lib/files/workspace-fs"
import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import {
  ShareFilesTooLargeError,
  ShareFilesUploadError,
  ShareNotConfiguredError,
  SharePayloadTooLargeError,
  ShareRequestError,
  revokeShareLink,
} from "@/lib/share/client"
import { expandShareSelection } from "@/lib/share/file-selection"

import { fileShareErrorDetails, listLiveGrants, revokeLiveGrant } from "./grants-client"
import { createLiveFileShare } from "./live-share"
import { loadConversationFileSpace } from "./load"
import {
  defaultEffectivePolicyDeps,
  loadEffectiveFileSharingPolicy,
  resolveLocalFileSharingPolicy,
} from "./policy"
import { createFileShare, FileShareRefusedError } from "./share-files"

/** A refusal's stable code and words, whichever layer refused. */
export function describeFilespaceToolError(error: unknown): { code: string; message: string } {
  if (error instanceof FileShareRefusedError) return { code: error.reason, message: error.message }
  if (error instanceof ShareNotConfiguredError) {
    return { code: "share-not-configured", message: error.message }
  }
  if (error instanceof ShareFilesTooLargeError || error instanceof SharePayloadTooLargeError) {
    return { code: "selection-too-large", message: error.message }
  }
  if (error instanceof ShareFilesUploadError) {
    return {
      code: error.revoked ? "upload-failed" : "upload-failed-link-live",
      message: error.message,
    }
  }
  if (error instanceof ShareRequestError) {
    return { code: `share-server-${error.status}`, message: error.message }
  }
  return fileShareErrorDetails(error)
}

export function resolveFilespaceToolDeps(): FilespaceToolDeps {
  return {
    getSession,
    loadFileSpace: (sessionId) => loadConversationFileSpace(sessionId),
    loadPolicy: () => loadEffectiveFileSharingPolicy(),
    listDir: (root, relPath) => listWorkspaceDir(root, relPath, false),
    expandSelection: (space, paths) => expandShareSelection(space, paths),
    createSnapshotShare: (input) => createFileShare(input),
    listShareLinks: (sessionId) => listSharedLinksForSession(sessionId),
    revokeShareLink: (code) => revokeShareLink(code),
    listLiveGrants: (sessionId, hostId) => listLiveGrants({ sessionId }, { hostId }),
    createLiveShare: (request, hostId) => createLiveFileShare(request, { hostId }),
    revokeLiveGrant: (grantId, hostId) => revokeLiveGrant(grantId, { hostId }),
    bundleTitle: async (sessionTitle) => {
      const t = await getRuntimeTranslator("filespace.share")
      return t("bundleTitle", { title: sessionTitle?.trim() || t("untitled") })
    },
    describeError: describeFilespaceToolError,
    now: () => Date.now(),
  }
}

/** Which `filespace_*` tools a turn is offered. */
export interface FilespaceToolSurface {
  /** `filespace_list`, `filespace_revoke_share`, `filespace_disable_webdav`. */
  surfaced: boolean
  /** Also `filespace_share` and `filespace_enable_webdav`. */
  sharing: boolean
}

/**
 * Every conversation has a FileSpace, so the reading and revoking tools are
 * offered to any turn that has a conversation, except in the standalone CLI,
 * which has no FileSpace resolver. The sharing tools need the effective
 * policy to allow agent sharing; the org half (a network read, cached) is
 * consulted only when the person's own policy already allows it, and an
 * org policy that cannot be read withholds them.
 */
export async function resolveFilespaceToolSurface(
  input: {
    hasSession: boolean
    cliHost: boolean
    fileSharing: AppSettings["fileSharing"] | undefined
  },
  // The turn's own settings, not a second read of the stored ones.
  loadPolicy: () => ReturnType<typeof loadEffectiveFileSharingPolicy> = () =>
    loadEffectiveFileSharingPolicy(
      {},
      {
        ...defaultEffectivePolicyDeps,
        readSettings: async () => ({ fileSharing: input.fileSharing }),
      }
    )
): Promise<FilespaceToolSurface> {
  const surfaced = input.hasSession && !input.cliHost
  if (!surfaced || !resolveLocalFileSharingPolicy(input.fileSharing).allowAgentSharing) {
    return { surfaced, sharing: false }
  }
  const effective = await loadPolicy().catch(() => null)
  return { surfaced, sharing: effective?.policy.allowAgentSharing === true }
}
