/**
 * A conversation's FileSpace mount table in the shape the live file-share host
 * accepts (ADR-0222 §7.5): which directories `/workspace` and `/roots/*` are,
 * and which uploads and artifacts `/uploads` and `/artifacts` list.
 *
 * The host gets it two ways and both build it here: pushed by
 * `lib/filespace/host-sync.ts` (`file_space_sync`), and pulled by the host
 * itself through `companion://filespace-mounts-request`, which
 * `installDesktopMessageSource` answers with {@link readFileSpaceMounts}.
 *
 * The host asking is always the one the files live on (this machine's from
 * the desktop WebView, the brain's own server from the brain), so a FileSpace
 * is resolved here as that host sees it.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import { getSession } from "@/lib/db/sessions"
import {
  defaultLoadFileSpaceDeps,
  loadConversationFileSpace,
  type LoadedConversationFileSpace,
} from "@/lib/filespace/load"
import { LOCAL_FILESPACE_HOST_ID } from "@/lib/filespace/resolve"
import type { FileSpaceDexieEntry } from "@/types/filespace"
import type { SessionMountsInput } from "@/types/filespace/live"

/** The event the host emits to pull a mount table; mirrors `FILESPACE_MOUNTS_EVENT`. */
export const FILESPACE_MOUNTS_EVENT = "companion://filespace-mounts-request"

export interface FileSpaceMountsRequest {
  requestId: string
  kind: "filespace_mounts"
  sessionId: string
}

export interface MountTableDeps {
  getSession: (id: string) => Promise<ChatSession | undefined>
  loadSpace: (sessionId: string) => Promise<LoadedConversationFileSpace>
}

/**
 * Resolve FileSpaces as the host that holds them sees them: its own disk is
 * reachable, whatever remote host this window may be driving.
 */
export const defaultMountTableDeps: MountTableDeps = {
  getSession,
  loadSpace: (sessionId) =>
    loadConversationFileSpace(sessionId, {
      ...defaultLoadFileSpaceDeps,
      host: () => ({ id: LOCAL_FILESPACE_HOST_ID, fsBackend: true, reachable: true }),
    }),
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

function assetRow(entry: FileSpaceDexieEntry): SessionMountsInput["assets"][number] {
  return {
    mountId: entry.mountId,
    // The FileSpace name, disambiguated when two rows collide, so the path a
    // credential sees is the path a FileSpace link names.
    name: lastSegment(entry.path),
    size: entry.size,
    mediaType: entry.mediaType,
    modifiedAt: entry.updatedAt,
    sourceId: entry.sourceId,
  }
}

/**
 * One conversation's mount table in the host's shape. A conversation that is
 * gone is `deleted` with no mounts, which is what makes the host revoke its
 * grants; an archived one is `archived`, which suspends them.
 */
export async function buildSessionMountsInput(
  sessionId: string,
  deps: MountTableDeps = defaultMountTableDeps
): Promise<SessionMountsInput> {
  const session = await deps.getSession(sessionId)
  if (!session) return { sessionId, state: "deleted", mounts: [], assets: [] }
  const { space, dexie } = await deps.loadSpace(sessionId)
  return {
    sessionId,
    state: session.archivedAt ? "archived" : "active",
    mounts: space.mounts.map((mount) => ({
      mountId: mount.id,
      virtualPath: mount.virtualPath,
      backing: mount.backing,
      ...(mount.backing === "disk" && mount.hostPath ? { hostPath: mount.hostPath } : {}),
      writable: mount.writable,
      status: mount.status,
    })),
    // A row whose bytes did not survive cannot be served, so it is not listed.
    assets: [...dexie.uploads, ...dexie.artifacts]
      .filter((entry) => entry.sourceAvailable)
      .map(assetRow),
  }
}

/** Answer the host's pull for one conversation. */
export function readFileSpaceMounts(
  request: FileSpaceMountsRequest,
  deps: MountTableDeps = defaultMountTableDeps
): Promise<SessionMountsInput> {
  if (typeof request?.sessionId !== "string" || !request.sessionId) {
    return Promise.reject(new Error("a mount table request names no conversation"))
  }
  return buildSessionMountsInput(request.sessionId, deps)
}
