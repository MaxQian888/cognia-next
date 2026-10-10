"use client"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { listLibraryFolders } from "@/lib/db/files-library-folders"
import type { LibraryFolder } from "@/lib/db/files-library-types"

const EMPTY: LibraryFolder[] = []

/**
 * Every Files folder, live. Empty until the first read resolves, and while
 * `enabled` is false (the page draws another device's library).
 */
export function useFilesFolders({ enabled = true }: { enabled?: boolean } = {}): LibraryFolder[] {
  return (
    useClientLiveQuery(() => (enabled ? listLibraryFolders() : EMPTY), [enabled], EMPTY) ?? EMPTY
  )
}
