"use client"

/**
 * Live Files entries (ADR-0200): the artifact store snapshot plus a live Dexie
 * query over images, uploads and Files metadata, merged by the pure
 * aggregate. Any write to those tables re-runs the query, so favoriting,
 * uploading or deleting a conversation updates the grid without a refresh.
 */

import { useCallback, useMemo, useState } from "react"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { aggregateFilesEntries } from "@/lib/files-library/aggregate"
import { FILES_IMAGE_PAGE_SIZE, loadFilesSources } from "@/lib/files-library/sources"
import type { FilesEntry } from "@/lib/files-library/types"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

export interface UseFilesEntriesResult {
  /** Undefined until the first load resolves. */
  entries: FilesEntry[] | undefined
  /** More images exist than are loaded. */
  imagesTruncated: boolean
  loadMoreImages: () => void
}

export function useFilesEntries(): UseFilesEntriesResult {
  const artifacts = useArtifactStore((s) => s.artifacts)
  const canvasDocuments = useArtifactStore((s) => s.canvasDocuments)
  const [imageLimit, setImageLimit] = useState(FILES_IMAGE_PAGE_SIZE)
  const loaded = useClientLiveQuery(
    () => loadFilesSources({ artifacts, canvasDocuments, imageLimit }),
    [artifacts, canvasDocuments, imageLimit],
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
