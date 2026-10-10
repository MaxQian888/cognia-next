"use client"

/**
 * The host's Files library, for a paired device (ADR-0223 §9).
 *
 * Nothing about the library is mirrored to the device, so the page reads it
 * from the host: the whole list (paged, `files_library_list`) and the
 * folders, again whenever the page might be stale —
 *
 *  - after every change the device makes (the ops call `onChanged`);
 *  - when the page becomes visible or the window regains focus;
 *  - every {@link FILES_REMOTE_REFRESH_MS} while it stays visible, for changes
 *    made on the desktop;
 *  - on pull to refresh, and on Retry after a failed read.
 *
 * A read that loses a race to a newer one is dropped, so a slow answer can
 * never overwrite a fresher list. The search box also asks the host which
 * items match inside their content (`files_library_search`), because the
 * entries here carry only titles.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import { FILES_IMAGE_PAGE_SIZE } from "@/lib/files-library/sources"
import { FilesRemoteError, type FilesRemoteClient } from "@/lib/files-library/remote/client"
import { liveFilesRemoteClient } from "@/lib/files-library/remote/live-transport"
import { createRemoteMediaLoader } from "@/lib/files-library/remote/media-loader"
import { createRemoteFilesOps } from "@/lib/files-library/remote/remote-ops"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

import type { FilesBackend } from "./files-backend"

/** How often a visible page re-reads the host's library. */
export const FILES_REMOTE_REFRESH_MS = 30_000

/** How long the search box rests before the host is asked about bodies. */
export const FILES_REMOTE_SEARCH_DEBOUNCE_MS = 250

const NO_FOLDERS: LibraryFolder[] = []

interface ListState {
  entries?: FilesEntry[]
  imagesTruncated: boolean
  folders: LibraryFolder[]
  error?: string
}

function codeOf(error: unknown): string {
  if (error instanceof FilesRemoteError) return error.code
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && code ? code : "files_remote_unreachable"
}

export function useRemoteFilesBackend(
  options: { client?: FilesRemoteClient; refreshMs?: number } = {}
): FilesBackend {
  const injected = options.client
  const refreshMs = options.refreshMs ?? FILES_REMOTE_REFRESH_MS
  const client = useMemo(() => injected ?? liveFilesRemoteClient(), [injected])
  const [imageLimit, setImageLimit] = useState(FILES_IMAGE_PAGE_SIZE)
  const imageLimitRef = useRef(imageLimit)
  const [state, setState] = useState<ListState>({ imagesTruncated: false, folders: NO_FOLDERS })
  const generation = useRef(0)

  useEffect(() => {
    imageLimitRef.current = imageLimit
  }, [imageLimit])

  const refresh = useCallback(async () => {
    const run = ++generation.current
    try {
      const [library, folders] = await Promise.all([
        client.list(imageLimitRef.current),
        client.folders(),
      ])
      if (run !== generation.current) return
      setState({ entries: library.entries, imagesTruncated: library.imagesTruncated, folders })
    } catch (error) {
      if (run !== generation.current) return
      // Keep what was shown: a failed refresh is a notice, not an empty page.
      setState((previous) => ({ ...previous, error: codeOf(error) }))
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh, imageLimit])

  useEffect(() => {
    if (typeof document === "undefined") return
    const visible = () => document.visibilityState === "visible"
    const onVisible = () => {
      if (visible()) void refresh()
    }
    window.addEventListener("focus", onVisible)
    document.addEventListener("visibilitychange", onVisible)
    const timer = setInterval(onVisible, refreshMs)
    return () => {
      window.removeEventListener("focus", onVisible)
      document.removeEventListener("visibilitychange", onVisible)
      clearInterval(timer)
    }
  }, [refresh, refreshMs])

  // Content matches for the current search, from the host.
  const search = useFilesLibraryStore((s) => s.search)
  const [matches, setMatches] = useState<{ for: string; keys: ReadonlySet<string> } | null>(null)
  useEffect(() => {
    const query = search.trim()
    if (!query) return
    let cancelled = false
    const timer = setTimeout(() => {
      void client
        .search(query, imageLimitRef.current, 200)
        .then((hits) => {
          if (!cancelled) setMatches({ for: search, keys: new Set(hits.map((hit) => hit.key)) })
        })
        .catch(() => {
          // Titles still match locally; a failed body search narrows nothing.
          if (!cancelled) setMatches({ for: search, keys: new Set() })
        })
    }, FILES_REMOTE_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, search])

  const loadMoreImages = useCallback(
    () => setImageLimit((limit) => limit + FILES_IMAGE_PAGE_SIZE),
    []
  )
  const ops = useMemo(
    () =>
      createRemoteFilesOps({
        client,
        imageLimit: () => imageLimitRef.current,
        onChanged: () => void refresh(),
      }),
    [client, refresh]
  )
  const mediaLoaderFor = useCallback(
    (entry: FilesEntry) => createRemoteMediaLoader(client, entry),
    [client]
  )
  const contentMatches = matches && matches.for === search ? matches.keys : undefined

  return useMemo(
    () => ({
      source: {
        entries: state.entries,
        imagesTruncated: state.imagesTruncated,
        loadMoreImages,
        folders: state.folders,
        refresh,
        ...(contentMatches ? { contentMatches } : {}),
        ...(state.error ? { error: state.error } : {}),
      },
      ops,
      mediaLoaderFor,
    }),
    [state, loadMoreImages, refresh, contentMatches, ops, mediaLoaderFor]
  )
}
