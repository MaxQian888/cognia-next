/**
 * Files (ADR-0200): artifacts, canvas documents, and uploaded files / named
 * images, found by name from ⌘K. Selecting one opens its preview on `/files`;
 * artifacts and canvas documents can also be referenced into the composer.
 *
 * Identity only — titles, types and workspaces. Bodies are searched on the
 * Files page itself, where the aggregate is already loaded; a provider runs on
 * every keystroke and must not read every artifact's content per needle.
 *
 * Empty on the phone shell: Files is not built there yet
 * (`filesRequiresDesktopOrWeb`), so the palette must not offer a way in.
 */

import { FileIcon, PenLineIcon, ShapesIcon } from "lucide-react"

import type { Artifact, CanvasDocument } from "@/types/artifact/artifact"
import { listLibraryItems } from "@/lib/db/files-library-items"
import { isLibraryItemKept, libraryItemKey } from "@/lib/db/files-library-types"
import { listAllSessionAssets, listLibraryAssets } from "@/lib/db/session-assets"
import { isImageMediaType } from "@/lib/files-library/aggregate"
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
  return `/files?tab=all&item=${encodeURIComponent(key)}`
}

export interface FilesProviderDeps {
  artifacts: () => Promise<Record<string, Artifact>>
  canvasDocuments: () => Promise<Record<string, CanvasDocument>>
  loadItems: (ctx: GlobalSearchContext) => Promise<FileSearchRow[]>
}

async function artifactState() {
  const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
  return useArtifactStore.getState()
}

/** An upload or a named image, as the palette lists it. */
export interface FileSearchRow {
  key: string
  title: string
  mediaType?: string
  projectId?: string
  timestamp: number
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
      continue
    }
    if (item.kind !== "image" || !item.snapshot?.title) continue
    if (!item.ownedByFiles && !isLibraryItemKept(item)) continue
    rows.set(item.key, {
      key: item.key,
      title: item.snapshot.title,
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
  loadItems: (ctx) => loadFileSearchRows(ctx.sessions),
}

const offPhone = (ctx: GlobalSearchContext) => ctx.platform !== "mobile"

export function createFilesArtifactsProvider(
  deps: Pick<FilesProviderDeps, "artifacts"> = defaultDeps
) {
  return createListProvider<Artifact>({
    id: FILES_ARTIFACTS_PROVIDER_ID,
    kind: "artifact",
    load: async (ctx) => (offPhone(ctx) ? Object.values(await deps.artifacts()) : []),
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
  deps: Pick<FilesProviderDeps, "canvasDocuments"> = defaultDeps
) {
  return createListProvider<CanvasDocument>({
    id: FILES_CANVAS_PROVIDER_ID,
    kind: "canvas-document",
    load: async (ctx) => (offPhone(ctx) ? Object.values(await deps.canvasDocuments()) : []),
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

export function createFilesItemsProvider(deps: Pick<FilesProviderDeps, "loadItems"> = defaultDeps) {
  return createListProvider<FileSearchRow>({
    id: FILES_ITEMS_PROVIDER_ID,
    kind: "library-file",
    load: async (ctx) => (offPhone(ctx) ? deps.loadItems(ctx) : []),
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
      icon: { lucide: FileIcon },
      score: match.score,
      timestamp: row.timestamp,
      action: { type: "navigate", href: filesHref(row.key) },
    }),
  })
}

export const filesArtifactsProvider = createFilesArtifactsProvider()
export const filesCanvasProvider = createFilesCanvasProvider()
export const filesItemsProvider = createFilesItemsProvider()
