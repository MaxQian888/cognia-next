"use client"

/**
 * Runtime-only state of the dock's Conversation files panel (ADR-0222 §2).
 *
 * The panel lists a conversation's mounts and the rows of its Dexie mounts.
 * A link or tool card that names one of those rows (an upload, a mount root)
 * cannot open an editor for it, so it asks the panel to scroll to and
 * highlight the row instead. The request carries its conversation: the panel
 * ignores one aimed at a conversation it is not showing, which is the same
 * rule `clearSessionScopedReveals` enforces for the workspace reveal.
 *
 * Not persisted: a focus request is a click's consequence, not a preference.
 */

import { create } from "zustand"

import type { FileSpacePath } from "@/types/filespace"

/** The dock panel id. Declared here so the panel catalogue imports no React tree. */
export const CONVERSATION_FILES_PANEL_ID = "conversation-files"

export interface FileSpaceFocusRequest {
  /** Distinguishes two requests for the same path. */
  seq: number
  sessionId: string
  path: FileSpacePath
}

export interface FileSpacePanelState {
  focus: FileSpaceFocusRequest | null
  requestFocus: (sessionId: string, path: FileSpacePath) => void
  /** Clear `seq` once the panel has applied it; a newer request is left alone. */
  consumeFocus: (seq: number) => void
}

let nextSeq = 1

export const useFileSpacePanelStore = create<FileSpacePanelState>((set) => ({
  focus: null,
  requestFocus: (sessionId, path) => set({ focus: { seq: nextSeq++, sessionId, path } }),
  consumeFocus: (seq) => set((state) => (state.focus?.seq === seq ? { focus: null } : state)),
}))
