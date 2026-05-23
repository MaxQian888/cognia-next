"use client"

/**
 * Tiny global store for the terminal's file-viewer (1D).
 *
 * Clicking a `path:line:col` link inside a terminal pane resolves the
 * path against the session cwd and calls `openFile(...)`. The
 * `<FileViewerDialog>` (mounted by the dock) reads this store, loads the
 * file via `lib/file/file-operations`, and reveals the target line in a
 * read-only Monaco editor.
 *
 * Decoupled via a store (rather than prop drilling) because the link
 * originates deep inside `terminal-instance` → pane group, while the
 * dialog lives at the dock root.
 */

import { create } from "zustand"

export interface FileViewerState {
  open: boolean
  path: string | null
  line: number | null
  column: number | null
  openFile: (path: string, line?: number | null, column?: number | null) => void
  close: () => void
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  open: false,
  path: null,
  line: null,
  column: null,
  openFile: (path, line = null, column = null) => set({ open: true, path, line, column }),
  close: () => set({ open: false }),
}))

export default useFileViewerStore
