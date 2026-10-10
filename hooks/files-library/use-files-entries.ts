"use client"

/**
 * Live Files entries (ADR-0200): the artifact store snapshot plus a live Dexie
 * query over images, uploads and Files metadata, merged by the pure
 * aggregate. Any write to those tables re-runs the query, so favoriting,
 * uploading or deleting a conversation updates the grid without a refresh.
 * On the desktop the task-workspace ledger's resource index joins them
 * (workspace files, ADR-0223 §8), read by `useWorkspaceFileIndex`.
 */

import { useCallback, useMemo, useState } from "react"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { aggregateFilesEntries } from "@/lib/files-library/aggregate"
import { FILES_IMAGE_PAGE_SIZE, loadFilesSources } from "@/lib/files-library/sources"
import type { FilesEntry } from "@/lib/files-library/types"
import { hasLocalWorkspaceFiles } from "@/lib/files-library/workspace-files-io"
import { useWorkspaceFileIndex } from "./use-workspace-file-index"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

export interface UseFilesEntriesResult {
  /** Undefined until the first load resolves. */
  entries: FilesEntry[] | undefined
  /** More images exist than are loaded. */
  imagesTruncated: boolean
  loadMoreImages: () => void
}

/**
 * `enabled: false` reads nothing — the page is drawing another device's
 * library (ADR-0223 §9) and this one's would only be discarded.
 */
export function useFilesEntries({
  enabled = true,
}: { enabled?: boolean } = {}): UseFilesEntriesResult {
  const artifacts = useArtifactStore((s) => s.artifacts)
  const canvasDocuments = useArtifactStore((s) => s.canvasDocuments)
  const [imageLimit, setImageLimit] = useState(FILES_IMAGE_PAGE_SIZE)
  const workspace = useWorkspaceFileIndex(enabled && hasLocalWorkspaceFiles())
  const loaded = useClientLiveQuery(
    () =>
      enabled
        ? loadFilesSources({
            artifacts,
            canvasDocuments,
            imageLimit,
            ...(workspace ? { workspace } : {}),
          })
        : undefined,
    [enabled, artifacts, canvasDocuments, imageLimit, workspace],
    undefined
  )
  const entries = useMemo(
    () => (loaded ? aggregateFilesEntries(loaded.input) : undefined),
    [loaded]
  )
  const loadMoreImages = useCallback(
    () => setImageLimit((limit) => limit + FILES_IMAGE_PAGE_SIZE),
    []
  )
  return { entries, imagesTruncated: loaded?.imagesTruncated ?? false, loadMoreImages }
}
