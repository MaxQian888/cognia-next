/**
 * Sharing Files items as a link (ADR-0223 §10), through ADR-0222's file
 * snapshot: a `file-bundle` share whose files travel as client-encrypted,
 * chunked blobs. The share dialog's `createFileShare` gate does the policy,
 * sensitive-file and size checks; this module turns the picked items into the
 * files it checks, and covers what that gate cannot know about Files:
 *
 * - Items come from many conversations, not one. Every collaboration
 *   conversation an item belongs to is asked whether its files may be
 *   published (`files.share`) before anything is uploaded; one refusal
 *   refuses the share.
 * - Each file is named in the bundle by where it sits in Files:
 *   `/files/<folder path>/<file name>`, numbered like a zip export when two
 *   items would share a path.
 * - A link made from Files is remembered on the items it carries
 *   (`recordLibraryItemsShared`), which drives the "shared by link" marker
 *   while the link is live in `sharedLinks`.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import {
  assertSharedSessionFileShare,
  SharedSessionAccessError,
} from "@/lib/collab/shared-session-access"
import { recordLibraryItemsShared } from "@/lib/db/files-library-items"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { getDb } from "@/lib/db/schema"
import { getSessionsByIds } from "@/lib/db/sessions"
import { joinFileSpacePath } from "@/lib/filespace/paths"
import { loadEffectiveFileSharingPolicy } from "@/lib/filespace/policy"
import { isSensitivePath } from "@/lib/filespace/sensitive"
import { FileShareRefusedError } from "@/lib/filespace/share-files"
import { blobShareSource } from "@/lib/share/file-sources"
import { mimeForFileName, type ShareFileCandidate } from "@/lib/share/file-selection"
import { fileBundlePayload } from "@/lib/share/payload"
import type { SharePayload } from "@/lib/share/types"

import { downloadPayloadFor, type FilesDownloadPayload } from "./download"
import { numberedPath, zipFolderPath } from "./export-zip"
import { loadLiveShareCodes } from "./sources"
import { entrySource, type FilesEntry } from "./types"

/** The id prefix of a conversation somebody else shared in (`isSharedWithMe`). */
const SHARED_SESSION_PREFIX = "shared:"

/** Where every Files item sits inside a bundle. */
export const FILES_SHARE_ROOT = "/files"

/** A trashed item is on its way out; everything else can be shared. */
export function isFilesShareAvailable(entry: Pick<FilesEntry, "trashedAt">): boolean {
  return entry.trashedAt === undefined
}

/** The picked items as the files a share would carry. */
export interface FilesShareSelection {
  /** In the order the items were picked. */
  files: ShareFileCandidate[]
  /** Which item each file came from, by FileSpace path. */
  keyByPath: ReadonlyMap<string, string>
  /** Items whose content is no longer stored, so they cannot be carried. */
  missing: FilesEntry[]
  /** Collaboration conversations the items belong to; each must allow the share. */
  sessions: Pick<ChatSession, "id" | "collaboration">[]
  /**
   * Shared conversations (`shared:` ids) an item names that are no longer
   * stored here — a kept item outliving a projection the person left. Their
   * organization cannot be asked, so the share is refused rather than
   * assumed allowed.
   */
  unverifiableSessionIds: string[]
}

export interface FilesShareSelectionDeps {
  payloadFor: (entry: FilesEntry) => Promise<FilesDownloadPayload | null>
  getSessions: (ids: readonly string[]) => Promise<Pick<ChatSession, "id" | "collaboration">[]>
}

const defaultSelectionDeps: FilesShareSelectionDeps = {
  payloadFor: downloadPayloadFor,
  getSessions: getSessionsByIds,
}

/**
 * Read what each picked item would carry. Only Blob handles are taken — an
 * upload's bytes stay in IndexedDB until the share reads them chunk by chunk.
 */
export async function resolveFilesShareSelection(
  entries: readonly FilesEntry[],
  folders: readonly LibraryFolder[],
  deps: Partial<FilesShareSelectionDeps> = {}
): Promise<FilesShareSelection> {
  const { payloadFor, getSessions } = { ...defaultSelectionDeps, ...deps }
  const files: ShareFileCandidate[] = []
  const keyByPath = new Map<string, string>()
  const missing: FilesEntry[] = []
  const taken = new Set<string>()
  const sessionIds = new Set<string>()

  for (const entry of entries) {
    for (const id of [entry.originSessionId, ...entry.sessionIds]) if (id) sessionIds.add(id)
    const payload = await payloadFor(entry)
    if (!payload) {
      missing.push(entry)
      continue
    }
    const folder = zipFolderPath(entry, folders)
    const base = folder ? `${folder}/${payload.filename}` : payload.filename
    // Viewers save files under these names, so paths compare as case-blind
    // file systems would.
    let relative = base
    for (let n = 2; taken.has(relative.toLowerCase()); n += 1) relative = numberedPath(base, n)
    const path =
      joinFileSpacePath(FILES_SHARE_ROOT, relative) ??
      joinFileSpacePath(FILES_SHARE_ROOT, payload.filename)
    if (!path || keyByPath.has(path)) {
      missing.push(entry)
      continue
    }
    taken.add(relative.toLowerCase())
    keyByPath.set(path, entry.key)
    const blob = payload.blob
    // A document's text is stored as plain text; its name says what it is.
    const byName = mimeForFileName(payload.filename)
    files.push({
      path,
      name: payload.filename,
      mime:
        entry.mediaType ||
        (byName !== "application/octet-stream" ? byName : blob.type.split(";")[0] || byName),
      size: blob.size,
      sensitive: isSensitivePath(relative),
      open: async () => blobShareSource(blob),
    })
  }

  const stored = await getSessions([...sessionIds])
  const found = new Set(stored.map((session) => session.id))
  const sessions = stored.filter((session) => session.collaboration !== undefined)
  const unverifiableSessionIds = [...sessionIds].filter(
    (id) => id.startsWith(SHARED_SESSION_PREFIX) && !found.has(id)
  )
  return { files, keyByPath, missing, sessions, unverifiableSessionIds }
}

export interface FilesShareAuthorizeDeps {
  authorizeSharedSession: typeof assertSharedSessionFileShare
  loadPolicy: typeof loadEffectiveFileSharingPolicy
}

const defaultAuthorizeDeps: FilesShareAuthorizeDeps = {
  authorizeSharedSession: assertSharedSessionFileShare,
  loadPolicy: loadEffectiveFileSharingPolicy,
}

/**
 * Ask every collaboration conversation whether its files may be published.
 * A shared conversation that is no longer stored here cannot be asked, and
 * refuses the share as unavailable before any other is asked. A refusal is raised as the same `FileShareRefusedError` the share gate
 * raises, so the dialog explains it the same way. The newest policy revision
 * any answer named is then loaded, so the gate's own policy read that follows
 * cannot judge the share by an older cached org policy.
 */
export async function authorizeFilesShare(
  {
    sessions,
    unverifiableSessionIds,
  }: Pick<FilesShareSelection, "sessions" | "unverifiableSessionIds">,
  deps: Partial<FilesShareAuthorizeDeps> = {}
): Promise<void> {
  const { authorizeSharedSession, loadPolicy } = { ...defaultAuthorizeDeps, ...deps }
  if (unverifiableSessionIds.length > 0) {
    throw new FileShareRefusedError("shared-session-unavailable")
  }
  let newest: number | undefined
  for (const session of sessions) {
    let decided: { policyRevision: number } | null
    try {
      decided = await authorizeSharedSession(session)
    } catch (error) {
      throw new FileShareRefusedError(
        error instanceof SharedSessionAccessError && error.reason === "forbidden"
          ? "shared-session-forbidden"
          : "shared-session-unavailable"
      )
    }
    if (decided) newest = Math.max(newest ?? 0, decided.policyRevision)
  }
  if (newest !== undefined) await loadPolicy({ minOrgRevision: newest })
}

/** The payload of a share made from Files: the files and nothing else. */
export function filesSharePayload(title: string): SharePayload {
  return fileBundlePayload(title)
}

/**
 * Remember a created link on the items it carries. Codes the items recorded
 * earlier whose links are gone (revoked or expired) are dropped on the way.
 */
export async function recordFilesShare(
  entries: readonly FilesEntry[],
  code: string
): Promise<void> {
  const rows = await getDb().libraryItems.bulkGet(entries.map((entry) => entry.key))
  const live = await loadLiveShareCodes(rows.flatMap((row) => row?.sharedLinkCodes ?? []))
  await recordLibraryItemsShared(entries.map(entrySource), code, live)
}
