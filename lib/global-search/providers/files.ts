/**
 * Files (ADR-0200): artifacts, canvas documents, and uploaded files / named
 * images, found by name from ⌘K. Selecting one opens its preview on `/files`;
 * artifacts and canvas documents can also be referenced into the composer.
 *
 * Identity only — titles, types and workspaces. Bodies are searched on the
 * Files page itself, where the aggregate is already loaded; a provider runs on
 * every keystroke and must not read every artifact's content per needle.
 *
 * Items the person removed from Files or moved to its Trash are left out, and
 * an item renamed in Files is listed under that name (ADR-0223) — the palette
 * offers what the Files page shows, by the same rule (`isItemHidden`).
 *
 * Offered wherever the page itself runs (`lib/runtime/surface-contract.ts`).
 * On a client that owns its database — desktop, web, an unpaired phone — the
 * three providers read it. On a paired client the page manages the host's
 * library (ADR-0223 §9), and its local tables are not that library: the
 * artifact and canvas providers stay empty there, and the items provider lists
 * every kind from the host (`files_library_list`, titles only, the same
 * identity-only rule), each linking to its preview on `/files`.
 */

import { FileIcon, PenLineIcon, ShapesIcon } from "lucide-react"

import type { Artifact, CanvasDocument } from "@/types/artifact/artifact"
import { listLibraryItems } from "@/lib/db/files-library-items"
import {
  isLibraryItemKept,
  libraryItemKey,
  type LibraryItemRow,
} from "@/lib/db/files-library-types"
import { listAllSessionAssets, listLibraryAssets } from "@/lib/db/session-assets"
import { isImageMediaType, isItemHidden } from "@/lib/files-library/aggregate"
import { filesLocationHref } from "@/lib/files-library/deep-link"
import type { FilesRemoteClient } from "@/lib/files-library/remote/client"
import { FILES_IMAGE_PAGE_SIZE } from "@/lib/files-library/sources"
import type { FilesEntry } from "@/lib/files-library/types"
import { getSurfaceContract, resolveSurfaceAvailability } from "@/lib/runtime/surface-contract"
import { byProjectId } from "../workspace-scope"
import { createListProvider } from "./list-provider"
import type { GlobalSearchContext } from "../types"

export const FILES_ARTIFACTS_PROVIDER_ID = "builtin.files.artifacts"
export const FILES_CANVAS_PROVIDER_ID = "builtin.files.canvas"
export const FILES_ITEMS_PROVIDER_ID = "builtin.files.items"

function toMillis(value: Date | string | number): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function filesHref(key: string): string {
  return filesLocationHref({ item: key })
}

export interface FilesProviderDeps {
  artifacts: () => Promise<Record<string, Artifact>>
  canvasDocuments: () => Promise<Record<string, CanvasDocument>>
  /** Files metadata by item key: what was removed, trashed or renamed. */
  libraryItems: () => Promise<ReadonlyMap<string, LibraryItemRow>>
  loadItems: (ctx: GlobalSearchContext) => Promise<FileSearchRow[]>
  /** The paired host's library, as rows (paired clients only). */
  loadRemoteItems?: () => Promise<FileSearchRow[]>
}

async function libraryItemsByKey(): Promise<Map<string, LibraryItemRow>> {
  return new Map((await listLibraryItems()).map((item) => [item.key, item]))
}

/** Out of the palette: removed from Files (until its source changes) or trashed. */
function leftOut(item: LibraryItemRow | undefined, sourceUpdatedAt: number): boolean {
  return item?.trashedAt !== undefined || isItemHidden(item, sourceUpdatedAt)
}

/**
 * The rows Files still shows, each under the name Files gives it. Copies, so
 * the store's own objects are never renamed.
 */
function asFilesShows<T extends { title: string; updatedAt: Date | string | number }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  items: ReadonlyMap<string, LibraryItemRow>
): T[] {
  const out: T[] = []
  for (const row of rows) {
    const item = items.get(keyOf(row))
    if (leftOut(item, toMillis(row.updatedAt))) continue
    const displayName = item?.displayName?.trim()
    out.push(displayName ? { ...row, title: displayName } : row)
  }
  return out
}

async function artifactState() {
  const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
  return useArtifactStore.getState()
}

/** An upload or a named image (or, from a paired host, any item), as the palette lists it. */
export interface FileSearchRow {
  key: string
  title: string
  mediaType?: string
  projectId?: string
  timestamp: number
  /** Set for a paired host's rows, which are every kind. */
  kind?: FilesEntry["kind"]
}

/**
 * A paired host's library as palette rows: what its Files page shows (not
 * trashed, not removed), under the name Files gives each item. Images
 * without a name are left out, as they are on the desktop's palette.
 */
export async function loadRemoteFileSearchRows(
  client: Pick<FilesRemoteClient, "list">
): Promise<FileSearchRow[]> {
  const { entries } = await client.list(FILES_IMAGE_PAGE_SIZE)
  const rows: FileSearchRow[] = []
  for (const entry of entries) {
    if (entry.trashedAt !== undefined || entry.hidden || !entry.title.trim()) continue
    rows.push({
      key: entry.key,
      title: entry.title,
      kind: entry.kind,
      ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
      ...(entry.projectIds[0] ? { projectId: entry.projectIds[0] } : {}),
      timestamp: entry.updatedAt,
    })
  }
  return rows
}

async function liveRemoteRows(): Promise<FileSearchRow[]> {
  const { liveFilesRemoteClient } = await import("@/lib/files-library/remote/live-transport")
  return loadRemoteFileSearchRows(liveFilesRemoteClient())
}

/**
 * Uploads (one row per file, however many conversations hold it), Files-owned
 * uploads, and images that carry a name because they were uploaded to Files
 * or kept with one. Image uploads are their canonical image, not a file row.
 */
export async function loadFileSearchRows(
  sessions: readonly { id: string; projectId?: string }[] = []
): Promise<FileSearchRow[]> {
  const sessionProject = new Map(sessions.map((session) => [session.id, session.projectId]))
  const [sessionAssets, libraryAssets, items] = await Promise.all([
    listAllSessionAssets(),
    listLibraryAssets(),
    listLibraryItems(),
  ])
  const rows = new Map<string, FileSearchRow>()
  const ownedHashes = new Set(libraryAssets.map((asset) => asset.contentHash))
  for (const asset of libraryAssets) {
    const key = libraryItemKey("upload", asset.assetId)
    rows.set(key, {
      key,
      title: asset.filename,
      mediaType: asset.mediaType,
      timestamp: asset.updatedAt,
    })
  }
  for (const asset of sessionAssets) {
    if (isImageMediaType(asset.mediaType) || !asset.sourceAvailable) continue
    if (ownedHashes.has(asset.contentHash)) continue
    const key = libraryItemKey("session-upload", asset.contentHash)
    const previous = rows.get(key)
    if (previous && previous.timestamp >= asset.updatedAt) continue
    const projectId = sessionProject.get(asset.sessionId)
    rows.set(key, {
      key,
      title: asset.filename,
      mediaType: asset.mediaType,
      ...(projectId ? { projectId } : {}),
      timestamp: asset.updatedAt,
    })
  }
  for (const item of items) {
    const existing = rows.get(item.key)
    if (existing) {
      if (item.projectId) existing.projectId = item.projectId
      if (leftOut(item, existing.timestamp)) rows.delete(item.key)
      else if (item.displayName?.trim()) existing.title = item.displayName.trim()
      continue
    }
    if (leftOut(item, item.updatedAt)) continue
    if (item.kind !== "image" || !item.snapshot?.title) continue
    if (!item.ownedByFiles && !isLibraryItemKept(item)) continue
    rows.set(item.key, {
      key: item.key,
      title: item.displayName?.trim() || item.snapshot.title,
      ...(item.snapshot.mediaType ? { mediaType: item.snapshot.mediaType } : {}),
      ...(item.projectId ? { projectId: item.projectId } : {}),
      timestamp: item.updatedAt,
    })
  }
  return [...rows.values()]
}

const defaultDeps: FilesProviderDeps = {
  artifacts: async () => (await artifactState()).artifacts,
  canvasDocuments: async () => (await artifactState()).canvasDocuments,
  libraryItems: libraryItemsByKey,
  loadItems: (ctx) => loadFileSearchRows(ctx.sessions),
  loadRemoteItems: liveRemoteRows,
}

/** The Files page runs on this client (see the module comment). */
function filesReachable(ctx: GlobalSearchContext): boolean {
  const contract = getSurfaceContract("files")
  return (
    contract !== null &&
    resolveSurfaceAvailability(contract, ctx.runtimeSnapshot).state === "available"
  )
}

/** The page manages a paired host's library, not this client's tables. */
function filesRemote(ctx: GlobalSearchContext): boolean {
  return ctx.runtimeSnapshot?.target?.kind === "companion"
}

/** This client's own library is the one the page shows. */
function filesLocal(ctx: GlobalSearchContext): boolean {
  return filesReachable(ctx) && !filesRemote(ctx)
}

const ROW_ICONS = {
  artifact: ShapesIcon,
  canvas: PenLineIcon,
} as const

export function createFilesArtifactsProvider(
  deps: Pick<FilesProviderDeps, "artifacts"> &
    Partial<Pick<FilesProviderDeps, "libraryItems">> = defaultDeps
) {
  return createListProvider<Artifact>({
    id: FILES_ARTIFACTS_PROVIDER_ID,
    kind: "artifact",
    load: async (ctx) => {
      if (!filesLocal(ctx)) return []
      const [artifacts, items] = await Promise.all([
        deps.artifacts(),
        (deps.libraryItems ?? libraryItemsByKey)(),
      ])
      return asFilesShows(Object.values(artifacts), (a) => libraryItemKey("artifact", a.id), items)
    },
    getTitle: (a) => a.title,
    getSecondary: (a) => (a.language ? `${a.type} · ${a.language}` : a.type),
    getTimestamp: (a) => toMillis(a.updatedAt),
    workspaceScope: { mode: "filter", belongs: byProjectId((a: Artifact) => a.projectId) },
    toItem: ({ row, match }) => ({
      id: `artifact:${row.id}`,
      kind: "artifact",
      title: row.title,
      titlePositions: match.positions,
      subtitle: row.language ? `${row.type} · ${row.language}` : row.type,
      icon: { lucide: ShapesIcon },
      score: match.score,
      timestamp: toMillis(row.updatedAt),
      action: { type: "navigate", href: filesHref(libraryItemKey("artifact", row.id)) },
    }),
  })
}

export function createFilesCanvasProvider(
  deps: Pick<FilesProviderDeps, "canvasDocuments"> &
    Partial<Pick<FilesProviderDeps, "libraryItems">> = defaultDeps
) {
  return createListProvider<CanvasDocument>({
    id: FILES_CANVAS_PROVIDER_ID,
    kind: "canvas-document",
    load: async (ctx) => {
      if (!filesLocal(ctx)) return []
      const [documents, items] = await Promise.all([
        deps.canvasDocuments(),
        (deps.libraryItems ?? libraryItemsByKey)(),
      ])
      return asFilesShows(Object.values(documents), (d) => libraryItemKey("canvas", d.id), items)
    },
    getTitle: (d) => d.title,
    getSecondary: (d) => d.language,
    getTimestamp: (d) => toMillis(d.updatedAt),
    workspaceScope: { mode: "filter", belongs: byProjectId((d: CanvasDocument) => d.projectId) },
    toItem: ({ row, match }) => ({
      id: `canvas:${row.id}`,
      kind: "canvas-document",
      title: row.title,
      titlePositions: match.positions,
      subtitle: row.language,
      icon: { lucide: PenLineIcon },
      score: match.score,
      timestamp: toMillis(row.updatedAt),
      action: { type: "navigate", href: filesHref(libraryItemKey("canvas", row.id)) },
    }),
  })
}

export function createFilesItemsProvider(
  deps: Pick<FilesProviderDeps, "loadItems" | "loadRemoteItems"> = defaultDeps
) {
  return createListProvider<FileSearchRow>({
    id: FILES_ITEMS_PROVIDER_ID,
    kind: "library-file",
    load: async (ctx) => {
      if (!filesReachable(ctx)) return []
      if (!filesRemote(ctx)) return deps.loadItems(ctx)
      // The host unreachable is no hits, not a broken palette.
      return deps.loadRemoteItems ? deps.loadRemoteItems().catch(() => []) : []
    },
    getTitle: (row) => row.title,
    getSecondary: (row) => row.mediaType,
    getTimestamp: (row) => row.timestamp,
    workspaceScope: { mode: "filter", belongs: byProjectId((row: FileSearchRow) => row.projectId) },
    toItem: ({ row, match }) => ({
      id: `library-file:${row.key}`,
      kind: "library-file",
      title: row.title,
      titlePositions: match.positions,
      ...(row.mediaType ? { subtitle: row.mediaType } : {}),
      icon: {
        lucide: row.kind === "artifact" || row.kind === "canvas" ? ROW_ICONS[row.kind] : FileIcon,
      },
      score: match.score,
      timestamp: row.timestamp,
      action: { type: "navigate", href: filesHref(row.key) },
    }),
  })
}

export const filesArtifactsProvider = createFilesArtifactsProvider()
export const filesCanvasProvider = createFilesCanvasProvider()
export const filesItemsProvider = createFilesItemsProvider()
