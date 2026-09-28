"use client"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { listLibraryFolders } from "@/lib/db/files-library-folders"
import type { LibraryFolder } from "@/lib/db/files-library-types"

const EMPTY: LibraryFolder[] = []

/** Every Files folder, live. Empty until the first read resolves. */
export function useFilesFolders(): LibraryFolder[] {
  return useClientLiveQuery(() => listLibraryFolders(), [], EMPTY) ?? EMPTY
}
