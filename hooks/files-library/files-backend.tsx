"use client"

/**
 * Which library the Files page manages, and how (ADR-0223).
 *
 * `FilesLibrary` mounts one backend for the page: this device's own database
 * (`useLocalFilesBackend`) or, on a paired device, the host's library over
 * `files_library_*` (`useRemoteFilesBackend`, §9). Everything below reads it
 * from here — the page model, its actions, the folder dialogs, thumbnails and
 * the preview — so neither layout knows which one it is drawing.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react"

import type { MissingMediaLoader } from "@/lib/chat/media/resolve-media"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { createLocalFilesOps, type FilesOps } from "@/lib/files-library/ops"
import type { FilesEntry } from "@/lib/files-library/types"

import { useFilesEntries } from "./use-files-entries"
import { useFilesFolders } from "./use-files-folders"

/** The library's contents as the page reads them. */
export interface FilesSource {
  /** Undefined until the first read resolves. */
  entries: FilesEntry[] | undefined
  imagesTruncated: boolean
  loadMoreImages: () => void
  folders: LibraryFolder[]
  /**
   * Items the search matched inside their content, beyond what the entries'
   * own haystack holds — a paired device's titles-only entries, answered by
   * the host. Absent where the entries carry their bodies.
   */
  contentMatches?: ReadonlySet<string>
  /** Read the library again (pull to refresh, Retry). Absent where it is live. */
  refresh?: () => Promise<void>
  /** The last read failed; the page offers Retry. */
  error?: string
}

export interface FilesBackend {
  source: FilesSource
  ops: FilesOps
  /**
   * Where an entry's missing image bytes come from. Absent for this device's
   * own library, where every byte is already in the media store.
   */
  mediaLoaderFor?: (entry: FilesEntry) => MissingMediaLoader | undefined
}

const FilesBackendContext = createContext<FilesBackend | null>(null)

export function FilesBackendProvider({
  backend,
  children,
}: {
  backend: FilesBackend
  children: ReactNode
}) {
  return <FilesBackendContext.Provider value={backend}>{children}</FilesBackendContext.Provider>
}

const LOCAL_OPS = createLocalFilesOps()

/**
 * The page's backend. Outside a provider — a component rendered on its own,
 * or a test — it is this device's library, the page's long-standing default.
 */
export function useFilesOps(): FilesOps {
  return useContext(FilesBackendContext)?.ops ?? LOCAL_OPS
}

export function useFilesBackendContext(): FilesBackend | null {
  return useContext(FilesBackendContext)
}

/** The loader for one entry's image bytes, when they live on another device. */
export function useFilesMediaLoader(entry: FilesEntry | undefined): MissingMediaLoader | undefined {
  const loaderFor = useContext(FilesBackendContext)?.mediaLoaderFor
  // A re-read list hands over new entry objects, and so a new loader; the
  // media cache answers the re-acquire from memory, so nothing is fetched again.
  return useMemo(() => (entry && loaderFor ? loaderFor(entry) : undefined), [loaderFor, entry])
}

/**
 * This device's own library: live Dexie reads and the local writers.
 * `enabled: false` keeps the hook mounted without reading anything, for a
 * page whose provider already supplies the library.
 */
export function useLocalFilesBackend({ enabled = true }: { enabled?: boolean } = {}): FilesBackend {
  const { entries, imagesTruncated, loadMoreImages } = useFilesEntries({ enabled })
  const folders = useFilesFolders({ enabled })
  return useMemo(
    () => ({
      source: { entries, imagesTruncated, loadMoreImages, folders },
      ops: LOCAL_OPS,
    }),
    [entries, imagesTruncated, loadMoreImages, folders]
  )
}
