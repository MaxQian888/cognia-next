"use client"

/**
 * The open state of the read-only file viewer dialog.
 *
 * Lives in a store rather than in props because the links that drive it start
 * deep inside a terminal pane or a chat message, while the dialog is mounted
 * once at the app shell.
 *
 * It moved out of `stores/terminal/` because that location had become a lie:
 * chat file links have used it for as long as terminal links have. The old
 * `openFile(absolutePath, line, column)` is deliberately gone rather than
 * deprecated — that signature *was* the unconfined API, and deleting it is what
 * makes the workspace confinement unbypassable instead of merely encouraged.
 * Callers now resolve a path to a `{ root, relPath }` pair first, and say so
 * explicitly when they cannot.
 */

import { create } from "zustand"
import type { FileViewerErrorCode, FileViewerRequest } from "@/lib/file-viewer/types"

/** A refusal that happens before there is anything to read. */
export interface FileViewerFailure {
  code: FileViewerErrorCode
  /** Shown in the dialog chrome so the user knows which file was refused. */
  displayName: string
}

export interface FileViewerState {
  open: boolean
  request: FileViewerRequest | null
  failure: FileViewerFailure | null
  /** Open on a resolved, confined request. */
  openRequest: (request: FileViewerRequest) => void
  /**
   * Open on a refusal — a path outside every workspace root, say.
   *
   * Deliberately still *opens*: a click that silently does nothing is
   * indistinguishable from a broken link, and this dialog spent its whole life
   * as a no-op whenever the terminal panel happened to be closed.
   */
  openFailure: (code: FileViewerErrorCode, displayName: string) => void
  close: () => void
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  open: false,
  request: null,
  failure: null,
  openRequest: (request) => set({ open: true, request, failure: null }),
  openFailure: (code, displayName) =>
    set({ open: true, request: null, failure: { code, displayName } }),
  // Leaves the payload in place: the dialog animates out, and clearing it here
  // would blank the content mid-transition.
  close: () => set({ open: false }),
}))

export default useFileViewerStore
